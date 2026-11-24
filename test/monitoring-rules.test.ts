import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeBurnRate,
  createInitialProviderSnapshot,
  DEFAULT_CLAUDE_QUOTA_STALE_MS,
  type ProviderObservatorySnapshot,
} from '../src/observatory/metrics.js';
import type { InferenceRecord } from '../src/core/model.js';
import {
  evaluateAgenticIntensity,
  evaluateConsumptionAcceleration,
  evaluateContextGrowth,
  evaluateContextPressure,
  evaluateQuotaPressure,
  evaluateRepeatedContextProcessing,
  type PreventiveAlert,
} from '../src/monitoring/rules.js';

function makeSnap(
  provider: 'codex' | 'claude',
  nowMs: number,
  mutate: (s: ProviderObservatorySnapshot) => void
): ProviderObservatorySnapshot {
  const s = createInitialProviderSnapshot(provider, nowMs);
  s.identity.sessionId = `${provider}:s1`;
  s.identity.status = provider === 'claude' ? 'active' : 'recent';
  s.coverage.level = 'partial';
  mutate(s);
  return s;
}

test('Context Pressure: exact thresholds, W->C escalation, C->W de-escalation, hysteresis resolution, and not_evaluable on invalid/missing window', () => {
  const t0 = 1_000_000;
  // Claude without context window -> always not_evaluable.
  const claudeSnap = makeSnap('claude', t0, (s) => {
    s.context.currentContextTokens = 180_000;
    s.context.isCurrentContextFromLatestInference = true;
  });
  const claudeRes = evaluateContextPressure(claudeSnap, undefined, t0);
  assert.equal(claudeRes.state, 'not_evaluable');
  assert.equal(claudeRes.coverage.reason, 'context_window_unavailable');

  const codexAt = (occPct: number, ts: number, fromLatest = true) =>
    makeSnap('codex', ts, (s) => {
      s.context.contextWindowTokens = 100_000;
      s.context.currentContextTokens = occPct * 1_000;
      s.context.contextOccupancyPercent = occPct;
      s.context.currentContextTimestampMs = ts;
      s.context.isCurrentContextFromLatestInference = fromLatest;
    });

  // Below warning (79.9%) -> resolved (never active).
  const a0 = evaluateContextPressure(codexAt(79.9, t0), undefined, t0);
  assert.equal(a0.state, 'resolved');

  // Exact warning threshold (80%) -> active warning.
  const a1 = evaluateContextPressure(codexAt(80, t0 + 1000), a0, t0 + 1000);
  assert.equal(a1.state, 'active');
  assert.equal(a1.severity, 'warning');
  assert.equal(a1.activatedAtMs, t0 + 1000);

  // Hysteresis band (76%) -> stays active warning, preserves activatedAtMs.
  const a2 = evaluateContextPressure(codexAt(76, t0 + 2000), a1, t0 + 2000);
  assert.equal(a2.state, 'active');
  assert.equal(a2.severity, 'warning');
  assert.equal(a2.activatedAtMs, t0 + 1000);

  // Escalation at exact critical threshold (90%) -> critical, preserves activatedAtMs.
  const a3 = evaluateContextPressure(codexAt(90, t0 + 3000), a2, t0 + 3000);
  assert.equal(a3.state, 'active');
  assert.equal(a3.severity, 'critical');
  assert.equal(a3.activatedAtMs, t0 + 1000);

  // Critical hysteresis band (85% exact) -> stays critical.
  const a4 = evaluateContextPressure(codexAt(85, t0 + 4000), a3, t0 + 4000);
  assert.equal(a4.state, 'active');
  assert.equal(a4.severity, 'critical');

  // De-escalation Critical -> Warning (84.9%).
  const a5 = evaluateContextPressure(codexAt(84.9, t0 + 5000), a4, t0 + 5000);
  assert.equal(a5.state, 'active');
  assert.equal(a5.severity, 'warning');

  // Losing latest valid context -> not_evaluable (NEVER resolved!).
  const a6 = evaluateContextPressure(codexAt(84.9, t0 + 6000, false), a5, t0 + 6000);
  assert.equal(a6.state, 'not_evaluable');
  assert.equal(a6.resolvedAtMs, undefined);

  // Below resolve threshold (< 75%) -> resolved with resolvedAtMs.
  const a7 = evaluateContextPressure(codexAt(74.9, t0 + 7000), a5, t0 + 7000);
  assert.equal(a7.state, 'resolved');
  assert.equal(a7.resolvedAtMs, t0 + 7000);

  // Direct Critical -> Resolved drop (92% -> 40%) resolves cleanly without lingering in Warning.
  const aCrit = evaluateContextPressure(codexAt(92, t0 + 8000), a7, t0 + 8000);
  assert.equal(aCrit.severity, 'critical');
  const aDrop = evaluateContextPressure(codexAt(40, t0 + 9000), aCrit, t0 + 9000);
  assert.equal(aDrop.state, 'resolved');
  assert.equal(aDrop.resolvedAtMs, t0 + 9000);

  // Recovery from `not_evaluable`: valid value >= warn reactivates cleanly with fresh activatedAtMs.
  const aRec = evaluateContextPressure(codexAt(82, t0 + 10_000), a6, t0 + 10_000);
  assert.equal(aRec.state, 'active');
  assert.equal(aRec.severity, 'warning');
  assert.equal(aRec.activatedAtMs, t0 + 10_000);
});

test('Context Growth: deterministic trailing suffix (no cherry-picking), compaction/model/server-side discontinuities, and hysteresis', () => {
  const t0 = 2_000_000;
  const pts = (vals: Array<number | undefined>, model = 'gpt-5.4') =>
    vals.map((v, i) => ({
      inferenceId: `inf-${i}`,
      timestampMs: t0 + i * 1000,
      ...(v !== undefined ? { totalInputTokens: v } : {}),
      model,
    }));

  // Small base (2k -> 10k = +400% rel, but only +8k abs) -> resolved (not active).
  const small = makeSnap('codex', t0, (s) => { s.context.series = pts([2_000, 6_000, 10_000]); });
  assert.equal(evaluateContextGrowth(small, undefined, t0).state, 'resolved');

  // No cherry-picking: full 5-point suffix is 100k -> 120k (+20k / +20%), even though sub-window [1..4] jumped 50k -> 120k!
  const noCherry = makeSnap('codex', t0, (s) => {
    s.context.series = pts([100_000, 50_000, 80_000, 100_000, 120_000]);
  });
  const ncRes = evaluateContextGrowth(noCherry, undefined, t0);
  assert.equal(ncRes.state, 'resolved');
  assert.equal(ncRes.evidence.comparableInferences, 5);
  assert.equal(ncRes.evidence.deltaAbsTokens, 20_000);

  // Exact warning threshold (+40k & +40%: 100k -> 140k across 3 points).
  const warnSnap = makeSnap('codex', t0 + 1000, (s) => { s.context.series = pts([100_000, 120_000, 140_000]); });
  const w = evaluateContextGrowth(warnSnap, undefined, t0 + 1000);
  assert.equal(w.state, 'active');
  assert.equal(w.severity, 'warning');

  // Exact critical threshold (+80k & +80%: 100k -> 180k across 4 points).
  const critSnap = makeSnap('codex', t0 + 2000, (s) => { s.context.series = pts([100_000, 130_000, 155_000, 180_000]); });
  const c = evaluateContextGrowth(critSnap, w, t0 + 2000);
  assert.equal(c.state, 'active');
  assert.equal(c.severity, 'critical');

  // De-escalation Critical -> Warning (100k -> 150k = +50k / +50%, below 65k/60% deescalate, above 40k/40% warn).
  const deescSnap = makeSnap('codex', t0 + 3000, (s) => { s.context.series = pts([100_000, 125_000, 150_000]); });
  const d = evaluateContextGrowth(deescSnap, c, t0 + 3000);
  assert.equal(d.state, 'active');
  assert.equal(d.severity, 'warning');

  // Compaction breaks comparability -> fewer than 3 post-compaction points -> not_evaluable!
  const compSnap = makeSnap('codex', t0 + 4000, (s) => {
    s.context.series = pts([100_000, 150_000, 200_000, 50_000, 110_000]);
    s.context.compactions = [{ eventId: 'c1', timestampMs: t0 + 2500, afterInferenceIndex: 2 }];
  });
  const compRes = evaluateContextGrowth(compSnap, d, t0 + 4000);
  assert.equal(compRes.state, 'not_evaluable');
  assert.equal(compRes.coverage.reason, 'compaction_boundary');

  // Model change breaks comparability -> not_evaluable.
  const modelSnap = makeSnap('codex', t0 + 5000, (s) => {
    s.context.series = [
      { inferenceId: 'i0', timestampMs: t0, totalInputTokens: 100_000, model: 'gpt-5.4-mini' },
      { inferenceId: 'i1', timestampMs: t0 + 1000, totalInputTokens: 150_000, model: 'gpt-5.4' },
      { inferenceId: 'i2', timestampMs: t0 + 2000, totalInputTokens: 200_000, model: 'gpt-5.4' },
    ];
  });
  assert.equal(evaluateContextGrowth(modelSnap, undefined, t0 + 5000).coverage.reason, 'model_change');

  // Server-side aggregated latest point -> not_evaluable.
  const aggSnap = makeSnap('claude', t0 + 6000, (s) => {
    s.context.series = [
      { inferenceId: 'i0', timestampMs: t0, totalInputTokens: 100_000, model: 'claude-opus-4-6' },
      { inferenceId: 'i1', timestampMs: t0 + 1000, totalInputTokens: 150_000, model: 'claude-opus-4-6' },
      { inferenceId: 'i2', timestampMs: t0 + 2000, model: 'claude-opus-4-6', isAggregatedServerSide: true },
    ];
  });
  assert.equal(evaluateContextGrowth(aggSnap, undefined, t0 + 6000).state, 'not_evaluable');
});

test('Repeated Context Processing: enforces scope coherence on context multiple when subagents exist vs zero subagents', () => {
  const t0 = 3_000_000;
  // Zero subagents + coherent primary context (250k): 2M cache-read = 8x (< 10x required!) -> resolved!
  const lowMult = makeSnap('codex', t0, (s) => {
    s.burnRate.windowCoverage = 'full';
    s.burnRate.inferencesInWindow = 10;
    s.burnRate.cacheReadTokensPerMin = 400_000; // 2.0M / 5m
    s.burnRate.inputTokensPerMin = 500_000;     // 2.5M / 5m (80% share)
    s.context.currentContextTokens = 250_000;   // 2M / 250k = 8x < 10x
    s.context.isCurrentContextFromLatestInference = true;
  });
  const r1 = evaluateRepeatedContextProcessing(lowMult, undefined, t0);
  assert.equal(r1.state, 'resolved');
  assert.equal(r1.evidence.contextMultipleAvailable, true);
  assert.equal(r1.evidence.contextMultiple, 8);

  // Zero subagents + coherent primary context (200k): 2M / 200k = 10x exact -> active warning!
  const exactWarn = makeSnap('codex', t0 + 1000, (s) => {
    s.burnRate.windowCoverage = 'full';
    s.burnRate.inferencesInWindow = 10;
    s.burnRate.cacheReadTokensPerMin = 400_000; // 2.0M
    s.burnRate.inputTokensPerMin = 500_000;     // 80% share
    s.context.currentContextTokens = 200_000;   // 10x exact
    s.context.isCurrentContextFromLatestInference = true;
  });
  const r2 = evaluateRepeatedContextProcessing(exactWarn, r1, t0 + 1000);
  assert.equal(r2.state, 'active');
  assert.equal(r2.severity, 'warning');
  assert.equal(r2.evidence.contextMultiple, 10);

  // Subagents present -> MUST NOT divide session_total burn rate by primary-only context!
  // Uses conditional semantics (2M + 80% share -> active warning, contextMultipleAvailable: false).
  const withSub = makeSnap('claude', t0 + 2000, (s) => {
    s.usage.subagents.inferenceCount = 4;
    s.burnRate.windowCoverage = 'full';
    s.burnRate.inferencesInWindow = 12;
    s.burnRate.cacheReadTokensPerMin = 400_000; // 2.0M
    s.burnRate.inputTokensPerMin = 500_000;     // 80% share
    s.context.currentContextTokens = 500_000;   // would be 4x if wrongly divided!
    s.context.isCurrentContextFromLatestInference = true;
  });
  const r3 = evaluateRepeatedContextProcessing(withSub, undefined, t0 + 2000);
  assert.equal(r3.state, 'active');
  assert.equal(r3.severity, 'warning');
  assert.equal(r3.evidence.contextMultipleAvailable, false);
  assert.equal(r3.evidence.contextMultipleUnavailableReason, 'subagents_present_scope_mismatch');

  // Decay to 0 during observed inactivity -> resolved!
  const idle = makeSnap('codex', t0 + 300_000, (s) => {
    s.burnRate.windowCoverage = 'full';
    s.burnRate.inferencesInWindow = 0;
    s.burnRate.cacheReadTokensPerMin = 0;
    s.burnRate.inputTokensPerMin = 0;
  });
  const r4 = evaluateRepeatedContextProcessing(idle, r2, t0 + 300_000);
  assert.equal(r4.state, 'resolved');
});

test('Agentic Intensity: exact thresholds, turnPhase distinction, and immediate re-evaluation on turn change even with 0 inferences', () => {
  const t0 = 4_000_000;
  const turnSnap = (turnId: string, count: number, status?: 'started' | 'completed' | 'aborted') =>
    makeSnap('codex', t0, (s) => {
      s.agentic.userTurnCount = 2;
      s.agentic.latestTurnId = turnId;
      if (status) s.agentic.latestTurnStatus = status;
      s.agentic.inferencesInLatestTurn = count;
      s.agentic.subagentCount = 3;
    });

  // Exact warning (30) on current turn.
  const w = evaluateAgenticIntensity(turnSnap('t1', 30, 'started'), undefined, t0);
  assert.equal(w.state, 'active');
  assert.equal(w.severity, 'warning');
  assert.equal(w.turnId, 't1');
  assert.equal(w.evidence.turnPhase, 'current');
  assert.equal(w.evidence.primarySessionOnly, true);

  // Exact critical (60) on completed turn -> clearly labeled 'completed'.
  const c = evaluateAgenticIntensity(turnSnap('t1', 60, 'completed'), w, t0 + 1000);
  assert.equal(c.state, 'active');
  assert.equal(c.severity, 'critical');
  assert.equal(c.evidence.turnPhase, 'completed');

  // New turn `t2` starts with 0 inferences -> previous `t1` critical alert MUST NOT bleed onto `t2`, immediately resolves!
  const t2Zero = evaluateAgenticIntensity(turnSnap('t2', 0, 'started'), c, t0 + 2000);
  assert.equal(t2Zero.state, 'resolved');
  assert.equal(t2Zero.turnId, 't2');
  assert.equal(t2Zero.resolvedAtMs, t0 + 2000);

  // New turn `t2` at 27 inferences (inside hysteresis band of old `t1`!) -> MUST stay resolved because `t2` never crossed 30!
  const t2Below = evaluateAgenticIntensity(turnSnap('t2', 27, 'started'), c, t0 + 3000);
  assert.equal(t2Below.state, 'resolved');
});

test('Consumption Acceleration: guards against post-inactivity resumption & zero denominator, escalates/de-escalates, and resolves on inactivity decay', () => {
  const t0 = 5_000_000;
  const accelSnap = (
    curInfs: number,
    curRate: number,
    prevInfs: number,
    prevRate: number,
    prevCov: 'full' | 'partial' | 'unavailable' = 'full'
  ) =>
    makeSnap('codex', t0, (s) => {
      s.burnRate.windowCoverage = 'full';
      s.burnRate.inferencesInWindow = curInfs;
      s.burnRate.inputTokensPerMin = curRate;
      s.burnRate.previousWindow = {
        windowCoverage: prevCov,
        inferencesInWindow: prevInfs,
        inputTokensPerMin: prevRate,
      };
    });

  // Resumption after inactivity (prevInfs = 0, prevRate = 0) -> MUST be not_evaluable (no division by zero, no false anomaly!).
  const resume = evaluateConsumptionAcceleration(accelSnap(10, 500_000, 0, 0), undefined, t0);
  assert.equal(resume.state, 'not_evaluable');
  assert.equal(resume.coverage.reason, 'insufficient_baseline_activity');

  // Exact warning (prev 100k/min -> cur 250k/min = 2.5x, delta +150k >= 100k, curInfs=3, prevInfs=2).
  const w = evaluateConsumptionAcceleration(accelSnap(3, 250_000, 2, 100_000), undefined, t0 + 1000);
  assert.equal(w.state, 'active');
  assert.equal(w.severity, 'warning');

  // Exact critical (prev 100k/min -> cur 400k/min = 4.0x, delta +300k >= 250k).
  const c = evaluateConsumptionAcceleration(accelSnap(5, 400_000, 3, 100_000), w, t0 + 2000);
  assert.equal(c.state, 'active');
  assert.equal(c.severity, 'critical');

  // De-escalation Critical -> Warning (prev 100k -> cur 280k = 2.8x < 3.2x).
  const d = evaluateConsumptionAcceleration(accelSnap(4, 280_000, 3, 100_000), c, t0 + 3000);
  assert.equal(d.state, 'active');
  assert.equal(d.severity, 'warning');

  // Observed decay to 0 while baseline window still active -> cleanly resolved!
  const res = evaluateConsumptionAcceleration(accelSnap(0, 0, 3, 100_000), d, t0 + 4000);
  assert.equal(res.state, 'resolved');
  assert.equal(res.resolvedAtMs, t0 + 4000);
});

test('Quota Pressure: separates windows/categories, exact 80%/95% thresholds & hysteresis, and marks stale/expired as not_evaluable (never resolved)', () => {
  const t0 = 6_000_000;
  const codexQuotaSnap = (primaryPct: number, primaryAgeMs: number, secondaryPct: number, primaryResetPassed = false) =>
    makeSnap('codex', t0, (s) => {
      s.subscription = {
        provider: 'codex',
        scope: 'provider_account',
        freshness: primaryResetPassed ? 'expired_reset' : 'observed',
        categories: [
          {
            categoryKey: 'codex:codex',
            limitId: 'codex',
            recentTrend: [],
            windows: [
              {
                windowId: 'primary',
                usedPercent: primaryPct,
                remainingPercent: 100 - primaryPct,
                lastObservedAtMs: t0 - primaryAgeMs,
                ageMs: primaryAgeMs,
                resetsAtMs: t0 + 3_600_000,
                resetPassedWithoutNewObservation: primaryResetPassed,
              },
              {
                windowId: 'secondary',
                usedPercent: secondaryPct,
                remainingPercent: 100 - secondaryPct,
                lastObservedAtMs: t0 - 60_000,
                ageMs: 60_000,
                resetsAtMs: t0 + 86_400_000,
                resetPassedWithoutNewObservation: false,
              },
            ],
          },
        ],
      };
    });

  // Primary at 80% exact -> warning; Secondary at 95% exact -> critical (independent windows!).
  const q1 = evaluateQuotaPressure(codexQuotaSnap(80, 60_000, 95), new Map(), t0);
  const p1 = q1.find((a) => a.quotaWindowId === 'primary')!;
  const s1 = q1.find((a) => a.quotaWindowId === 'secondary')!;
  assert.equal(p1.state, 'active');
  assert.equal(p1.severity, 'warning');
  assert.equal(s1.state, 'active');
  assert.equal(s1.severity, 'critical');

  // Secondary drops to 91% (< 92% de-escalation) -> Warning; Primary becomes stale (> 15 min) -> not_evaluable (NEVER resolved!).
  const prevMap = new Map<string, PreventiveAlert>(q1.map((a) => [a.id, a]));
  const q2 = evaluateQuotaPressure(
    codexQuotaSnap(80, DEFAULT_CLAUDE_QUOTA_STALE_MS + 1000, 91),
    prevMap,
    t0 + 1000
  );
  const p2 = q2.find((a) => a.quotaWindowId === 'primary')!;
  const s2 = q2.find((a) => a.quotaWindowId === 'secondary')!;
  assert.equal(p2.state, 'not_evaluable');
  assert.equal(p2.coverage.reason, 'quota_stale');
  assert.equal(p2.resolvedAtMs, undefined);
  assert.equal(s2.state, 'active');
  assert.equal(s2.severity, 'warning');

  // Primary passes reset without new observation -> not_evaluable (expired_reset).
  const q3 = evaluateQuotaPressure(codexQuotaSnap(80, 60_000, 74, true), prevMap, t0 + 2000);
  const p3 = q3.find((a) => a.quotaWindowId === 'primary')!;
  const s3 = q3.find((a) => a.quotaWindowId === 'secondary')!;
  assert.equal(p3.state, 'not_evaluable');
  assert.equal(p3.coverage.reason, 'reset_passed_without_observation');
  assert.equal(s3.state, 'resolved');

  // Claude stale cached quota (> 15 min) -> never triggers warning even at 99%!
  const claudeStale = makeSnap('claude', t0, (s) => {
    s.subscription = {
      provider: 'claude',
      scope: 'provider_account',
      freshness: 'stale',
      cached: {
        isCached: true,
        isVerifiedRealTime: false,
        fetchedAtMs: t0 - 20 * 60_000,
        ageMs: 20 * 60_000,
        staleThresholdMs: DEFAULT_CLAUDE_QUOTA_STALE_MS,
        isStale: true,
        windows: [
          { windowId: 'five_hour', usedPercent: 99, resetsAtMs: t0 + 3_600_000, resetPassedWithoutNewObservation: false },
        ],
      },
    };
  });
  const cq = evaluateQuotaPressure(claudeStale, new Map(), t0);
  assert.equal(cq[0]?.state, 'not_evaluable');
  assert.equal(cq[0]?.coverage.reason, 'quota_stale');
});

test('computeBurnRate enforces strict disjoint window boundaries (nowMs-5m, nowMs] vs (nowMs-10m, nowMs-5m]', () => {
  const nowMs = Date.parse('2026-11-24T10:10:00Z');
  const makeInf = (id: string, tsMs: number): InferenceRecord => ({
    id,
    provider: 'codex',
    observedInSessionIds: ['codex:s1'],
    timestamp: tsMs,
    nativeIds: {},
    tokens: { totalInputTokens: 1000, outputTokens: 100, provenance: 'observed' },
    nativeUsage: {},
    sourceKey: 'codex:rollout:s1',
    position: { kind: 'byte_range', byteOffset: 0, byteLength: 10, lineNumber: 1 },
  });

  // Exactly at nowMs - 10m (excluded), exactly at nowMs - 5m (ONLY previousWindow), exactly at nowMs (ONLY current).
  const br = computeBurnRate(
    [
      makeInf('at-10m', nowMs - 10 * 60_000),
      makeInf('at-5m', nowMs - 5 * 60_000),
      makeInf('at-now', nowMs),
    ],
    nowMs - 15 * 60_000,
    nowMs
  );
  assert.equal(br.inferencesInWindow, 1);
  assert.equal(br.previousWindow?.inferencesInWindow, 1);
  assert.equal(br.inputTokensPerMin, 200);
  assert.equal(br.previousWindow?.inputTokensPerMin, 200);
});
