import type { ProviderId } from '../acquisition/types.js';
import {
  DEFAULT_CLAUDE_QUOTA_STALE_MS,
  type ProviderObservatorySnapshot,
} from '../observatory/metrics.js';

export type AlertRuleId =
  | 'context_pressure'
  | 'context_growth'
  | 'repeated_context_processing'
  | 'agentic_intensity'
  | 'consumption_acceleration'
  | 'quota_pressure';

export type AlertSeverity = 'warning' | 'critical';
export type AlertState = 'active' | 'resolved' | 'not_evaluable';
export type AlertScope = 'session' | 'account';

export interface AlertCoverage {
  evaluable: boolean;
  status: string;
  reason?: string;
}

export interface PreventiveAlert {
  id: string;
  ruleId: AlertRuleId;
  provider: ProviderId;
  scope: AlertScope;
  sessionId?: string;
  turnId?: string;
  quotaCategory?: string;
  quotaWindowId?: string;
  state: AlertState;
  severity?: AlertSeverity;
  observedValue?: number;
  threshold?: number;
  unit?: string;
  activatedAtMs?: number;
  updatedAtMs: number;
  resolvedAtMs?: number;
  evidence: Record<string, number | string | boolean>;
  coverage: AlertCoverage;
  summary: string;
}

export interface ProviderMonitoringSnapshot {
  provider: ProviderId;
  updatedAtMs: number;
  sessionId?: string;
  alerts: PreventiveAlert[];
}

export interface MonitoringSnapshot {
  updatedAtMs: number;
  providers: Record<ProviderId, ProviderMonitoringSnapshot>;
}

/**
 * Centralized V0.1 preventive thresholds (initial operational conventions, not empirically
 * proven efficiency limits). Hysteresis bands prevent repeated flapping near boundaries.
 */
export const MONITORING_THRESHOLDS = {
  contextPressure: {
    warningPct: 80,
    criticalPct: 90,
    deescalateCriticalPct: 85,
    resolvePct: 75,
  },
  contextGrowth: {
    minPoints: 3,
    maxPoints: 5,
    warningAbsTokens: 40_000,
    warningRelRatio: 0.40,
    criticalAbsTokens: 80_000,
    criticalRelRatio: 0.75,
    deescalateAbsTokens: 65_000,
    deescalateRelRatio: 0.60,
    resolveAbsTokens: 25_000,
    resolveRelRatio: 0.25,
  },
  repeatedContextProcessing: {
    windowMinutes: 5,
    warningCacheReadTokens: 2_000_000,
    warningShareRatio: 0.70,
    warningContextMultiple: 10,
    criticalCacheReadTokens: 5_000_000,
    criticalShareRatio: 0.80,
    criticalContextMultiple: 20,
    deescalateCacheReadTokens: 4_000_000,
    deescalateShareRatio: 0.75,
    deescalateContextMultiple: 16,
    resolveCacheReadTokens: 1_500_000,
    resolveShareRatio: 0.60,
    resolveContextMultiple: 8,
  },
  agenticIntensity: {
    warningInferences: 30,
    criticalInferences: 60,
    deescalateCriticalInferences: 50,
    resolveInferences: 25,
  },
  consumptionAcceleration: {
    minPrevInferences: 2,
    minCurInferencesActivate: 3,
    minCurInferencesStay: 2,
    minPrevInputPerMin: 20_000,
    warningRatio: 2.5,
    warningAbsDeltaPerMin: 100_000,
    criticalRatio: 4.0,
    criticalAbsDeltaPerMin: 250_000,
    deescalateRatio: 3.2,
    deescalateAbsDeltaPerMin: 180_000,
    resolveRatio: 1.8,
    resolveAbsDeltaPerMin: 60_000,
  },
  quotaPressure: {
    warningPct: 80,
    criticalPct: 95,
    deescalateCriticalPct: 92,
    resolvePct: 75,
    freshnessMaxAgeMs: DEFAULT_CLAUDE_QUOTA_STALE_MS,
  },
} as const;

interface TransitionInput {
  prev?: PreventiveAlert;
  meetsCrit: boolean;
  meetsWarn: boolean;
  staysCrit: boolean;
  staysWarn: boolean;
  nowMs: number;
}

interface TransitionOutput {
  state: 'active' | 'resolved';
  severity?: AlertSeverity;
  activatedAtMs?: number;
  resolvedAtMs?: number;
}

/** Deterministic state machine: activation, W->C escalation, C->W de-escalation, and hysteresis resolution. */
function resolveTransition(t: TransitionInput): TransitionOutput {
  const wasActive = t.prev?.state === 'active';
  const wasCrit = wasActive && t.prev?.severity === 'critical';

  if (t.meetsCrit) {
    return {
      state: 'active',
      severity: 'critical',
      activatedAtMs: wasActive ? (t.prev!.activatedAtMs ?? t.nowMs) : t.nowMs,
    };
  }
  if (wasCrit && t.staysCrit) {
    return {
      state: 'active',
      severity: 'critical',
      activatedAtMs: t.prev!.activatedAtMs ?? t.nowMs,
    };
  }
  if (t.meetsWarn || (wasActive && t.staysWarn)) {
    return {
      state: 'active',
      severity: 'warning',
      activatedAtMs: wasActive ? (t.prev!.activatedAtMs ?? t.nowMs) : t.nowMs,
    };
  }
  return {
    state: 'resolved',
    ...(wasActive
      ? { activatedAtMs: t.prev!.activatedAtMs, resolvedAtMs: t.nowMs }
      : t.prev?.state === 'resolved'
        ? {
            ...(t.prev.activatedAtMs !== undefined ? { activatedAtMs: t.prev.activatedAtMs } : {}),
            ...(t.prev.resolvedAtMs !== undefined ? { resolvedAtMs: t.prev.resolvedAtMs } : {}),
          }
        : {}),
  };
}

function notEvaluableAlert(
  base: {
    id: string;
    ruleId: AlertRuleId;
    provider: ProviderId;
    scope: AlertScope;
    sessionId?: string;
    turnId?: string;
    quotaCategory?: string;
    quotaWindowId?: string;
  },
  nowMs: number,
  status: string,
  reason: string,
  summary: string,
  evidence: Record<string, number | string | boolean> = {}
): PreventiveAlert {
  // Losing data/coverage transitions to `not_evaluable`, NEVER `resolved`.
  return {
    ...base,
    state: 'not_evaluable',
    updatedAtMs: nowMs,
    evidence,
    coverage: { evaluable: false, status, reason },
    summary,
  };
}

const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-US');
const fmtPct = (n: number): string => `${n.toFixed(1)}%`;

export function evaluateContextPressure(
  snap: ProviderObservatorySnapshot,
  prev: PreventiveAlert | undefined,
  nowMs: number
): PreventiveAlert {
  const T = MONITORING_THRESHOLDS.contextPressure;
  const base = {
    id: `${snap.provider}:session:context_pressure`,
    ruleId: 'context_pressure' as const,
    provider: snap.provider,
    scope: 'session' as const,
    ...(snap.identity.sessionId !== undefined ? { sessionId: snap.identity.sessionId } : {}),
  };
  const ctx = snap.context;

  if (ctx.contextWindowTokens === undefined || ctx.contextWindowTokens <= 0) {
    return notEvaluableAlert(
      base,
      nowMs,
      'unavailable',
      'context_window_unavailable',
      'Context window capacity is not observed for this session.'
    );
  }
  if (ctx.currentContextTokens === undefined || !ctx.isCurrentContextFromLatestInference || ctx.contextOccupancyPercent === undefined) {
    return notEvaluableAlert(
      base,
      nowMs,
      'partial',
      'latest_context_invalid',
      'Latest primary-session inference does not provide a valid single-context measurement.',
      {
        contextWindowTokens: ctx.contextWindowTokens,
        ...(ctx.currentContextTokens !== undefined ? { lastValidContextTokens: ctx.currentContextTokens } : {}),
        ...(ctx.currentContextTimestampMs !== undefined ? { lastValidContextTimestampMs: ctx.currentContextTimestampMs } : {}),
      }
    );
  }

  const occ = ctx.contextOccupancyPercent;
  const tr = resolveTransition({
    prev,
    meetsCrit: occ >= T.criticalPct,
    meetsWarn: occ >= T.warningPct,
    staysCrit: occ >= T.deescalateCriticalPct,
    staysWarn: occ >= T.resolvePct,
    nowMs,
  });

  const threshold = tr.severity === 'critical' ? T.criticalPct : T.warningPct;
  return {
    ...base,
    ...tr,
    observedValue: Number(occ.toFixed(2)),
    threshold,
    unit: 'percent',
    updatedAtMs: nowMs,
    evidence: {
      occupancyPercent: Number(occ.toFixed(2)),
      currentContextTokens: ctx.currentContextTokens,
      contextWindowTokens: ctx.contextWindowTokens,
      ...(ctx.currentContextTimestampMs !== undefined ? { inferenceTimestampMs: ctx.currentContextTimestampMs } : {}),
    },
    coverage: { evaluable: true, status: snap.coverage.level },
    summary:
      tr.state === 'active'
        ? `Observed context occupancy is ${fmtPct(occ)} (${fmtInt(ctx.currentContextTokens)} / ${fmtInt(ctx.contextWindowTokens)} tokens).`
        : `Observed context occupancy is ${fmtPct(occ)} (${fmtInt(ctx.currentContextTokens)} / ${fmtInt(ctx.contextWindowTokens)} tokens), below threshold.`,
  };
}

export function evaluateContextGrowth(
  snap: ProviderObservatorySnapshot,
  prev: PreventiveAlert | undefined,
  nowMs: number
): PreventiveAlert {
  const T = MONITORING_THRESHOLDS.contextGrowth;
  const base = {
    id: `${snap.provider}:session:context_growth`,
    ruleId: 'context_growth' as const,
    provider: snap.provider,
    scope: 'session' as const,
    ...(snap.identity.sessionId !== undefined ? { sessionId: snap.identity.sessionId } : {}),
  };

  const series = snap.context.series;
  if (series.length === 0) {
    return notEvaluableAlert(base, nowMs, 'unavailable', 'no_primary_inferences', 'No primary-session context points available.');
  }

  const lastIdx = series.length - 1;
  const lastPt = series[lastIdx]!;
  if (lastPt.totalInputTokens === undefined || lastPt.isAggregatedServerSide) {
    return notEvaluableAlert(
      base,
      nowMs,
      'partial',
      'latest_context_invalid',
      'Latest primary-session inference cannot be compared for single-context growth.'
    );
  }

  // Deterministic maximal comparable suffix up to `maxPoints` (never cherry-picking sub-windows).
  const compactionAfter = new Set(snap.context.compactions.map((c) => c.afterInferenceIndex));
  const minStart = Math.max(0, lastIdx - (T.maxPoints - 1));
  let startIdx = lastIdx;
  let breakReason: string | undefined;

  for (let i = lastIdx; i > minStart; i -= 1) {
    if (compactionAfter.has(i - 1)) {
      breakReason = 'compaction_boundary';
      break;
    }
    const cur = series[i]!;
    const prevPt = series[i - 1]!;
    if (prevPt.totalInputTokens === undefined || prevPt.isAggregatedServerSide) {
      breakReason = 'coverage_discontinuity';
      break;
    }
    if (cur.model !== prevPt.model) {
      breakReason = 'model_change';
      break;
    }
    startIdx = i - 1;
  }

  const segLen = lastIdx - startIdx + 1;
  const startTokens = series[startIdx]!.totalInputTokens!;
  const endTokens = lastPt.totalInputTokens;

  if (segLen < T.minPoints || startTokens <= 0) {
    return notEvaluableAlert(
      base,
      nowMs,
      'partial',
      breakReason ?? 'insufficient_comparable_inferences',
      `Fewer than ${T.minPoints} consecutive comparable primary-session inferences available.`,
      { comparablePoints: segLen, requiredPoints: T.minPoints }
    );
  }

  const deltaAbs = endTokens - startTokens;
  const deltaRel = deltaAbs / startTokens;

  const tr = resolveTransition({
    prev,
    meetsCrit: deltaAbs >= T.criticalAbsTokens && deltaRel >= T.criticalRelRatio,
    meetsWarn: deltaAbs >= T.warningAbsTokens && deltaRel >= T.warningRelRatio,
    staysCrit: deltaAbs >= T.deescalateAbsTokens && deltaRel >= T.deescalateRelRatio,
    staysWarn: deltaAbs >= T.resolveAbsTokens && deltaRel >= T.resolveRelRatio,
    nowMs,
  });

  const threshold = tr.severity === 'critical' ? T.criticalAbsTokens : T.warningAbsTokens;
  return {
    ...base,
    ...tr,
    observedValue: deltaAbs,
    threshold,
    unit: 'tokens',
    updatedAtMs: nowMs,
    evidence: {
      deltaAbsTokens: deltaAbs,
      deltaRelPercent: Number((deltaRel * 100).toFixed(1)),
      startContextTokens: startTokens,
      endContextTokens: endTokens,
      comparableInferences: segLen,
      ...(lastPt.model !== undefined ? { model: lastPt.model } : {}),
    },
    coverage: { evaluable: true, status: snap.coverage.level },
    summary:
      tr.state === 'active'
        ? `Primary-session context increased by ${fmtInt(deltaAbs)} tokens (${fmtPct(deltaRel * 100)}) across ${segLen} consecutive comparable inferences.`
        : `Primary-session context delta is ${fmtInt(deltaAbs)} tokens (${fmtPct(deltaRel * 100)}) across ${segLen} comparable inferences.`,
  };
}

export function evaluateRepeatedContextProcessing(
  snap: ProviderObservatorySnapshot,
  prev: PreventiveAlert | undefined,
  nowMs: number
): PreventiveAlert {
  const T = MONITORING_THRESHOLDS.repeatedContextProcessing;
  const base = {
    id: `${snap.provider}:session:repeated_context_processing`,
    ruleId: 'repeated_context_processing' as const,
    provider: snap.provider,
    scope: 'session' as const,
    ...(snap.identity.sessionId !== undefined ? { sessionId: snap.identity.sessionId } : {}),
  };

  const br = snap.burnRate;
  if (
    br.windowCoverage === 'unavailable' ||
    br.cacheReadTokensPerMin === undefined ||
    br.inputTokensPerMin === undefined
  ) {
    return notEvaluableAlert(
      base,
      nowMs,
      'unavailable',
      'cache_read_rate_unavailable',
      'Recent 5-minute cache-read or input token rate is unavailable for this session.'
    );
  }

  const recentCacheRead = br.cacheReadTokensPerMin * T.windowMinutes;
  const recentInput = br.inputTokensPerMin * T.windowMinutes;
  const cacheReadShare = recentInput > 0 ? recentCacheRead / recentInput : 0;

  // Scope coherence: NEVER divide session-total (including subagents) by primary-session-only context.
  const hasSubagents = snap.usage.subagents.inferenceCount > 0;
  const ctx = snap.context;
  const validPrimaryCtx =
    ctx.currentContextTokens !== undefined &&
    ctx.currentContextTokens > 0 &&
    ctx.isCurrentContextFromLatestInference;

  let contextMultiple: number | undefined;
  let contextMultipleReason: string | undefined;
  if (hasSubagents) {
    contextMultipleReason = 'subagents_present_scope_mismatch';
  } else if (!validPrimaryCtx) {
    contextMultipleReason = 'primary_context_unavailable';
  } else {
    contextMultiple = recentCacheRead / ctx.currentContextTokens!;
  }

  const meetsCrit =
    recentCacheRead >= T.criticalCacheReadTokens &&
    cacheReadShare >= T.criticalShareRatio &&
    (contextMultiple === undefined || contextMultiple >= T.criticalContextMultiple);
  const meetsWarn =
    recentCacheRead >= T.warningCacheReadTokens &&
    cacheReadShare >= T.warningShareRatio &&
    (contextMultiple === undefined || contextMultiple >= T.warningContextMultiple);
  const staysCrit =
    recentCacheRead >= T.deescalateCacheReadTokens &&
    cacheReadShare >= T.deescalateShareRatio &&
    (contextMultiple === undefined || contextMultiple >= T.deescalateContextMultiple);
  const staysWarn =
    recentCacheRead >= T.resolveCacheReadTokens &&
    cacheReadShare >= T.resolveShareRatio &&
    (contextMultiple === undefined || contextMultiple >= T.resolveContextMultiple);

  const tr = resolveTransition({ prev, meetsCrit, meetsWarn, staysCrit, staysWarn, nowMs });
  const threshold = tr.severity === 'critical' ? T.criticalCacheReadTokens : T.warningCacheReadTokens;

  const multText =
    contextMultiple !== undefined
      ? ` (${contextMultiple.toFixed(1)}x observed primary context)`
      : ' (context multiple unavailable)';
  return {
    ...base,
    ...tr,
    observedValue: Math.round(recentCacheRead),
    threshold,
    unit: 'tokens',
    updatedAtMs: nowMs,
    evidence: {
      recentCacheReadTokens: Math.round(recentCacheRead),
      recentInputTokens: Math.round(recentInput),
      cacheReadSharePercent: Number((cacheReadShare * 100).toFixed(1)),
      inferencesInWindow: br.inferencesInWindow,
      burnRateScope: br.scope,
      contextMultipleAvailable: contextMultiple !== undefined,
      ...(contextMultiple !== undefined ? { contextMultiple: Number(contextMultiple.toFixed(2)) } : {}),
      ...(contextMultipleReason !== undefined ? { contextMultipleUnavailableReason: contextMultipleReason } : {}),
    },
    coverage: {
      evaluable: true,
      status: br.windowCoverage,
      ...(contextMultipleReason !== undefined ? { reason: contextMultipleReason } : {}),
    },
    summary:
      tr.state === 'active'
        ? `Processed ${fmtInt(recentCacheRead)} cache-read tokens in the last 5 minutes (${fmtPct(cacheReadShare * 100)} of recent input)${multText}.`
        : `Processed ${fmtInt(recentCacheRead)} cache-read tokens in the last 5 minutes (${fmtPct(cacheReadShare * 100)} of recent input), below threshold.`,
  };
}

export function evaluateAgenticIntensity(
  snap: ProviderObservatorySnapshot,
  prev: PreventiveAlert | undefined,
  nowMs: number
): PreventiveAlert {
  const T = MONITORING_THRESHOLDS.agenticIntensity;
  const ag = snap.agentic;
  const base = {
    id: `${snap.provider}:session:agentic_intensity`,
    ruleId: 'agentic_intensity' as const,
    provider: snap.provider,
    scope: 'session' as const,
    ...(snap.identity.sessionId !== undefined ? { sessionId: snap.identity.sessionId } : {}),
    ...(ag.latestTurnId !== undefined ? { turnId: ag.latestTurnId } : {}),
  };

  if (ag.userTurnCount === undefined || ag.inferencesInLatestTurn === undefined) {
    return notEvaluableAlert(
      base,
      nowMs,
      'unavailable',
      'user_turns_not_reconstructible',
      'Reconstructed user turns are not available for this session.'
    );
  }

  // Never carry over an active alert/hysteresis from a previous turn onto a newly started turn.
  const sameTurnPrev = prev && prev.turnId === ag.latestTurnId ? prev : undefined;
  const count = ag.inferencesInLatestTurn;
  const turnPhase =
    ag.latestTurnStatus === 'started'
      ? 'current'
      : ag.latestTurnStatus === 'completed'
        ? 'completed'
        : ag.latestTurnStatus === 'aborted'
          ? 'aborted'
          : 'latest_observed';

  const tr = resolveTransition({
    prev: sameTurnPrev,
    meetsCrit: count >= T.criticalInferences,
    meetsWarn: count >= T.warningInferences,
    staysCrit: count >= T.deescalateCriticalInferences,
    staysWarn: count >= T.resolveInferences,
    nowMs,
  });

  // If a previous turn was active and a brand-new turn started below threshold, stamp resolution time cleanly.
  const resolvedAtMs =
    tr.state === 'resolved' && tr.resolvedAtMs === undefined && prev?.state === 'active' && prev.turnId !== ag.latestTurnId
      ? nowMs
      : tr.resolvedAtMs;

  const threshold = tr.severity === 'critical' ? T.criticalInferences : T.warningInferences;
  const phaseLabel =
    turnPhase === 'current'
      ? 'current user turn'
      : turnPhase === 'completed'
        ? 'last completed user turn'
        : turnPhase === 'aborted'
          ? 'last aborted user turn'
          : 'latest observed user turn';

  return {
    ...base,
    ...tr,
    ...(resolvedAtMs !== undefined ? { resolvedAtMs } : {}),
    observedValue: count,
    threshold,
    unit: 'inferences',
    updatedAtMs: nowMs,
    evidence: {
      inferencesInTurn: count,
      userTurnCount: ag.userTurnCount,
      turnPhase,
      primarySessionOnly: true,
      sessionSubagentCount: ag.subagentCount,
      ...(ag.latestTurnId !== undefined ? { turnId: ag.latestTurnId } : {}),
      ...(ag.latestTurnStatus !== undefined ? { turnStatus: ag.latestTurnStatus } : {}),
    },
    coverage: { evaluable: true, status: snap.coverage.level },
    summary:
      tr.state === 'active'
        ? `Observed ${count} direct primary-session inferences in the ${phaseLabel} (${ag.subagentCount} session subagents tracked separately).`
        : `Observed ${count} direct primary-session inferences in the ${phaseLabel}, below threshold.`,
  };
}

export function evaluateConsumptionAcceleration(
  snap: ProviderObservatorySnapshot,
  prev: PreventiveAlert | undefined,
  nowMs: number
): PreventiveAlert {
  const T = MONITORING_THRESHOLDS.consumptionAcceleration;
  const base = {
    id: `${snap.provider}:session:consumption_acceleration`,
    ruleId: 'consumption_acceleration' as const,
    provider: snap.provider,
    scope: 'session' as const,
    ...(snap.identity.sessionId !== undefined ? { sessionId: snap.identity.sessionId } : {}),
  };

  const br = snap.burnRate;
  const prevWin = br.previousWindow;

  if (br.windowCoverage === 'unavailable' || br.inputTokensPerMin === undefined) {
    return notEvaluableAlert(
      base,
      nowMs,
      'unavailable',
      'burn_rate_unavailable',
      'Current 5-minute input burn rate is unavailable.'
    );
  }
  if (!prevWin || prevWin.windowCoverage === 'unavailable' || prevWin.inputTokensPerMin === undefined) {
    return notEvaluableAlert(
      base,
      nowMs,
      'partial',
      'previous_window_unavailable',
      'Preceding 5-minute baseline window is not available yet.'
    );
  }
  // Prevent false alerts on cold start or normal resumption after inactivity (including 0 denominator).
  if (prevWin.inferencesInWindow < T.minPrevInferences || prevWin.inputTokensPerMin < T.minPrevInputPerMin) {
    return notEvaluableAlert(
      base,
      nowMs,
      'partial',
      'insufficient_baseline_activity',
      'Preceding 5-minute baseline activity is below minimum requirements for acceleration comparison.',
      {
        previousInferences: prevWin.inferencesInWindow,
        previousInputTokensPerMin: Math.round(prevWin.inputTokensPerMin),
        currentInferences: br.inferencesInWindow,
        currentInputTokensPerMin: Math.round(br.inputTokensPerMin),
      }
    );
  }

  const curRate = br.inputTokensPerMin;
  const prevRate = prevWin.inputTokensPerMin;
  const ratio = curRate / prevRate;
  const absDelta = curRate - prevRate;

  const tr = resolveTransition({
    prev,
    meetsCrit:
      br.inferencesInWindow >= T.minCurInferencesActivate &&
      ratio >= T.criticalRatio &&
      absDelta >= T.criticalAbsDeltaPerMin,
    meetsWarn:
      br.inferencesInWindow >= T.minCurInferencesActivate &&
      ratio >= T.warningRatio &&
      absDelta >= T.warningAbsDeltaPerMin,
    staysCrit:
      br.inferencesInWindow >= T.minCurInferencesActivate &&
      ratio >= T.deescalateRatio &&
      absDelta >= T.deescalateAbsDeltaPerMin,
    staysWarn:
      br.inferencesInWindow >= T.minCurInferencesStay &&
      ratio >= T.resolveRatio &&
      absDelta >= T.resolveAbsDeltaPerMin,
    nowMs,
  });

  const threshold = tr.severity === 'critical' ? T.criticalRatio : T.warningRatio;
  return {
    ...base,
    ...tr,
    observedValue: Number(ratio.toFixed(2)),
    threshold,
    unit: 'ratio',
    updatedAtMs: nowMs,
    evidence: {
      currentInputTokensPerMin: Math.round(curRate),
      previousInputTokensPerMin: Math.round(prevRate),
      ratio: Number(ratio.toFixed(2)),
      absDeltaPerMin: Math.round(absDelta),
      currentInferences: br.inferencesInWindow,
      previousInferences: prevWin.inferencesInWindow,
    },
    coverage: {
      evaluable: true,
      status: br.windowCoverage === 'full' && prevWin.windowCoverage === 'full' ? 'full' : 'partial',
    },
    summary:
      tr.state === 'active'
        ? `Recent 5-minute input rate is ${fmtInt(curRate)} tok/min (${ratio.toFixed(2)}x the preceding 5-minute rate of ${fmtInt(prevRate)} tok/min).`
        : `Recent 5-minute input rate is ${fmtInt(curRate)} tok/min (${ratio.toFixed(2)}x preceding ${fmtInt(prevRate)} tok/min), below threshold.`,
  };
}

export function evaluateQuotaPressure(
  snap: ProviderObservatorySnapshot,
  prevById: ReadonlyMap<string, PreventiveAlert>,
  nowMs: number,
  maxFreshnessMs: number = MONITORING_THRESHOLDS.quotaPressure.freshnessMaxAgeMs
): PreventiveAlert[] {
  const T = MONITORING_THRESHOLDS.quotaPressure;
  const sub = snap.subscription;
  const alerts: PreventiveAlert[] = [];

  const evalWindow = (params: {
    id: string;
    category: string;
    windowId: string;
    usedPercent?: number;
    remainingPercent?: number;
    resetsAtMs?: number;
    observedAtMs?: number;
    ageMs?: number;
    resetPassed: boolean;
    isCached: boolean;
    freshnessLimitMs: number;
  }): PreventiveAlert => {
    const base = {
      id: params.id,
      ruleId: 'quota_pressure' as const,
      provider: snap.provider,
      scope: 'account' as const,
      quotaCategory: params.category,
      quotaWindowId: params.windowId,
    };
    const commonEvidence: Record<string, number | string | boolean> = {
      quotaCategory: params.category,
      quotaWindowId: params.windowId,
      isCached: params.isCached,
      freshnessLimitMs: params.freshnessLimitMs,
      ...(params.usedPercent !== undefined ? { usedPercent: params.usedPercent } : {}),
      ...(params.remainingPercent !== undefined ? { remainingPercent: params.remainingPercent } : {}),
      ...(params.observedAtMs !== undefined ? { observedAtMs: params.observedAtMs } : {}),
      ...(params.ageMs !== undefined ? { ageMs: params.ageMs } : {}),
      ...(params.resetsAtMs !== undefined ? { resetsAtMs: params.resetsAtMs } : {}),
    };

    if (params.resetPassed) {
      return notEvaluableAlert(
        base,
        nowMs,
        'expired_reset',
        'reset_passed_without_observation',
        `Quota window ${params.category}/${params.windowId} passed its reset timestamp without a newer observation.`,
        commonEvidence
      );
    }
    if (params.ageMs === undefined || params.ageMs > params.freshnessLimitMs) {
      return notEvaluableAlert(
        base,
        nowMs,
        'stale',
        'quota_stale',
        `Quota window ${params.category}/${params.windowId} observation exceeds the informational freshness window (${Math.round(params.freshnessLimitMs / 60_000)} min).`,
        commonEvidence
      );
    }
    if (params.usedPercent === undefined) {
      return notEvaluableAlert(
        base,
        nowMs,
        'unavailable',
        'quota_value_missing',
        `Quota utilization percentage is missing for ${params.category}/${params.windowId}.`,
        commonEvidence
      );
    }

    const used = params.usedPercent;
    const tr = resolveTransition({
      prev: prevById.get(params.id),
      meetsCrit: used >= T.criticalPct,
      meetsWarn: used >= T.warningPct,
      staysCrit: used >= T.deescalateCriticalPct,
      staysWarn: used >= T.resolvePct,
      nowMs,
    });
    const threshold = tr.severity === 'critical' ? T.criticalPct : T.warningPct;

    return {
      ...base,
      ...tr,
      observedValue: used,
      threshold,
      unit: 'percent',
      updatedAtMs: nowMs,
      evidence: commonEvidence,
      coverage: { evaluable: true, status: params.isCached ? 'cached' : 'observed' },
      summary:
        tr.state === 'active'
          ? `Observed ${params.isCached ? 'cached ' : ''}quota utilization for ${params.category}/${params.windowId} is ${fmtPct(used)}.`
          : `Observed ${params.isCached ? 'cached ' : ''}quota utilization for ${params.category}/${params.windowId} is ${fmtPct(used)}, below threshold.`,
    };
  };

  if (snap.provider === 'codex') {
    for (const cat of sub.categories ?? []) {
      for (const w of cat.windows) {
        alerts.push(
          evalWindow({
            id: `codex:account:quota_pressure:${cat.categoryKey}:${w.windowId}`,
            category: cat.categoryKey,
            windowId: w.windowId,
            usedPercent: w.usedPercent,
            remainingPercent: w.remainingPercent,
            resetsAtMs: w.resetsAtMs,
            observedAtMs: w.lastObservedAtMs,
            ageMs: w.ageMs,
            resetPassed: w.resetPassedWithoutNewObservation,
            isCached: false,
            freshnessLimitMs: maxFreshnessMs,
          })
        );
      }
    }
  } else if (sub.cached) {
    const limitMs = Math.min(maxFreshnessMs, sub.cached.staleThresholdMs);
    for (const w of sub.cached.windows) {
      alerts.push(
        evalWindow({
          id: `claude:account:quota_pressure:${w.windowId}`,
          category: 'claude:cached_utilization',
          windowId: w.windowId,
          usedPercent: w.usedPercent,
          remainingPercent: w.remainingPercent,
          resetsAtMs: w.resetsAtMs,
          observedAtMs: sub.cached.fetchedAtMs,
          ageMs: sub.cached.ageMs,
          resetPassed: w.resetPassedWithoutNewObservation,
          isCached: true,
          freshnessLimitMs: limitMs,
        })
      );
    }
  }

  if (alerts.length === 0) {
    alerts.push(
      notEvaluableAlert(
        {
          id: `${snap.provider}:account:quota_pressure:none`,
          ruleId: 'quota_pressure',
          provider: snap.provider,
          scope: 'account',
        },
        nowMs,
        'unavailable',
        'quota_unavailable',
        `No usable subscription quota observation is available for ${snap.provider}.`
      )
    );
  }

  return alerts;
}

/** Pure evaluation of all six preventive rules for a single provider snapshot. */
export function evaluateProviderRules(
  snap: ProviderObservatorySnapshot,
  prevById: ReadonlyMap<string, PreventiveAlert>,
  nowMs: number = snap.updatedAtMs,
  maxQuotaFreshnessMs: number = MONITORING_THRESHOLDS.quotaPressure.freshnessMaxAgeMs
): PreventiveAlert[] {
  const sessionAlerts: PreventiveAlert[] = snap.identity.sessionId
    ? [
        evaluateContextPressure(snap, prevById.get(`${snap.provider}:session:context_pressure`), nowMs),
        evaluateContextGrowth(snap, prevById.get(`${snap.provider}:session:context_growth`), nowMs),
        evaluateRepeatedContextProcessing(
          snap,
          prevById.get(`${snap.provider}:session:repeated_context_processing`),
          nowMs
        ),
        evaluateAgenticIntensity(snap, prevById.get(`${snap.provider}:session:agentic_intensity`), nowMs),
        evaluateConsumptionAcceleration(
          snap,
          prevById.get(`${snap.provider}:session:consumption_acceleration`),
          nowMs
        ),
      ]
    : [];

  const accountAlerts = evaluateQuotaPressure(snap, prevById, nowMs, maxQuotaFreshnessMs);
  return [...sessionAlerts, ...accountAlerts];
}
