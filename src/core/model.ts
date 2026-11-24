import type {
  JsonObject,
  NativeIds,
  ProviderId,
  SourcePosition,
} from '../acquisition/types.js';

export type MetricProvenance = 'observed' | 'derived' | 'partial';

export interface NormalizedTokens {
  totalInputTokens?: number;
  uncachedInputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  contextWindow?: number;
  cacheCreationBreakdown?: { ephemeral5m?: number; ephemeral1h?: number };
  provenance: MetricProvenance;
}

export interface SessionRecord {
  id: string;
  provider: ProviderId;
  nativeSessionId: string;
  parentSessionId?: string;
  derivedFromSessionIds?: string[];
  isSubagent: boolean;
  agentId?: string;
  agentType?: string;
  workspace?: string;
  primaryModel?: string;
  modelsObserved: string[];
  harnessVersion?: string;
  startedAt?: string | number;
  lastActivityAt?: string | number;
  sourceLogicalKeys: string[];
  directInferenceIds: string[];
  inheritedInferenceIds: string[];
  childSessionIds: string[];
}

export interface TurnRecord {
  id: string;
  provider: ProviderId;
  sessionId: string;
  nativeTurnId: string;
  startedAt?: string | number;
  completedAt?: string | number;
  status?: 'started' | 'completed' | 'aborted';
  model?: string;
  inferenceIds: string[];
  sourceKey: string;
}

export interface InferenceRecord {
  id: string;
  provider: ProviderId;
  ownerSessionId?: string;
  observedInSessionIds: string[];
  turnId?: string;
  agentId?: string;
  model?: string;
  requestedModel?: string;
  timestamp?: string | number;
  stopReason?: string | null;
  apiBlockIndex?: number;
  isApiError?: boolean;
  hasConflictingDuplicates?: boolean;
  nativeIds: NativeIds;
  tokens: NormalizedTokens;
  nativeUsage: JsonObject;
  sourceKey: string;
  position: SourcePosition;
}

export interface UsageSnapshotRecord {
  id: string;
  provider: ProviderId;
  sessionId?: string;
  kind: 'codex_token_count' | 'claude_cost_state';
  timestamp?: string | number;
  lastTokens?: NormalizedTokens;
  totalTokens?: NormalizedTokens;
  modelContextWindow?: number;
  totalCostUSD?: number;
  modelUsage?: JsonObject;
  nativeUsage: JsonObject;
  sourceKey: string;
  position: SourcePosition;
}

/** Provider/account-scoped quota snapshot (never attributed to a single session). */
export interface QuotaSnapshotRecord {
  id: string;
  provider: ProviderId;
  categoryKey: string;
  limitId?: string;
  limitName?: string;
  planType?: string;
  windows: JsonObject;
  firstObservedAt?: string | number;
  lastObservedAt?: string | number;
  observationCount: number;
  isCached: boolean;
  sourceKey: string;
}

export interface LifecycleEventRecord {
  id: string;
  provider: ProviderId;
  sessionId?: string;
  kind: 'compaction' | 'derived_from' | 'turn_aborted' | 'subagent_meta' | 'runtime_session';
  timestamp?: string | number;
  nativeIds: NativeIds;
  details: JsonObject;
  sourceKey: string;
  position: SourcePosition;
}

export interface RuntimeEvidenceRecord {
  id: string;
  provider: ProviderId;
  sessionId?: string;
  turnId?: string;
  eventType: string;
  timestamp?: string | number;
  nativeIds: NativeIds;
  details: JsonObject;
  sourceKey: string;
  position: SourcePosition;
}

/** In-memory operational state for the currently monitored session (+ provider-scoped quotas). */
export interface SentraState {
  sessions: Record<string, SessionRecord>;
  turns: Record<string, TurnRecord>;
  inferences: Record<string, InferenceRecord>;
  /** Maps fallback inference keys (e.g. requestId/requestRef) to their canonical primary ID. */
  inferenceAliases: Record<string, string>;
  usageSnapshots: Record<string, UsageSnapshotRecord>;
  quotaSnapshots: QuotaSnapshotRecord[];
  latestQuotaByCategory: Record<string, QuotaSnapshotRecord>;
  lifecycleEvents: Record<string, LifecycleEventRecord>;
}

export function createEmptyState(): SentraState {
  return {
    sessions: {},
    turns: {},
    inferences: {},
    inferenceAliases: {},
    usageSnapshots: {},
    quotaSnapshots: [],
    latestQuotaByCategory: {},
    lifecycleEvents: {},
  };
}
