import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject, ObservationEnvelope, SourceRef } from '../src/acquisition/types.js';
import { createEmptyState } from '../src/core/model.js';
import { reconcileObservations } from '../src/core/reconcile.js';
import type { SessionSelection } from '../src/core/session-monitor.js';
import { parseClaudeTranscriptRecord } from '../src/providers/claude/parser.js';
import {
  computeProviderMetrics,
  DEFAULT_CLAUDE_QUOTA_STALE_MS,
  updateTimeDependentMetrics,
} from '../src/observatory/metrics.js';

function ref(overrides: Partial<SourceRef> = {}): SourceRef {
  return {
    path: 'C:\\logs\\s1.jsonl',
    logicalKey: 'codex:rollout:s1',
    kind: 'rollout',
    compressed: false,
    generation: 1,
    ...overrides,
  };
}

function obs(
  partial: Partial<ObservationEnvelope<JsonObject>> &
    Pick<ObservationEnvelope<JsonObject>, 'provider' | 'category' | 'eventType' | 'payload'>
): ObservationEnvelope<JsonObject> {
  return {
    nativeIds: {},
    source: ref(),
    position: { kind: 'byte_range', byteOffset: 0, byteLength: 10, lineNumber: 1 },
    ...partial,
  };
}

function sel(
  provider: 'codex' | 'claude',
  sessionId?: string,
  reason: SessionSelection['reason'] = 'runtime_workspace'
): SessionSelection {
  return {
    provider,
    ...(sessionId !== undefined ? { sessionId } : {}),
    reason,
    ambiguous: false,
    candidates: sessionId ? [{ sessionId, updatedAtMs: 0, sourcePath: 'C:\\logs\\s1.jsonl' }] : [],
    sources: [],
  };
}

test('Codex metrics separate direct/subagent/total without double counting, verify complete coverage, and never mark mtime-only as active', () => {
  const state = createEmptyState();
  const baseMs = Date.parse('2026-11-24T10:00:00Z');

  reconcileObservations(state, undefined, [
    obs({
      provider: 'codex', category: 'lifecycle', eventType: 'session_meta',
      nativeIds: { sessionId: 'p1', threadId: 'p1' },
      timestamp: '2026-11-24T10:00:00Z',
      payload: { kind: 'session_meta', cwd: 'F:\\Work', context_window: 200_000 },
    }),
    obs({
      provider: 'codex', category: 'lifecycle', eventType: 'turn_context',
      nativeIds: { sessionId: 'p1', turnId: 't1' },
      timestamp: '2026-11-24T10:00:01Z',
      payload: { kind: 'turn_context', model: 'gpt-5.4' },
    }),
    obs({
      provider: 'codex', category: 'usage_point', eventType: 'token_usage_record',
      nativeIds: { sessionId: 'p1', turnId: 't1', responseId: 'r1' },
      timestamp: '2026-11-24T10:01:00Z',
      position: { kind: 'byte_range', byteOffset: 10, byteLength: 20, lineNumber: 2 },
      payload: {
        kind: 'token_usage_record',
        usage: { input_tokens: 10_000, cached_input_tokens: 6_000, output_tokens: 500, reasoning_output_tokens: 200, total_tokens: 10_500 },
      },
    }),
    obs({
      provider: 'codex', category: 'lifecycle', eventType: 'compacted',
      nativeIds: { sessionId: 'p1' },
      timestamp: '2026-11-24T10:01:30Z',
      position: { kind: 'byte_range', byteOffset: 30, byteLength: 20, lineNumber: 3 },
      payload: { kind: 'compacted', window_number: 2 },
    }),
    obs({
      provider: 'codex', category: 'usage_point', eventType: 'token_usage_record',
      nativeIds: { sessionId: 'p1', turnId: 't1', responseId: 'r2' },
      timestamp: '2026-11-24T10:02:00Z',
      position: { kind: 'byte_range', byteOffset: 50, byteLength: 20, lineNumber: 4 },
      payload: {
        kind: 'token_usage_record',
        usage: { input_tokens: 4_000, cached_input_tokens: 2_000, output_tokens: 300, reasoning_output_tokens: 100, total_tokens: 4_300 },
      },
    }),
    // Harness cumulative snapshot matching direct totalTokens (10_500 + 4_300 = 14_800).
    obs({
      provider: 'codex', category: 'usage_snapshot', eventType: 'event_msg/token_count',
      nativeIds: { sessionId: 'p1' },
      timestamp: '2026-11-24T10:02:01Z',
      payload: {
        kind: 'token_count',
        model_context_window: 200_000,
        total_token_usage: { input_tokens: 14_000, cached_input_tokens: 8_000, output_tokens: 800, reasoning_output_tokens: 300, total_tokens: 14_800 },
        rate_limits: {
          limit_id: 'codex',
          plan_type: 'pro',
          primary: { used_percent: 25, window_minutes: 300, resets_at: Math.floor((baseMs + 3_600_000) / 1000) },
        },
      },
    }),
    // Subagent (newer than parent, separate model) — must NOT affect parent context!
    obs({
      provider: 'codex', category: 'lifecycle', eventType: 'session_meta',
      nativeIds: { sessionId: 'sub1', threadId: 'sub1', parentThreadId: 'p1' },
      timestamp: '2026-11-24T10:02:10Z',
      source: ref({ logicalKey: 'codex:rollout:sub1' }),
      payload: { kind: 'session_meta', agent_role: 'worker' },
    }),
    obs({
      provider: 'codex', category: 'lifecycle', eventType: 'turn_context',
      nativeIds: { sessionId: 'sub1', threadId: 'sub1', parentThreadId: 'p1', turnId: 'st1' },
      timestamp: '2026-11-24T10:02:11Z',
      source: ref({ logicalKey: 'codex:rollout:sub1' }),
      payload: { kind: 'turn_context', model: 'gpt-5.4-mini' },
    }),
    obs({
      provider: 'codex', category: 'usage_point', eventType: 'token_usage_record',
      nativeIds: { sessionId: 'sub1', threadId: 'sub1', parentThreadId: 'p1', turnId: 'st1', responseId: 'r-sub' },
      timestamp: '2026-11-24T10:02:15Z',
      source: ref({ logicalKey: 'codex:rollout:sub1' }),
      payload: {
        kind: 'token_usage_record',
        usage: { input_tokens: 50_000, cached_input_tokens: 0, output_tokens: 100, total_tokens: 50_100 },
      },
    }),
  ]);

  const snap = computeProviderMetrics('codex', state, sel('codex', 'p1', 'runtime_workspace'), baseMs + 3 * 60_000);

  // Status: Codex has no runtime PID evidence -> 'recent', NEVER 'active'.
  assert.equal(snap.identity.status, 'recent');
  assert.equal(snap.identity.runtimePresent, false);
  assert.equal(snap.identity.activityEvidence, 'recent_transcript');

  // Direct vs subagents vs inclusive total without double counting or re-adding reasoning.
  assert.equal(snap.usage.direct.totalInputTokens, 14_000);
  assert.equal(snap.usage.direct.uncachedInputTokens, 6_000);
  assert.equal(snap.usage.direct.cacheReadTokens, 8_000);
  assert.equal(snap.usage.direct.cacheWriteTokens, undefined);
  assert.equal(snap.usage.direct.outputTokens, 800);
  assert.equal(snap.usage.direct.reasoningTokens, 300);
  assert.equal(snap.usage.direct.totalTokens, 14_800);
  assert.equal(snap.usage.direct.cacheHitRatio, 8_000 / 14_000);

  assert.equal(snap.usage.subagents.totalTokens, 50_100);
  assert.equal(snap.usage.total.totalTokens, 64_900);
  assert.equal(snap.usage.byModel['gpt-5.4']?.totalTokens, 14_800);
  assert.equal(snap.usage.byModel['gpt-5.4-mini']?.totalTokens, 50_100);

  // Coverage: verified against matching codex_token_count snapshot (subagent lacks reasoning -> partialCount 0 since input/output present).
  assert.equal(snap.coverage.level, 'complete');
  assert.equal(snap.coverage.hasSnapshotDiscrepancy, false);

  // Context evolution: strictly primary session (latest is r2 = 4_000, NOT subagent 50_000, NOT cumulative 14_000).
  assert.equal(snap.context.series.length, 2);
  assert.equal(snap.context.currentContextTokens, 4_000);
  assert.equal(snap.context.currentContextTimestampMs, Date.parse('2026-11-24T10:02:00Z'));
  assert.equal(snap.context.isCurrentContextFromLatestInference, true);
  assert.equal(snap.context.contextWindowTokens, 200_000);
  assert.equal(snap.context.contextOccupancyPercent, 2);
  assert.equal(snap.context.compactions.length, 1);
  assert.equal(snap.context.compactions[0]?.afterInferenceIndex, 0);
  assert.equal(snap.context.compactions[0]?.windowNumber, 2);

  // Agentic metrics.
  assert.equal(snap.agentic.directInferenceCount, 2);
  assert.equal(snap.agentic.totalInferenceCount, 3);
  assert.equal(snap.agentic.userTurnCount, 1);
  assert.equal(snap.agentic.inferencesInLatestTurn, 2);
  assert.equal(snap.agentic.avgInferencesPerTurn, 2);
  assert.equal(snap.agentic.avgInputTokensPerInference, 7_000);
  assert.equal(snap.agentic.maxInputTokensPerInference, 10_000);
  assert.equal(snap.agentic.subagentCount, 1);

  // Burn rate (5 min rolling window, session_total includes subagent): 3 infs in window, short session (< 5 min) -> partial.
  assert.equal(snap.burnRate.inferencesInWindow, 3);
  assert.equal(snap.burnRate.inferencesPerMin, 3 / 5);
  assert.equal(snap.burnRate.inputTokensPerMin, 64_000 / 5);
  assert.equal(snap.burnRate.cacheReadTokensPerMin, 8_000 / 5);
  assert.equal(snap.burnRate.cacheWriteTokensPerMin, undefined);
  assert.equal(snap.burnRate.outputTokensPerMin, 900 / 5);
  assert.equal(snap.burnRate.windowCoverage, 'partial');

  // Burn rate decays cleanly to 0 during observed inactivity (10 minutes later, zero new log lines).
  const decayed = updateTimeDependentMetrics(snap, state, sel('codex', 'p1', 'runtime_workspace'), baseMs + 10 * 60_000);
  assert.equal(decayed.burnRate.inferencesInWindow, 0);
  assert.equal(decayed.burnRate.inferencesPerMin, 0);
  assert.equal(decayed.burnRate.inputTokensPerMin, 0);
  assert.equal(decayed.burnRate.cacheReadTokensPerMin, 0);
  assert.equal(decayed.burnRate.cacheWriteTokensPerMin, undefined); // never observed -> stays undefined
  assert.equal(decayed.burnRate.outputTokensPerMin, 0);
  assert.equal(decayed.burnRate.windowCoverage, 'full');
  // Unchanged aggregations reused by reference on idle update.
  assert.equal(decayed.usage, snap.usage);
  assert.equal(decayed.context, snap.context);

  // Subscription usage separated & no artificial zeroing past reset timestamp.
  assert.equal(snap.subscription.scope, 'provider_account');
  assert.equal(snap.subscription.freshness, 'observed');
  assert.equal(snap.subscription.categories?.[0]?.windows[0]?.usedPercent, 25);
  assert.equal(snap.subscription.categories?.[0]?.windows[0]?.remainingPercent, 75);
  assert.equal(snap.subscription.categories?.[0]?.windows[0]?.resetPassedWithoutNewObservation, false);

  const afterReset = updateTimeDependentMetrics(snap, state, sel('codex', 'p1', 'runtime_workspace'), baseMs + 2 * 3_600_000);
  assert.equal(afterReset.subscription.freshness, 'expired_reset');
  assert.equal(afterReset.subscription.categories?.[0]?.windows[0]?.usedPercent, 25); // NEVER artificially zeroed!
  assert.equal(afterReset.subscription.categories?.[0]?.windows[0]?.resetPassedWithoutNewObservation, true);
});

test('Legacy Codex snapshot-only session reports snapshot_only coverage and undefined (not 0) burn rate; discrepancy flagged when both exist', () => {
  const legacyState = createEmptyState();
  reconcileObservations(legacyState, undefined, [
    obs({
      provider: 'codex', category: 'usage_snapshot', eventType: 'event_msg/token_count',
      nativeIds: { sessionId: 'leg1' },
      timestamp: '2025-10-01T08:00:00Z',
      payload: {
        kind: 'token_count',
        total_token_usage: { input_tokens: 400, output_tokens: 100, total_tokens: 500 },
        model_context_window: 128_000,
      },
    }),
  ]);

  const snap = computeProviderMetrics('codex', legacyState, sel('codex', 'leg1', 'most_recent'), Date.parse('2025-10-01T08:01:00Z'));
  assert.equal(snap.coverage.level, 'snapshot_only');
  assert.equal(snap.usage.direct.inferenceCount, 0);
  assert.equal(snap.usage.direct.totalTokens, undefined);
  assert.equal(snap.usage.harnessSnapshot?.totalTokens?.totalTokens, 500);
  assert.equal(snap.burnRate.windowCoverage, 'unavailable');
  assert.equal(snap.burnRate.inferencesPerMin, undefined); // MUST NOT be 0 when uncomputable
  assert.equal(snap.burnRate.inputTokensPerMin, undefined);
  assert.equal(snap.agentic.userTurnCount, undefined);

  // Discrepancy between inference total and harness snapshot -> partial + hasSnapshotDiscrepancy.
  const discState = createEmptyState();
  reconcileObservations(discState, undefined, [
    obs({
      provider: 'codex', category: 'usage_point', eventType: 'token_usage_record',
      nativeIds: { sessionId: 'd1', responseId: 'r1' },
      timestamp: '2026-11-24T10:00:00Z',
      payload: { kind: 'token_usage_record', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20, total_tokens: 120 } },
    }),
    obs({
      provider: 'codex', category: 'usage_snapshot', eventType: 'event_msg/token_count',
      nativeIds: { sessionId: 'd1' },
      timestamp: '2026-11-24T10:00:01Z',
      payload: { kind: 'token_count', total_token_usage: { input_tokens: 300, output_tokens: 50, total_tokens: 350 } },
    }),
  ]);
  const discSnap = computeProviderMetrics('codex', discState, sel('codex', 'd1', 'most_recent'), Date.parse('2026-11-24T10:01:00Z'));
  assert.equal(discSnap.coverage.level, 'partial');
  assert.equal(discSnap.coverage.hasSnapshotDiscrepancy, true);
  assert.equal(discSnap.usage.direct.totalTokens, 120); // NEVER summed with 350
  assert.equal(discSnap.usage.harnessSnapshot?.totalTokens?.totalTokens, 350);
});

test('Claude metrics filter non-human user frames, exclude server-side multi-iteration from context, keep contextWindow undefined, and track runtime_idle & stale quota', () => {
  const state = createEmptyState();
  const sRef = ref({ logicalKey: 'claude:transcript:c1', kind: 'transcript' });
  const pos = (line: number) => ({ kind: 'byte_range' as const, byteOffset: line * 10, byteLength: 10, lineNumber: line });

  const rawLines = [
    // Real user turn 1
    { type: 'user', sessionId: 'c1', uuid: 'u1', timestamp: '2026-11-24T10:00:00Z', cwd: 'F:\\Work', turnOrigin: 'human', message: { content: 'hello' } },
    // Tool result user frame -> MUST NOT count as user turn
    { type: 'user', sessionId: 'c1', uuid: 'u-tool', timestamp: '2026-11-24T10:00:05Z', toolUseResult: { ok: true }, message: { content: [{ type: 'tool_result' }] } },
    // Meta & compact summary & task notification -> MUST NOT count as user turns
    { type: 'user', sessionId: 'c1', uuid: 'u-meta', timestamp: '2026-11-24T10:00:06Z', isMeta: true },
    { type: 'user', sessionId: 'c1', uuid: 'u-comp', timestamp: '2026-11-24T10:00:07Z', isCompactSummary: true },
    { type: 'user', sessionId: 'c1', uuid: 'u-sys', timestamp: '2026-11-24T10:00:08Z', promptSource: 'system', turnOrigin: 'task_notification' },
    // Single-iteration assistant inference 1
    {
      type: 'assistant', sessionId: 'c1', uuid: 'a1', timestamp: '2026-11-24T10:00:10Z',
      message: {
        id: 'm1', model: 'claude-opus-4-6', stop_reason: 'tool_use', content: [],
        usage: { input_tokens: 1_000, cache_read_input_tokens: 4_000, cache_creation_input_tokens: 500, output_tokens: 200, output_tokens_details: { thinking_tokens: 80 } },
      },
    },
    // Compaction boundary
    { type: 'system', subtype: 'compact_boundary', sessionId: 'c1', uuid: 'cb1', timestamp: '2026-11-24T10:00:20Z', compactMetadata: { trigger: 'auto', preTokens: 5_500, postTokens: 2_000 } },
    // Real user turn 2
    { type: 'user', sessionId: 'c1', uuid: 'u2', timestamp: '2026-11-24T10:01:00Z', turnOrigin: 'human', message: { content: 'next' } },
    // Multi-iteration server-side assistant inference 2 -> top-level input is aggregated, MUST NOT become currentContextTokens!
    {
      type: 'assistant', sessionId: 'c1', uuid: 'a2', timestamp: '2026-11-24T10:01:10Z',
      message: {
        id: 'm2', model: 'claude-opus-4-6', stop_reason: 'end_turn', content: [],
        usage: {
          input_tokens: 10_000, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 0, output_tokens: 300,
          iterations: [{ type: 'message', input_tokens: 5_000 }, { type: 'message', input_tokens: 5_000 }],
        },
      },
      quotaLimits: { status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: '2026-11-24T15:00:00Z' },
    },
  ];

  const allObs: Array<ObservationEnvelope<JsonObject>> = [];
  rawLines.forEach((raw, idx) => {
    allObs.push(...parseClaudeTranscriptRecord(raw, sRef, pos(idx + 1)).observations);
  });

  // Add runtime_session with explicit status 'idle' + cachedUsageUtilization
  allObs.push(
    obs({
      provider: 'claude', category: 'lifecycle', eventType: 'runtime_session',
      nativeIds: { sessionId: 'c1', pid: 4242 },
      timestamp: Date.parse('2026-11-24T10:01:15Z'),
      source: ref({ logicalKey: 'claude:runtime_session:4242.json', kind: 'runtime_session' }),
      payload: { kind: 'runtime_session', pid: 4242, status: 'idle' },
    }),
    obs({
      provider: 'claude', category: 'usage_snapshot', eventType: 'cachedUsageUtilization',
      timestamp: Date.parse('2026-11-24T09:55:00Z'),
      source: ref({ logicalKey: 'claude:cached_usage_utilization', kind: 'claude_json_usage' }),
      payload: {
        kind: 'cached_usage_utilization',
        isCachedSnapshot: true,
        fetchedAtMs: Date.parse('2026-11-24T09:55:00Z'),
        utilization: {
          five_hour: { utilization: 42, resets_at: '2026-11-24T12:00:00Z' },
          seven_day: { utilization: 18, resets_at: '2026-11-29T00:00:00Z' },
        },
      },
    })
  );

  reconcileObservations(state, undefined, allObs);

  // Evaluate 7 minutes after cached fetch (< 15 min -> 'cached', not stale yet).
  const tNow = Date.parse('2026-11-24T10:02:00Z');
  const snap = computeProviderMetrics('claude', state, sel('claude', 'c1', 'runtime_workspace'), tNow);

  // Live PID + explicit status 'idle' -> 'runtime_idle' with runtimePresent: true!
  assert.equal(snap.identity.status, 'runtime_idle');
  assert.equal(snap.identity.runtimePresent, true);
  assert.equal(snap.identity.runtimePid, 4242);
  assert.equal(snap.identity.runtimeStatus, 'idle');

  // Only the 2 real human user prompts counted as turns (not the 4 non-human user frames!).
  assert.equal(snap.agentic.userTurnCount, 2);
  assert.equal(snap.agentic.directInferenceCount, 2);
  assert.equal(snap.agentic.inferencesInLatestTurn, 1);
  assert.equal(snap.agentic.avgInferencesPerTurn, 1);

  // Context evolution: m2 is server-side multi-iteration -> omitted from currentContextTokens, falls back to m1 with explicit timestamp & flag=false!
  assert.equal(snap.context.series.length, 2);
  assert.equal(snap.context.series[0]?.totalInputTokens, 5_500);
  assert.equal(snap.context.series[1]?.isAggregatedServerSide, true);
  assert.equal(snap.context.series[1]?.totalInputTokens, undefined);
  assert.equal(snap.context.currentContextTokens, 5_500);
  assert.equal(snap.context.currentContextTimestampMs, Date.parse('2026-11-24T10:00:10Z'));
  assert.equal(snap.context.isCurrentContextFromLatestInference, false);
  // No static context window map for Claude!
  assert.equal(snap.context.contextWindowTokens, undefined);
  assert.equal(snap.context.contextOccupancyPercent, undefined);
  assert.equal(snap.context.compactions[0]?.preTokens, 5_500);
  assert.equal(snap.context.compactions[0]?.postTokens, 2_000);

  // Coverage: no harness cross-check -> MUST NOT report 'complete' (stays 'partial' with completeness_unverified).
  assert.equal(snap.coverage.level, 'partial');
  assert.ok(snap.coverage.notes.includes('completeness_unverified'));
  assert.ok(snap.coverage.notes.includes('server_side_multi_iteration'));
  assert.ok(snap.coverage.notes.includes('context_window_unavailable'));

  // Subscription usage: cached at 7 min age -> 'cached', isStale: false, isVerifiedRealTime: false.
  assert.equal(snap.subscription.freshness, 'cached');
  assert.equal(snap.subscription.cached?.isCached, true);
  assert.equal(snap.subscription.cached?.isVerifiedRealTime, false);
  assert.equal(snap.subscription.cached?.isStale, false);
  assert.equal(snap.subscription.cached?.ageMs, 7 * 60_000);
  assert.equal(snap.subscription.rateLimitStatus?.status, 'allowed_warning');

  // At 20 min after fetchedAtMs (> 15 min informational threshold) -> 'stale'.
  const staleSnap = updateTimeDependentMetrics(
    snap,
    state,
    sel('claude', 'c1', 'runtime_workspace'),
    Date.parse('2026-11-24T09:55:00Z') + DEFAULT_CLAUDE_QUOTA_STALE_MS + 5 * 60_000
  );
  assert.equal(staleSnap.subscription.freshness, 'stale');
  assert.equal(staleSnap.subscription.cached?.isStale, true);
  assert.equal(staleSnap.subscription.cached?.windows[0]?.usedPercent, 42);

  // Past five_hour reset (12:00Z) without new fetch -> 'expired_reset', value NOT zeroed!
  const expiredSnap = updateTimeDependentMetrics(
    snap,
    state,
    sel('claude', 'c1', 'runtime_workspace'),
    Date.parse('2026-11-24T12:30:00Z')
  );
  assert.equal(expiredSnap.subscription.freshness, 'expired_reset');
  assert.equal(expiredSnap.subscription.cached?.windows[0]?.usedPercent, 42);
  assert.equal(expiredSnap.subscription.cached?.windows[0]?.resetPassedWithoutNewObservation, true);
});
