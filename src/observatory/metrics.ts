import { asNum, asObj, asStr, type JsonObject, type ProviderId } from '../acquisition/types.js';
import type {
  InferenceRecord,
  NormalizedTokens,
  SentraState,
  SessionRecord,
  TurnRecord,
  UsageSnapshotRecord,
} from '../core/model.js';
import type { SelectionReason, SessionCandidate, SessionSelection } from '../core/session-monitor.js';

export const BURN_RATE_WINDOW_MS = 5 * 60 * 1000;
export const DEFAULT_CLAUDE_QUOTA_STALE_MS = 15 * 60 * 1000;
const MAX_QUOTA_TREND_POINTS = 50;
const RUNTIME_ACTIVITY_WINDOW_MS = 5 * 60 * 1000;

export type ProviderMonitorStatus =
  | 'initializing'
  | 'active'
  | 'runtime_idle'
  | 'recent'
  | 'idle'
  | 'no_session'
  | 'unavailable'
  | 'error';

export type ActivityEvidence = 'runtime_process' | 'recent_transcript' | 'historical_fallback' | 'none';
export type CoverageLevel = 'complete' | 'partial' | 'snapshot_only' | 'unavailable';
export type QuotaFreshness = 'observed' | 'cached' | 'stale' | 'expired_reset' | 'unavailable';

export interface ProviderIdentity {
  provider: ProviderId;
  status: ProviderMonitorStatus;
  activityEvidence: ActivityEvidence;
  runtimePresent: boolean;
  sessionId?: string;
  nativeSessionId?: string;
  workspace?: string;
  currentModel?: string;
  modelsObserved: string[];
  startedAtMs?: number;
  lastActivityAtMs?: number;
  selectionReason: SelectionReason;
  ambiguous: boolean;
  candidateCount: number;
  candidates: SessionCandidate[];
  runtimePid?: number;
  runtimeStatus?: string;
  lastError?: string;
}

export interface DataCoverage {
  level: CoverageLevel;
  sourceKind: 'inferences' | 'usage_snapshot' | 'both' | 'none';
  inferencesTotal: number;
  inferencesWithPartialTokens: number;
  inferencesWithConflicts: number;
  inferencesWithApiError: number;
  inferencesMissingTimestamp: number;
  hasSnapshotDiscrepancy: boolean;
  notes: string[];
}

export interface TokenTotals {
  totalInputTokens?: number;
  uncachedInputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  cacheHitRatio?: number;
  inferenceCount: number;
  partialCount: number;
  isPartial: boolean;
}

export interface HarnessUsageSnapshot {
  kind: 'codex_token_count' | 'claude_cost_state';
  timestampMs?: number;
  lastTokens?: NormalizedTokens;
  totalTokens?: NormalizedTokens;
  modelContextWindow?: number;
  totalCostUSD?: number;
  modelUsage?: JsonObject;
}

export interface CumulativeUsage {
  direct: TokenTotals;
  subagents: TokenTotals;
  total: TokenTotals;
  byModel: Record<string, TokenTotals>;
  harnessSnapshot?: HarnessUsageSnapshot;
}

export interface SubagentUsageSummary {
  sessionId: string;
  agentId?: string;
  agentType?: string;
  primaryModel?: string;
  modelsObserved: string[];
  startedAtMs?: number;
  lastActivityAtMs?: number;
  tokens: TokenTotals;
}

export interface AgenticMetrics {
  directInferenceCount: number;
  totalInferenceCount: number;
  userTurnCount?: number;
  inferencesInLatestTurn?: number;
  avgInferencesPerTurn?: number;
  avgInputTokensPerInference?: number;
  maxInputTokensPerInference?: number;
  subagentCount: number;
  subagents: SubagentUsageSummary[];
}

export interface ContextPoint {
  inferenceId: string;
  timestampMs?: number;
  totalInputTokens?: number;
  cacheReadTokens?: number;
  model?: string;
  turnId?: string;
  cumulativeTotalTokens?: number;
  isAggregatedServerSide?: boolean;
}

export interface CompactionMarker {
  eventId: string;
  timestampMs?: number;
  afterInferenceIndex: number;
  preTokens?: number;
  postTokens?: number;
  trigger?: string;
  windowNumber?: number;
}

export interface ContextEvolution {
  series: ContextPoint[];
  compactions: CompactionMarker[];
  currentContextTokens?: number;
  currentContextTimestampMs?: number;
  isCurrentContextFromLatestInference: boolean;
  contextWindowTokens?: number;
  contextOccupancyPercent?: number;
}

export interface BurnRateMetrics {
  windowMinutes: 5;
  evaluatedAtMs: number;
  scope: 'session_total';
  inputTokensPerMin?: number;
  cacheReadTokensPerMin?: number;
  cacheWriteTokensPerMin?: number;
  outputTokensPerMin?: number;
  inferencesPerMin?: number;
  inferencesInWindow: number;
  windowCoverage: 'full' | 'partial' | 'unavailable';
  missingTimestampCount: number;
}

export interface QuotaWindowState {
  windowId: string;
  usedPercent?: number;
  remainingPercent?: number;
  windowMinutes?: number;
  resetsAtMs?: number;
  lastObservedAtMs?: number;
  ageMs?: number;
  resetPassedWithoutNewObservation: boolean;
  severity?: string;
  scope?: string;
  group?: string;
  isActive?: boolean;
}

export interface QuotaTrendPoint {
  firstObservedAtMs?: number;
  lastObservedAtMs?: number;
  observationCount: number;
  windows: Array<{ windowId: string; usedPercent?: number; resetsAtMs?: number }>;
}

export interface CodexQuotaCategory {
  categoryKey: string;
  limitId?: string;
  limitName?: string;
  planType?: string;
  windows: QuotaWindowState[];
  spendControlReached?: boolean;
  rateLimitReachedType?: string;
  recentTrend: QuotaTrendPoint[];
}

export interface ClaudeCachedQuota {
  isCached: true;
  isVerifiedRealTime: false;
  fetchedAtMs?: number;
  ageMs?: number;
  staleThresholdMs: number;
  isStale: boolean;
  windows: QuotaWindowState[];
  spend?: { percent?: number; severity?: string; enabled?: boolean };
  extraUsage?: { isEnabled?: boolean; spendLimitReached?: boolean; utilization?: number };
}

export interface ClaudeRateLimitStatus {
  status?: string;
  rateLimitType?: string;
  resetsAtMs?: number;
  overageStatus?: string;
  isUsingOverage?: boolean;
  lastObservedAtMs?: number;
  ageMs?: number;
  resetPassedWithoutNewObservation: boolean;
}

export interface SubscriptionUsage {
  provider: ProviderId;
  scope: 'provider_account';
  freshness: QuotaFreshness;
  categories?: CodexQuotaCategory[];
  cached?: ClaudeCachedQuota;
  rateLimitStatus?: ClaudeRateLimitStatus;
}

export interface ProviderObservatorySnapshot {
  provider: ProviderId;
  updatedAtMs: number;
  identity: ProviderIdentity;
  coverage: DataCoverage;
  usage: CumulativeUsage;
  agentic: AgenticMetrics;
  context: ContextEvolution;
  burnRate: BurnRateMetrics;
  subscription: SubscriptionUsage;
}

export interface ObservatorySnapshot {
  updatedAtMs: number;
  workspace?: string;
  providers: Record<ProviderId, ProviderObservatorySnapshot>;
}

export interface MetricsOptions {
  providerAvailable?: boolean;
  claudeQuotaStaleMs?: number;
  lastError?: string;
}

const TOKEN_SUM_FIELDS = [
  'totalInputTokens', 'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens',
  'outputTokens', 'reasoningTokens', 'totalTokens',
] as const;

export function toEpochMs(ts: string | number | undefined): number | undefined {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  if (typeof ts === 'string') {
    const ms = Date.parse(ts);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

function normalizeResetTsMs(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 0 && raw < 1e12 ? raw * 1000 : raw;
  }
  if (typeof raw === 'string') return toEpochMs(raw);
  return undefined;
}

function positionLine(inf: InferenceRecord): number {
  return inf.position.kind === 'byte_range' || inf.position.kind === 'logical_line'
    ? inf.position.lineNumber
    : 0;
}

function compareInferences(a: InferenceRecord, b: InferenceRecord): number {
  const ta = toEpochMs(a.timestamp);
  const tb = toEpochMs(b.timestamp);
  if (ta !== undefined && tb !== undefined && ta !== tb) return ta - tb;
  if (ta !== undefined && tb === undefined) return -1;
  if (ta === undefined && tb !== undefined) return 1;
  const la = positionLine(a);
  const lb = positionLine(b);
  if (la !== lb) return la - lb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function emptyTokenTotals(): TokenTotals {
  return { inferenceCount: 0, partialCount: 0, isPartial: false };
}

/** Aggregates normalized tokens preserving `undefined` vs `0` and flagging partial coverage. */
export function aggregateTokens(inferences: ReadonlyArray<InferenceRecord>): TokenTotals {
  if (inferences.length === 0) return emptyTokenTotals();

  const sums: Partial<Record<(typeof TOKEN_SUM_FIELDS)[number], number>> = {};
  const counts: Partial<Record<(typeof TOKEN_SUM_FIELDS)[number], number>> = {};
  let partialCount = 0;
  let ratioRead = 0;
  let ratioInput = 0;

  for (const inf of inferences) {
    const t = inf.tokens;
    if (t.provenance === 'partial' || t.totalInputTokens === undefined || t.outputTokens === undefined) {
      partialCount += 1;
    }
    for (const f of TOKEN_SUM_FIELDS) {
      const v = t[f];
      if (v !== undefined) {
        sums[f] = (sums[f] ?? 0) + v;
        counts[f] = (counts[f] ?? 0) + 1;
      }
    }
    if (t.cacheReadTokens !== undefined && t.totalInputTokens !== undefined) {
      ratioRead += t.cacheReadTokens;
      ratioInput += t.totalInputTokens;
    }
  }

  let hasMixedFields = false;
  for (const f of TOKEN_SUM_FIELDS) {
    const c = counts[f] ?? 0;
    if (c > 0 && c < inferences.length) hasMixedFields = true;
  }

  const out: TokenTotals = {
    inferenceCount: inferences.length,
    partialCount,
    isPartial: partialCount > 0 || hasMixedFields,
  };
  for (const f of TOKEN_SUM_FIELDS) {
    if ((counts[f] ?? 0) > 0) out[f] = sums[f];
  }
  if (ratioInput > 0) out.cacheHitRatio = ratioRead / ratioInput;
  return out;
}

function collectSessionInferences(
  state: SentraState,
  primarySession?: SessionRecord
): {
  direct: InferenceRecord[];
  subagents: InferenceRecord[];
  total: InferenceRecord[];
  subagentSessions: SessionRecord[];
} {
  if (!primarySession) return { direct: [], subagents: [], total: [], subagentSessions: [] };

  const directIds = new Set<string>();
  const direct: InferenceRecord[] = [];
  for (const id of primarySession.directInferenceIds) {
    const inf = state.inferences[id];
    if (inf && !directIds.has(inf.id)) {
      directIds.add(inf.id);
      direct.push(inf);
    }
  }

  const subagentSessions = Object.values(state.sessions)
    .filter((s) => s.isSubagent && (s.parentSessionId === primarySession.id || primarySession.childSessionIds.includes(s.id)))
    .sort((a, b) => {
      const ta = toEpochMs(a.startedAt) ?? Number.MAX_SAFE_INTEGER;
      const tb = toEpochMs(b.startedAt) ?? Number.MAX_SAFE_INTEGER;
      return ta !== tb ? ta - tb : a.id.localeCompare(b.id);
    });

  const subIds = new Set<string>();
  const subagents: InferenceRecord[] = [];
  for (const sub of subagentSessions) {
    for (const id of sub.directInferenceIds) {
      const inf = state.inferences[id];
      if (inf && !directIds.has(inf.id) && !subIds.has(inf.id)) {
        subIds.add(inf.id);
        subagents.push(inf);
      }
    }
  }

  return { direct, subagents, total: [...direct, ...subagents], subagentSessions };
}

function resolveTurnAssignments(
  primarySession: SessionRecord | undefined,
  directSorted: ReadonlyArray<InferenceRecord>,
  state: SentraState
): {
  turns: TurnRecord[];
  turnByInfId: Map<string, string>;
  countByTurnId: Map<string, number>;
} {
  if (!primarySession) return { turns: [], turnByInfId: new Map(), countByTurnId: new Map() };

  const turns = Object.values(state.turns)
    .filter((t) => t.sessionId === primarySession.id)
    .sort((a, b) => {
      const ta = toEpochMs(a.startedAt) ?? Number.MAX_SAFE_INTEGER;
      const tb = toEpochMs(b.startedAt) ?? Number.MAX_SAFE_INTEGER;
      return ta !== tb ? ta - tb : a.id.localeCompare(b.id);
    });

  const turnByInfId = new Map<string, string>();
  const countByTurnId = new Map<string, number>();
  if (turns.length === 0) return { turns, turnByInfId, countByTurnId };

  const validTurnIds = new Set(turns.map((t) => t.id));
  const turnStarts = turns
    .map((t) => ({ id: t.id, startMs: toEpochMs(t.startedAt) }))
    .filter((t): t is { id: string; startMs: number } => t.startMs !== undefined);

  // Two-pointer O(N + T) chronological enclosure since both `directSorted` and `turnStarts` are ascending.
  let turnPtr = -1;
  for (const inf of directSorted) {
    let tid = inf.turnId && validTurnIds.has(inf.turnId) ? inf.turnId : undefined;
    if (!tid && turnStarts.length > 0) {
      const infMs = toEpochMs(inf.timestamp);
      if (infMs !== undefined) {
        while (turnPtr + 1 < turnStarts.length && turnStarts[turnPtr + 1]!.startMs <= infMs) {
          turnPtr += 1;
        }
        if (turnPtr >= 0) tid = turnStarts[turnPtr]!.id;
      }
    }
    if (tid) {
      turnByInfId.set(inf.id, tid);
      countByTurnId.set(tid, (countByTurnId.get(tid) ?? 0) + 1);
    }
  }

  return { turns, turnByInfId, countByTurnId };
}

function findPrimaryHarnessSnapshot(
  provider: ProviderId,
  state: SentraState,
  primarySession?: SessionRecord
): UsageSnapshotRecord | undefined {
  if (!primarySession) return undefined;
  const directKey =
    provider === 'codex' ? `codex:snap:${primarySession.id}` : `claude:cost:${primarySession.id}`;
  if (state.usageSnapshots[directKey]) return state.usageSnapshots[directKey];
  return Object.values(state.usageSnapshots).find(
    (s) => s.provider === provider && s.sessionId === primarySession.id
  );
}

function sumClaudeCostModelUsageTokens(modelUsage?: JsonObject): number | undefined {
  if (!modelUsage) return undefined;
  const entries = Object.values(modelUsage);
  if (entries.length === 0) return undefined;
  let sum = 0;
  let found = false;
  for (const item of entries) {
    const obj = asObj(item);
    if (!obj) return undefined;
    const inp = asNum(obj.inputTokens);
    const out = asNum(obj.outputTokens);
    if (inp === undefined || out === undefined) return undefined;
    sum += inp + (asNum(obj.cacheReadInputTokens) ?? 0) + (asNum(obj.cacheCreationInputTokens) ?? 0) + out;
    found = true;
  }
  return found ? sum : undefined;
}

function buildContextEvolution(
  provider: ProviderId,
  state: SentraState,
  primarySession: SessionRecord | undefined,
  directSorted: ReadonlyArray<InferenceRecord>,
  turnByInfId: Map<string, string>,
  harnessSnap: UsageSnapshotRecord | undefined
): { context: ContextEvolution; hasAggregatedServerSide: boolean } {
  const series: ContextPoint[] = [];
  let cumulativeTotal: number | undefined;
  let hasAggregatedServerSide = false;
  let lastValidContextIdx = -1;
  let observedWindow: number | undefined =
    provider === 'codex' ? harnessSnap?.modelContextWindow : undefined;

  for (let i = 0; i < directSorted.length; i += 1) {
    const inf = directSorted[i]!;
    const tsMs = toEpochMs(inf.timestamp);
    if (inf.tokens.totalTokens !== undefined) {
      cumulativeTotal = (cumulativeTotal ?? 0) + inf.tokens.totalTokens;
    }
    if (provider === 'codex' && inf.tokens.contextWindow !== undefined) {
      observedWindow = inf.tokens.contextWindow;
    }

    const iterations = inf.nativeUsage.iterations;
    const isAgg = Array.isArray(iterations) && iterations.length > 1;
    if (isAgg) hasAggregatedServerSide = true;

    const singleInput = isAgg ? undefined : inf.tokens.totalInputTokens;
    const singleCacheRead = isAgg ? undefined : inf.tokens.cacheReadTokens;
    if (singleInput !== undefined) lastValidContextIdx = i;

    series.push({
      inferenceId: inf.id,
      ...(tsMs !== undefined ? { timestampMs: tsMs } : {}),
      ...(singleInput !== undefined ? { totalInputTokens: singleInput } : {}),
      ...(singleCacheRead !== undefined ? { cacheReadTokens: singleCacheRead } : {}),
      ...(inf.model !== undefined ? { model: inf.model } : {}),
      ...(turnByInfId.get(inf.id) !== undefined ? { turnId: turnByInfId.get(inf.id) } : {}),
      ...(cumulativeTotal !== undefined ? { cumulativeTotalTokens: cumulativeTotal } : {}),
      ...(isAgg ? { isAggregatedServerSide: true } : {}),
    });
  }

  const compactions: CompactionMarker[] = primarySession
    ? Object.values(state.lifecycleEvents)
        .filter((ev) => ev.kind === 'compaction' && ev.sessionId === primarySession.id)
        .sort((a, b) => (toEpochMs(a.timestamp) ?? 0) - (toEpochMs(b.timestamp) ?? 0))
        .map((ev) => {
          const tsMs = toEpochMs(ev.timestamp);
          let afterIdx = -1;
          if (tsMs !== undefined) {
            for (let i = 0; i < series.length; i += 1) {
              const ptTs = series[i]!.timestampMs;
              if (ptTs !== undefined && ptTs <= tsMs) afterIdx = i;
            }
          }
          const cm = asObj(ev.details.compactMetadata);
          const preTokens = asNum(cm?.preTokens);
          const postTokens = asNum(cm?.postTokens);
          const trigger = asStr(cm?.trigger);
          const windowNumber = asNum(ev.details.window_number);
          return {
            eventId: ev.id,
            ...(tsMs !== undefined ? { timestampMs: tsMs } : {}),
            afterInferenceIndex: afterIdx,
            ...(preTokens !== undefined ? { preTokens } : {}),
            ...(postTokens !== undefined ? { postTokens } : {}),
            ...(trigger !== undefined ? { trigger } : {}),
            ...(windowNumber !== undefined ? { windowNumber } : {}),
          };
        })
    : [];

  const validPt = lastValidContextIdx >= 0 ? series[lastValidContextIdx] : undefined;
  const currentContextTokens = validPt?.totalInputTokens;
  const currentContextTimestampMs = validPt?.timestampMs;
  const isCurrentContextFromLatestInference = series.length > 0 && lastValidContextIdx === series.length - 1;

  // Never use a static context-window lookup map for Claude Code.
  const contextWindowTokens = provider === 'codex' ? observedWindow : undefined;
  const contextOccupancyPercent =
    currentContextTokens !== undefined && contextWindowTokens !== undefined && contextWindowTokens > 0
      ? (currentContextTokens / contextWindowTokens) * 100
      : undefined;

  return {
    hasAggregatedServerSide,
    context: {
      series,
      compactions,
      ...(currentContextTokens !== undefined ? { currentContextTokens } : {}),
      ...(currentContextTimestampMs !== undefined ? { currentContextTimestampMs } : {}),
      isCurrentContextFromLatestInference,
      ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
      ...(contextOccupancyPercent !== undefined ? { contextOccupancyPercent } : {}),
    },
  };
}

/** Deterministic 5-minute rolling burn rate over deduplicated session-wide inferences. */
export function computeBurnRate(
  inferences: ReadonlyArray<InferenceRecord>,
  startedAtMs: number | undefined,
  nowMs: number
): BurnRateMetrics {
  const windowMinutes = 5 as const;
  const withTs: Array<{ inf: InferenceRecord; ts: number }> = [];
  let missingTimestampCount = 0;

  let sessionHasInput = false;
  let sessionHasCacheRead = false;
  let sessionHasCacheWrite = false;
  let sessionHasOutput = false;

  for (const inf of inferences) {
    if (inf.tokens.totalInputTokens !== undefined) sessionHasInput = true;
    if (inf.tokens.cacheReadTokens !== undefined) sessionHasCacheRead = true;
    if (inf.tokens.cacheWriteTokens !== undefined) sessionHasCacheWrite = true;
    if (inf.tokens.outputTokens !== undefined) sessionHasOutput = true;
    const ts = toEpochMs(inf.timestamp);
    if (ts !== undefined) withTs.push({ inf, ts });
    else missingTimestampCount += 1;
  }

  // Never represent an uncomputable burn rate as 0.
  if (withTs.length === 0) {
    return {
      windowMinutes,
      evaluatedAtMs: nowMs,
      scope: 'session_total',
      inferencesInWindow: 0,
      windowCoverage: 'unavailable',
      missingTimestampCount,
    };
  }

  const cutoff = nowMs - BURN_RATE_WINDOW_MS;
  const inWindow = withTs.filter((x) => x.ts > cutoff && x.ts <= nowMs);

  let sumInput = 0, cntInput = 0;
  let sumRead = 0, cntRead = 0;
  let sumWrite = 0, cntWrite = 0;
  let sumOut = 0, cntOut = 0;
  let windowPartialTokens = false;

  for (const { inf } of inWindow) {
    const t = inf.tokens;
    if (t.totalInputTokens !== undefined) { sumInput += t.totalInputTokens; cntInput += 1; } else windowPartialTokens = true;
    if (t.cacheReadTokens !== undefined) { sumRead += t.cacheReadTokens; cntRead += 1; }
    if (t.cacheWriteTokens !== undefined) { sumWrite += t.cacheWriteTokens; cntWrite += 1; }
    if (t.outputTokens !== undefined) { sumOut += t.outputTokens; cntOut += 1; } else windowPartialTokens = true;
  }
  if (
    (cntRead > 0 && cntRead < inWindow.length) ||
    (cntWrite > 0 && cntWrite < inWindow.length)
  ) {
    windowPartialTokens = true;
  }

  const shortSession = startedAtMs !== undefined && nowMs - startedAtMs < BURN_RATE_WINDOW_MS;
  const windowCoverage: BurnRateMetrics['windowCoverage'] =
    shortSession || missingTimestampCount > 0 || windowPartialTokens ? 'partial' : 'full';

  if (inWindow.length === 0) {
    // Observed inactivity: rates for observed counters decay cleanly to 0; unobserved counters stay undefined.
    return {
      windowMinutes,
      evaluatedAtMs: nowMs,
      scope: 'session_total',
      ...(sessionHasInput ? { inputTokensPerMin: 0 } : {}),
      ...(sessionHasCacheRead ? { cacheReadTokensPerMin: 0 } : {}),
      ...(sessionHasCacheWrite ? { cacheWriteTokensPerMin: 0 } : {}),
      ...(sessionHasOutput ? { outputTokensPerMin: 0 } : {}),
      inferencesPerMin: 0,
      inferencesInWindow: 0,
      windowCoverage,
      missingTimestampCount,
    };
  }

  return {
    windowMinutes,
    evaluatedAtMs: nowMs,
    scope: 'session_total',
    ...(cntInput > 0 ? { inputTokensPerMin: sumInput / windowMinutes } : {}),
    ...(cntRead > 0 ? { cacheReadTokensPerMin: sumRead / windowMinutes } : {}),
    ...(cntWrite > 0 ? { cacheWriteTokensPerMin: sumWrite / windowMinutes } : {}),
    ...(cntOut > 0 ? { outputTokensPerMin: sumOut / windowMinutes } : {}),
    inferencesPerMin: inWindow.length / windowMinutes,
    inferencesInWindow: inWindow.length,
    windowCoverage,
    missingTimestampCount,
  };
}

function deriveRemainingPercent(used?: number): number | undefined {
  return used !== undefined && used >= 0 && used <= 100 ? Math.max(0, 100 - used) : undefined;
}

function makeQuotaWindow(
  windowId: string,
  opts: {
    usedPercent?: number;
    windowMinutes?: number;
    resetsAtMs?: number;
    lastObservedAtMs?: number;
    nowMs: number;
    severity?: string;
    scope?: string;
    group?: string;
    isActive?: boolean;
  }
): QuotaWindowState {
  const remainingPercent = deriveRemainingPercent(opts.usedPercent);
  const ageMs = opts.lastObservedAtMs !== undefined ? Math.max(0, opts.nowMs - opts.lastObservedAtMs) : undefined;
  const resetPassedWithoutNewObservation =
    opts.resetsAtMs !== undefined &&
    opts.nowMs >= opts.resetsAtMs &&
    (opts.lastObservedAtMs === undefined || opts.lastObservedAtMs < opts.resetsAtMs);

  return {
    windowId,
    ...(opts.usedPercent !== undefined ? { usedPercent: opts.usedPercent } : {}),
    ...(remainingPercent !== undefined ? { remainingPercent } : {}),
    ...(opts.windowMinutes !== undefined ? { windowMinutes: opts.windowMinutes } : {}),
    ...(opts.resetsAtMs !== undefined ? { resetsAtMs: opts.resetsAtMs } : {}),
    ...(opts.lastObservedAtMs !== undefined ? { lastObservedAtMs: opts.lastObservedAtMs } : {}),
    ...(ageMs !== undefined ? { ageMs } : {}),
    resetPassedWithoutNewObservation,
    ...(opts.severity !== undefined ? { severity: opts.severity } : {}),
    ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
    ...(opts.group !== undefined ? { group: opts.group } : {}),
    ...(opts.isActive !== undefined ? { isActive: opts.isActive } : {}),
  };
}

/** Computes provider/account-scoped subscription usage without attributing it to any session. */
export function computeSubscriptionUsage(
  provider: ProviderId,
  state: SentraState,
  nowMs: number,
  staleThresholdMs: number = DEFAULT_CLAUDE_QUOTA_STALE_MS
): SubscriptionUsage {
  if (provider === 'codex') {
    const entries = Object.values(state.latestQuotaByCategory)
      .filter((q) => q.provider === 'codex')
      .sort((a, b) => a.categoryKey.localeCompare(b.categoryKey));

    if (entries.length === 0) {
      return { provider: 'codex', scope: 'provider_account', freshness: 'unavailable', categories: [] };
    }

    let anyExpiredReset = false;
    const categories: CodexQuotaCategory[] = entries.map((q) => {
      const lastObservedAtMs = toEpochMs(q.lastObservedAt ?? q.firstObservedAt);
      const windows: QuotaWindowState[] = [];
      for (const winKey of ['primary', 'secondary'] as const) {
        const raw = asObj(q.windows[winKey]);
        if (!raw) continue;
        const w = makeQuotaWindow(winKey, {
          usedPercent: asNum(raw.used_percent),
          windowMinutes: asNum(raw.window_minutes),
          resetsAtMs: normalizeResetTsMs(raw.resets_at),
          lastObservedAtMs,
          nowMs,
        });
        if (w.resetPassedWithoutNewObservation) anyExpiredReset = true;
        windows.push(w);
      }

      const recentTrend: QuotaTrendPoint[] = state.quotaSnapshots
        .filter((s) => s.provider === 'codex' && s.categoryKey === q.categoryKey)
        .slice(-MAX_QUOTA_TREND_POINTS)
        .map((s) => {
          const pts: QuotaTrendPoint['windows'] = [];
          for (const winKey of ['primary', 'secondary'] as const) {
            const raw = asObj(s.windows[winKey]);
            if (!raw) continue;
            const usedPercent = asNum(raw.used_percent);
            const resetsAtMs = normalizeResetTsMs(raw.resets_at);
            pts.push({
              windowId: winKey,
              ...(usedPercent !== undefined ? { usedPercent } : {}),
              ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
            });
          }
          const firstObservedAtMs = toEpochMs(s.firstObservedAt);
          const lastObsMs = toEpochMs(s.lastObservedAt);
          return {
            ...(firstObservedAtMs !== undefined ? { firstObservedAtMs } : {}),
            ...(lastObsMs !== undefined ? { lastObservedAtMs: lastObsMs } : {}),
            observationCount: s.observationCount,
            windows: pts,
          };
        });

      const spendControlReached = typeof q.windows.spend_control_reached === 'boolean' ? q.windows.spend_control_reached : undefined;
      const rateLimitReachedType = asStr(q.windows.rate_limit_reached_type);

      return {
        categoryKey: q.categoryKey,
        ...(q.limitId !== undefined ? { limitId: q.limitId } : {}),
        ...(q.limitName !== undefined ? { limitName: q.limitName } : {}),
        ...(q.planType !== undefined ? { planType: q.planType } : {}),
        windows,
        ...(spendControlReached !== undefined ? { spendControlReached } : {}),
        ...(rateLimitReachedType !== undefined ? { rateLimitReachedType } : {}),
        recentTrend,
      };
    });

    return {
      provider: 'codex',
      scope: 'provider_account',
      freshness: anyExpiredReset ? 'expired_reset' : 'observed',
      categories,
    };
  }

  // Claude Code: passive cachedUsageUtilization + observed quotaLimits warnings.
  const cachedSnap = state.latestQuotaByCategory['claude:cached_utilization'];
  const limitSnap = state.latestQuotaByCategory['claude:quota_limits'];
  let anyExpiredReset = false;

  let cached: ClaudeCachedQuota | undefined;
  if (cachedSnap) {
    const fetchedAtMs = toEpochMs(cachedSnap.lastObservedAt ?? cachedSnap.firstObservedAt);
    const ageMs = fetchedAtMs !== undefined ? Math.max(0, nowMs - fetchedAtMs) : undefined;
    const windows: QuotaWindowState[] = [];

    for (const key of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'] as const) {
      const wObj = asObj(cachedSnap.windows[key]);
      if (!wObj) continue;
      const used = asNum(wObj.utilization) ?? asNum(wObj.percent);
      const resetsAtMs = normalizeResetTsMs(wObj.resets_at);
      if (used === undefined && resetsAtMs === undefined) continue;
      const win = makeQuotaWindow(key, {
        usedPercent: used,
        resetsAtMs,
        lastObservedAtMs: fetchedAtMs,
        nowMs,
      });
      if (win.resetPassedWithoutNewObservation) anyExpiredReset = true;
      windows.push(win);
    }

    if (Array.isArray(cachedSnap.windows.limits)) {
      cachedSnap.windows.limits.forEach((rawItem, idx) => {
        const item = asObj(rawItem);
        if (!item) return;
        const kind = asStr(item.kind) ?? `limit_${idx}`;
        const scope = asStr(item.scope);
        const group = asStr(item.group);
        const winId = [kind, group, scope].filter(Boolean).join(':');
        const win = makeQuotaWindow(winId || `limit_${idx}`, {
          usedPercent: asNum(item.percent) ?? asNum(item.utilization),
          resetsAtMs: normalizeResetTsMs(item.resets_at),
          lastObservedAtMs: fetchedAtMs,
          nowMs,
          severity: asStr(item.severity),
          scope,
          group,
          isActive: typeof item.is_active === 'boolean' ? item.is_active : undefined,
        });
        if (win.resetPassedWithoutNewObservation) anyExpiredReset = true;
        windows.push(win);
      });
    }

    const spendObj = asObj(cachedSnap.windows.spend);
    const spend = spendObj
      ? {
          ...(asNum(spendObj.percent) !== undefined ? { percent: asNum(spendObj.percent) } : {}),
          ...(asStr(spendObj.severity) !== undefined ? { severity: asStr(spendObj.severity) } : {}),
          ...(typeof spendObj.enabled === 'boolean' ? { enabled: spendObj.enabled } : {}),
        }
      : undefined;

    const extraObj = asObj(cachedSnap.windows.extra_usage);
    const extraUsage = extraObj
      ? {
          ...(typeof extraObj.is_enabled === 'boolean' ? { isEnabled: extraObj.is_enabled } : {}),
          ...(typeof extraObj.spend_limit_reached === 'boolean'
            ? { spendLimitReached: extraObj.spend_limit_reached }
            : {}),
          ...(asNum(extraObj.utilization) !== undefined ? { utilization: asNum(extraObj.utilization) } : {}),
        }
      : undefined;

    const isStale = (ageMs !== undefined && ageMs > staleThresholdMs) || anyExpiredReset;
    cached = {
      isCached: true,
      isVerifiedRealTime: false,
      ...(fetchedAtMs !== undefined ? { fetchedAtMs } : {}),
      ...(ageMs !== undefined ? { ageMs } : {}),
      staleThresholdMs,
      isStale,
      windows,
      ...(spend && Object.keys(spend).length > 0 ? { spend } : {}),
      ...(extraUsage && Object.keys(extraUsage).length > 0 ? { extraUsage } : {}),
    };
  }

  let rateLimitStatus: ClaudeRateLimitStatus | undefined;
  if (limitSnap) {
    const lastObservedAtMs = toEpochMs(limitSnap.lastObservedAt ?? limitSnap.firstObservedAt);
    const resetsAtMs = normalizeResetTsMs(limitSnap.windows.resetsAt ?? limitSnap.windows.resets_at);
    const ageMs = lastObservedAtMs !== undefined ? Math.max(0, nowMs - lastObservedAtMs) : undefined;
    const resetPassed =
      resetsAtMs !== undefined &&
      nowMs >= resetsAtMs &&
      (lastObservedAtMs === undefined || lastObservedAtMs < resetsAtMs);
    if (resetPassed) anyExpiredReset = true;

    const status = asStr(limitSnap.windows.status);
    const rateLimitType = asStr(limitSnap.windows.rateLimitType);
    const overageStatus = asStr(limitSnap.windows.overageStatus);
    const isUsingOverage = typeof limitSnap.windows.isUsingOverage === 'boolean' ? limitSnap.windows.isUsingOverage : undefined;
    rateLimitStatus = {
      ...(status !== undefined ? { status } : {}),
      ...(rateLimitType !== undefined ? { rateLimitType } : {}),
      ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
      ...(overageStatus !== undefined ? { overageStatus } : {}),
      ...(isUsingOverage !== undefined ? { isUsingOverage } : {}),
      ...(lastObservedAtMs !== undefined ? { lastObservedAtMs } : {}),
      ...(ageMs !== undefined ? { ageMs } : {}),
      resetPassedWithoutNewObservation: resetPassed,
    };
  }

  let freshness: QuotaFreshness = 'unavailable';
  if (cached || rateLimitStatus) {
    if (anyExpiredReset) freshness = 'expired_reset';
    else if (cached?.isStale) freshness = 'stale';
    else if (cached) freshness = 'cached';
    else freshness = 'observed';
  }

  return {
    provider: 'claude',
    scope: 'provider_account',
    freshness,
    ...(cached ? { cached } : {}),
    ...(rateLimitStatus ? { rateLimitStatus } : {}),
  };
}

function resolveStatus(
  provider: ProviderId,
  selection: SessionSelection,
  state: SentraState,
  primarySession: SessionRecord | undefined,
  lastActivityAtMs: number | undefined,
  nowMs: number,
  opts: MetricsOptions
): {
  status: ProviderMonitorStatus;
  activityEvidence: ActivityEvidence;
  runtimePresent: boolean;
  runtimePid?: number;
  runtimeStatus?: string;
} {
  if (opts.lastError) {
    return { status: 'error', activityEvidence: 'none', runtimePresent: false };
  }
  if (opts.providerAvailable === false) {
    return { status: 'unavailable', activityEvidence: 'none', runtimePresent: false };
  }
  if (!selection.sessionId) {
    return { status: 'no_session', activityEvidence: 'none', runtimePresent: false };
  }

  if (provider === 'claude') {
    const runtimePresent = selection.reason === 'runtime_workspace' || selection.reason === 'runtime_active';
    let rtEv: SentraState['lifecycleEvents'][string] | undefined;
    if (primarySession) {
      let latestRtTs = -Infinity;
      for (const ev of Object.values(state.lifecycleEvents)) {
        if (ev.kind !== 'runtime_session' || ev.sessionId !== primarySession.id) continue;
        const ts = toEpochMs(ev.timestamp) ?? 0;
        if (!rtEv || ts >= latestRtTs) {
          rtEv = ev;
          latestRtTs = ts;
        }
      }
    }
    const runtimePid = rtEv?.nativeIds.pid;
    const runtimeStatus = asStr(rtEv?.details.status);

    if (runtimePresent) {
      const norm = runtimeStatus?.toLowerCase();
      const explicitlyActive = norm === 'running' || norm === 'busy' || norm === 'active' || norm === 'streaming';
      const explicitlyIdle = norm === 'idle' || norm === 'waiting' || norm === 'stopped' || norm === 'paused';
      const recentInference =
        lastActivityAtMs !== undefined && nowMs - lastActivityAtMs <= RUNTIME_ACTIVITY_WINDOW_MS;
      const status: ProviderMonitorStatus = explicitlyActive
        ? 'active'
        : explicitlyIdle
          ? 'runtime_idle'
          : recentInference
            ? 'active'
            : 'runtime_idle';
      return {
        status,
        activityEvidence: 'runtime_process',
        runtimePresent: true,
        ...(runtimePid !== undefined ? { runtimePid } : {}),
        ...(runtimeStatus !== undefined ? { runtimeStatus } : {}),
      };
    }

    return {
      status: 'idle',
      activityEvidence: 'historical_fallback',
      runtimePresent: false,
    };
  }

  // Codex has no process-level PID evidence; never report `'active'` solely from rollout mtime.
  if (selection.reason === 'runtime_workspace' || selection.reason === 'runtime_active') {
    return { status: 'recent', activityEvidence: 'recent_transcript', runtimePresent: false };
  }
  return { status: 'idle', activityEvidence: 'historical_fallback', runtimePresent: false };
}

/** Pure deterministic computation of a provider's Observatory snapshot from canonical state. */
export function computeProviderMetrics(
  provider: ProviderId,
  state: SentraState,
  selection: SessionSelection,
  nowMs: number,
  opts: MetricsOptions = {}
): ProviderObservatorySnapshot {
  const canonicalSessionId = selection.sessionId ? `${provider}:${selection.sessionId}` : undefined;
  const primarySession = canonicalSessionId ? state.sessions[canonicalSessionId] : undefined;

  const { direct, subagents, total, subagentSessions } = collectSessionInferences(state, primarySession);
  const directSorted = [...direct].sort(compareInferences);

  const directTotals = aggregateTokens(direct);
  const subagentTotals = aggregateTokens(subagents);
  const totalTotals = aggregateTokens(total);

  const byModelGroups = new Map<string, InferenceRecord[]>();
  for (const inf of total) {
    const key = inf.model ?? 'unknown';
    const arr = byModelGroups.get(key);
    if (arr) arr.push(inf);
    else byModelGroups.set(key, [inf]);
  }
  const byModel: Record<string, TokenTotals> = {};
  for (const key of [...byModelGroups.keys()].sort()) {
    byModel[key] = aggregateTokens(byModelGroups.get(key)!);
  }

  const harnessSnap = findPrimaryHarnessSnapshot(provider, state, primarySession);
  const harnessSnapshot: HarnessUsageSnapshot | undefined = harnessSnap
    ? {
        kind: harnessSnap.kind,
        ...(toEpochMs(harnessSnap.timestamp) !== undefined ? { timestampMs: toEpochMs(harnessSnap.timestamp) } : {}),
        ...(harnessSnap.lastTokens ? { lastTokens: harnessSnap.lastTokens } : {}),
        ...(harnessSnap.totalTokens ? { totalTokens: harnessSnap.totalTokens } : {}),
        ...(harnessSnap.modelContextWindow !== undefined ? { modelContextWindow: harnessSnap.modelContextWindow } : {}),
        ...(harnessSnap.totalCostUSD !== undefined ? { totalCostUSD: harnessSnap.totalCostUSD } : {}),
        ...(harnessSnap.modelUsage ? { modelUsage: harnessSnap.modelUsage } : {}),
      }
    : undefined;

  const { turns, turnByInfId, countByTurnId } = resolveTurnAssignments(primarySession, directSorted, state);
  const { context, hasAggregatedServerSide } = buildContextEvolution(
    provider, state, primarySession, directSorted, turnByInfId, harnessSnap
  );

  // Agentic metrics (no efficiency/productivity classifications).
  let directInputSum = 0;
  let directInputCnt = 0;
  let directInputMax: number | undefined;
  for (const inf of direct) {
    const inp = inf.tokens.totalInputTokens;
    if (inp !== undefined) {
      directInputSum += inp;
      directInputCnt += 1;
      directInputMax = directInputMax === undefined ? inp : Math.max(directInputMax, inp);
    }
  }

  const userTurnCount = turns.length > 0 ? turns.length : undefined;
  const associatedCount = turnByInfId.size;
  const latestTurn = turns.length > 0 ? turns[turns.length - 1] : undefined;
  const inferencesInLatestTurn =
    latestTurn && (associatedCount > 0 || direct.length === 0)
      ? (countByTurnId.get(latestTurn.id) ?? 0)
      : undefined;
  const avgInferencesPerTurn =
    userTurnCount !== undefined && (associatedCount > 0 || direct.length === 0)
      ? associatedCount / userTurnCount
      : undefined;

  const subagentSummaries: SubagentUsageSummary[] = subagentSessions.map((sub) => {
    const subInfs = sub.directInferenceIds
      .map((id) => state.inferences[id])
      .filter((x): x is InferenceRecord => Boolean(x));
    const startedAtMs = toEpochMs(sub.startedAt);
    const lastActivityAtMs = toEpochMs(sub.lastActivityAt);
    return {
      sessionId: sub.id,
      ...(sub.agentId !== undefined ? { agentId: sub.agentId } : {}),
      ...(sub.agentType !== undefined ? { agentType: sub.agentType } : {}),
      ...(sub.primaryModel !== undefined ? { primaryModel: sub.primaryModel } : {}),
      modelsObserved: [...sub.modelsObserved],
      ...(startedAtMs !== undefined ? { startedAtMs } : {}),
      ...(lastActivityAtMs !== undefined ? { lastActivityAtMs } : {}),
      tokens: aggregateTokens(subInfs),
    };
  });

  // Coverage & verifiable completeness check.
  let inferencesWithPartialTokens = 0;
  let inferencesWithConflicts = 0;
  let inferencesWithApiError = 0;
  let inferencesMissingTimestamp = 0;
  for (const inf of total) {
    if (inf.tokens.provenance === 'partial' || inf.tokens.totalInputTokens === undefined || inf.tokens.outputTokens === undefined) {
      inferencesWithPartialTokens += 1;
    }
    if (inf.hasConflictingDuplicates) inferencesWithConflicts += 1;
    if (inf.isApiError) inferencesWithApiError += 1;
    if (toEpochMs(inf.timestamp) === undefined) inferencesMissingTimestamp += 1;
  }

  let hasSnapshotDiscrepancy = false;
  let verifiedAgainstHarness = false;
  if (harnessSnap?.kind === 'codex_token_count' && harnessSnap.totalTokens?.totalTokens !== undefined) {
    if (directTotals.inferenceCount > 0 && directTotals.totalTokens !== undefined) {
      if (harnessSnap.totalTokens.totalTokens === directTotals.totalTokens) verifiedAgainstHarness = true;
      else hasSnapshotDiscrepancy = true;
    }
  } else if (harnessSnap?.kind === 'claude_cost_state') {
    const costTotalTokens = sumClaudeCostModelUsageTokens(harnessSnap.modelUsage);
    if (costTotalTokens !== undefined && totalTotals.inferenceCount > 0 && totalTotals.totalTokens !== undefined) {
      if (costTotalTokens === totalTotals.totalTokens) verifiedAgainstHarness = true;
      else hasSnapshotDiscrepancy = true;
    }
  }

  const sourceKind: DataCoverage['sourceKind'] =
    total.length > 0 && harnessSnapshot
      ? 'both'
      : total.length > 0
        ? 'inferences'
        : harnessSnapshot
          ? 'usage_snapshot'
          : 'none';

  const notes: string[] = [];
  let level: CoverageLevel;
  if (sourceKind === 'none') {
    level = 'unavailable';
  } else if (sourceKind === 'usage_snapshot') {
    level = 'snapshot_only';
    notes.push('legacy_snapshot_only');
  } else if (
    verifiedAgainstHarness &&
    inferencesWithPartialTokens === 0 &&
    inferencesWithConflicts === 0 &&
    inferencesMissingTimestamp === 0 &&
    !hasSnapshotDiscrepancy
  ) {
    level = 'complete';
  } else {
    level = 'partial';
    if (!verifiedAgainstHarness && !hasSnapshotDiscrepancy) notes.push('completeness_unverified');
  }

  if (inferencesWithPartialTokens > 0) notes.push('partial_token_partition');
  if (inferencesWithConflicts > 0) notes.push('conflicting_duplicate_inferences');
  if (hasSnapshotDiscrepancy) notes.push('snapshot_inference_discrepancy');
  if (hasAggregatedServerSide) notes.push('server_side_multi_iteration');
  if (provider === 'claude' && total.length > 0) notes.push('context_window_unavailable');
  if (provider === 'codex' && selection.sessionId) notes.push('no_runtime_process_evidence');

  const startedAtMs = toEpochMs(primarySession?.startedAt);
  const lastActivityAtMs =
    toEpochMs(primarySession?.lastActivityAt) ??
    (selection.candidates[0]?.sessionId === selection.sessionId ? selection.candidates[0]?.updatedAtMs : undefined);

  const statusInfo = resolveStatus(provider, selection, state, primarySession, lastActivityAtMs, nowMs, opts);

  const burnRate = computeBurnRate(total, startedAtMs, nowMs);
  const subscription = computeSubscriptionUsage(
    provider,
    state,
    nowMs,
    opts.claudeQuotaStaleMs ?? DEFAULT_CLAUDE_QUOTA_STALE_MS
  );

  return {
    provider,
    updatedAtMs: nowMs,
    identity: {
      provider,
      status: statusInfo.status,
      activityEvidence: statusInfo.activityEvidence,
      runtimePresent: statusInfo.runtimePresent,
      ...(canonicalSessionId !== undefined ? { sessionId: canonicalSessionId } : {}),
      ...(selection.sessionId !== undefined ? { nativeSessionId: selection.sessionId } : {}),
      ...(primarySession?.workspace ?? selection.workspace ? { workspace: primarySession?.workspace ?? selection.workspace } : {}),
      ...(primarySession?.primaryModel !== undefined ? { currentModel: primarySession.primaryModel } : {}),
      modelsObserved: primarySession ? [...primarySession.modelsObserved] : [],
      ...(startedAtMs !== undefined ? { startedAtMs } : {}),
      ...(lastActivityAtMs !== undefined ? { lastActivityAtMs } : {}),
      selectionReason: selection.reason,
      ambiguous: selection.ambiguous,
      candidateCount: selection.candidates.length,
      candidates: selection.candidates,
      ...(statusInfo.runtimePid !== undefined ? { runtimePid: statusInfo.runtimePid } : {}),
      ...(statusInfo.runtimeStatus !== undefined ? { runtimeStatus: statusInfo.runtimeStatus } : {}),
      ...(opts.lastError !== undefined ? { lastError: opts.lastError } : {}),
    },
    coverage: {
      level,
      sourceKind,
      inferencesTotal: total.length,
      inferencesWithPartialTokens,
      inferencesWithConflicts,
      inferencesWithApiError,
      inferencesMissingTimestamp,
      hasSnapshotDiscrepancy,
      notes,
    },
    usage: {
      direct: directTotals,
      subagents: subagentTotals,
      total: totalTotals,
      byModel,
      ...(harnessSnapshot ? { harnessSnapshot } : {}),
    },
    agentic: {
      directInferenceCount: direct.length,
      totalInferenceCount: total.length,
      ...(userTurnCount !== undefined ? { userTurnCount } : {}),
      ...(inferencesInLatestTurn !== undefined ? { inferencesInLatestTurn } : {}),
      ...(avgInferencesPerTurn !== undefined ? { avgInferencesPerTurn } : {}),
      ...(directInputCnt > 0 ? { avgInputTokensPerInference: directInputSum / directInputCnt } : {}),
      ...(directInputMax !== undefined ? { maxInputTokensPerInference: directInputMax } : {}),
      subagentCount: subagentSessions.length,
      subagents: subagentSummaries,
    },
    context,
    burnRate,
    subscription,
  };
}

/**
 * Lightweight idle-tick update: reuses existing aggregations and context series by reference,
 * recomputing only time-dependent burn rate, quota freshness/ages, and runtime-idle status.
 */
export function updateTimeDependentMetrics(
  prev: ProviderObservatorySnapshot,
  state: SentraState,
  selection: SessionSelection,
  nowMs: number,
  opts: MetricsOptions = {}
): ProviderObservatorySnapshot {
  const canonicalSessionId = selection.sessionId ? `${prev.provider}:${selection.sessionId}` : undefined;
  const primarySession = canonicalSessionId ? state.sessions[canonicalSessionId] : undefined;

  // Skip scanning inferences once burn rate has settled at 0 and short-session partial window has elapsed.
  const shortSessionElapsed =
    prev.burnRate.windowCoverage === 'partial' &&
    prev.burnRate.missingTimestampCount === 0 &&
    prev.identity.startedAtMs !== undefined &&
    nowMs - prev.identity.startedAtMs >= BURN_RATE_WINDOW_MS;
  let burnRate = prev.burnRate;
  if (prev.burnRate.inferencesInWindow > 0 || shortSessionElapsed) {
    const { total } = collectSessionInferences(state, primarySession);
    burnRate = computeBurnRate(total, prev.identity.startedAtMs, nowMs);
  } else {
    burnRate = { ...prev.burnRate, evaluatedAtMs: nowMs };
  }

  const subscription = computeSubscriptionUsage(
    prev.provider,
    state,
    nowMs,
    opts.claudeQuotaStaleMs ?? DEFAULT_CLAUDE_QUOTA_STALE_MS
  );

  const statusInfo = resolveStatus(
    prev.provider,
    selection,
    state,
    primarySession,
    prev.identity.lastActivityAtMs,
    nowMs,
    opts
  );

  const identity =
    statusInfo.status === prev.identity.status &&
    statusInfo.activityEvidence === prev.identity.activityEvidence &&
    statusInfo.runtimePresent === prev.identity.runtimePresent
      ? prev.identity
      : {
          ...prev.identity,
          status: statusInfo.status,
          activityEvidence: statusInfo.activityEvidence,
          runtimePresent: statusInfo.runtimePresent,
        };

  return {
    provider: prev.provider,
    updatedAtMs: nowMs,
    identity,
    coverage: prev.coverage,
    usage: prev.usage,
    agentic: prev.agentic,
    context: prev.context,
    burnRate,
    subscription,
  };
}

/** Creates an initial placeholder snapshot before the first async refresh completes. */
export function createInitialProviderSnapshot(provider: ProviderId, nowMs: number): ProviderObservatorySnapshot {
  return {
    provider,
    updatedAtMs: nowMs,
    identity: {
      provider,
      status: 'initializing',
      activityEvidence: 'none',
      runtimePresent: false,
      modelsObserved: [],
      selectionReason: 'none',
      ambiguous: false,
      candidateCount: 0,
      candidates: [],
    },
    coverage: {
      level: 'unavailable',
      sourceKind: 'none',
      inferencesTotal: 0,
      inferencesWithPartialTokens: 0,
      inferencesWithConflicts: 0,
      inferencesWithApiError: 0,
      inferencesMissingTimestamp: 0,
      hasSnapshotDiscrepancy: false,
      notes: [],
    },
    usage: {
      direct: emptyTokenTotals(),
      subagents: emptyTokenTotals(),
      total: emptyTokenTotals(),
      byModel: {},
    },
    agentic: {
      directInferenceCount: 0,
      totalInferenceCount: 0,
      subagentCount: 0,
      subagents: [],
    },
    context: {
      series: [],
      compactions: [],
      isCurrentContextFromLatestInference: false,
    },
    burnRate: {
      windowMinutes: 5,
      evaluatedAtMs: nowMs,
      scope: 'session_total',
      inferencesInWindow: 0,
      windowCoverage: 'unavailable',
      missingTimestampCount: 0,
    },
    subscription: {
      provider,
      scope: 'provider_account',
      freshness: 'unavailable',
      ...(provider === 'codex' ? { categories: [] } : {}),
    },
  };
}

/** Meaningful-change signature ignoring pure wall-clock ticks (`updatedAtMs`, `evaluatedAtMs`, `ageMs`). */
export function snapshotChangeSignature(s: ProviderObservatorySnapshot): string {
  const b = s.burnRate;
  const sub = s.subscription;
  return JSON.stringify({
    st: s.identity.status,
    ev: s.identity.activityEvidence,
    rp: s.identity.runtimePresent,
    rs: s.identity.runtimeStatus,
    sid: s.identity.sessionId,
    ws: s.identity.workspace,
    mod: s.identity.currentModel,
    sr: s.identity.selectionReason,
    amb: s.identity.ambiguous,
    cc: s.identity.candidateCount,
    err: s.identity.lastError,
    cov: [s.coverage.level, s.coverage.inferencesTotal, s.coverage.inferencesWithConflicts, s.coverage.hasSnapshotDiscrepancy],
    tot: [s.usage.direct.totalTokens, s.usage.subagents.totalTokens, s.usage.total.totalTokens, s.usage.harnessSnapshot?.totalTokens?.totalTokens, s.usage.harnessSnapshot?.totalCostUSD],
    ctx: [s.context.series.length, s.context.currentContextTokens, s.context.compactions.length],
    br: [b.windowCoverage, b.inferencesInWindow, b.inferencesPerMin, b.inputTokensPerMin, b.cacheReadTokensPerMin, b.cacheWriteTokensPerMin, b.outputTokensPerMin],
    sub: [
      sub.freshness,
      sub.cached?.fetchedAtMs,
      sub.cached?.isStale,
      sub.cached?.windows.map((w) => [w.windowId, w.usedPercent, w.resetPassedWithoutNewObservation]),
      sub.rateLimitStatus?.status,
      sub.rateLimitStatus?.resetPassedWithoutNewObservation,
      sub.categories?.map((c) => [c.categoryKey, c.windows.map((w) => [w.windowId, w.usedPercent, w.resetPassedWithoutNewObservation])]),
    ],
  });
}
