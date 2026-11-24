import {
  asNum,
  asObj,
  asStr,
  pick,
  type JsonObject,
  type ObservationEnvelope,
  type ProviderId,
  type SourcePosition,
} from '../acquisition/types.js';
import type {
  InferenceRecord,
  LifecycleEventRecord,
  NormalizedTokens,
  QuotaSnapshotRecord,
  RuntimeEvidenceRecord,
  SentraState,
  SessionRecord,
  TurnRecord,
} from './model.js';
import {
  extractRawUsage,
  hasPositiveConsumption,
  normalizeClaudeUsage,
  normalizeCodexUsage,
} from './normalize.js';

export interface ReconcileDiagnostic {
  code: 'missing_inference_id' | 'conflicting_duplicate_usage';
  provider: ProviderId;
  id?: string;
  sourcePath: string;
  message: string;
}

export interface ReconcileSummary {
  processed: number;
  inferencesAdded: number;
  inferencesUpdated: number;
  syntheticSkipped: number;
  conflicts: number;
  diagnostics: ReconcileDiagnostic[];
}

interface BatchScratch {
  latestTurnModel: Map<string, string>;
  latestContextWindow: Map<string, number>;
  posCounter: Map<string, number>;
  quotaIndex: Map<string, QuotaSnapshotRecord[]>;
  latestFingerprints: Map<string, string>;
}

const TOKEN_NUM_FIELDS = [
  'totalInputTokens', 'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens',
  'outputTokens', 'reasoningTokens', 'totalTokens', 'contextWindow',
] as const;

const RATE_LIMIT_WINDOW_KEYS = [
  'primary', 'secondary', 'credits', 'individual_limit',
  'rate_limit_reached_type', 'spend_control_reached',
] as const;

function toEpochMs(ts: string | number | undefined): number | undefined {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  if (typeof ts === 'string') {
    const ms = Date.parse(ts);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

function compareTs(a: string | number, b: string | number): number {
  const am = toEpochMs(a);
  const bm = toEpochMs(b);
  if (am !== undefined && bm !== undefined) return am - bm;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

const earlierTs = (a?: string | number, b?: string | number) =>
  a === undefined ? b : b === undefined ? a : compareTs(a, b) <= 0 ? a : b;

const laterTs = (a?: string | number, b?: string | number) =>
  a === undefined ? b : b === undefined ? a : compareTs(a, b) >= 0 ? a : b;

const pushUnique = (arr: string[], val?: string): void => {
  if (val !== undefined && !arr.includes(val)) arr.push(val);
};

const removeItem = (arr: string[], val: string): void => {
  const idx = arr.indexOf(val);
  if (idx !== -1) arr.splice(idx, 1);
};

function canonicalJson(val: unknown): string {
  if (val === null || typeof val !== 'object') return JSON.stringify(val);
  if (Array.isArray(val)) return '[' + val.map(canonicalJson).join(',') + ']';
  const obj = val as JsonObject;
  return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

// Use lineNumber for both byte_range and logical_line so `.jsonl` -> `.jsonl.zst` stays idempotent.
const positionKey = (pos: SourcePosition): string =>
  pos.kind === 'byte_range' || pos.kind === 'logical_line' ? `l:${pos.lineNumber}` : `d:${pos.fieldPath ?? ''}`;

const sessionKey = (provider: ProviderId, nativeId: string): string => `${provider}:${nativeId}`;

function ensureSession(
  state: SentraState,
  provider: ProviderId,
  nativeSessionId: string,
  sourceLogicalKey: string,
  ts?: string | number,
  harnessVersion?: string
): SessionRecord {
  const id = sessionKey(provider, nativeSessionId);
  let s = state.sessions[id];
  if (!s) {
    s = {
      id, provider, nativeSessionId, isSubagent: false,
      modelsObserved: [], sourceLogicalKeys: [], directInferenceIds: [],
      inheritedInferenceIds: [], childSessionIds: [],
    };
    state.sessions[id] = s;
  }
  pushUnique(s.sourceLogicalKeys, sourceLogicalKey);
  if (ts !== undefined) {
    s.startedAt = earlierTs(s.startedAt, ts);
    s.lastActivityAt = laterTs(s.lastActivityAt, ts);
  }
  if (harnessVersion && !s.harnessVersion) s.harnessVersion = harnessVersion;
  return s;
}

function ensureTurn(
  state: SentraState,
  provider: ProviderId,
  sessionId: string,
  nativeTurnId: string,
  sourceKey: string
): TurnRecord {
  const id = `${sessionId}:turn:${nativeTurnId}`;
  let t = state.turns[id];
  if (!t) {
    t = { id, provider, sessionId, nativeTurnId, inferenceIds: [], sourceKey };
    state.turns[id] = t;
  }
  return t;
}

function syncSessionInferenceMembership(state: SentraState, inf: InferenceRecord): void {
  for (const sid of inf.observedInSessionIds) {
    const s = state.sessions[sid];
    if (!s) continue;
    if (sid === inf.ownerSessionId) {
      pushUnique(s.directInferenceIds, inf.id);
      removeItem(s.inheritedInferenceIds, inf.id);
    } else {
      removeItem(s.directInferenceIds, inf.id);
      pushUnique(s.inheritedInferenceIds, inf.id);
    }
  }
}

/** Re-aligns ownership of shared inferences when a parent->child/fork link arrives after the inferences. */
function realignDerivedOwnership(state: SentraState, parentId: string, childId: string): void {
  const child = state.sessions[childId];
  if (!child || child.directInferenceIds.length === 0) return;
  for (const infId of [...child.directInferenceIds]) {
    const inf = state.inferences[infId];
    if (inf && inf.observedInSessionIds.includes(parentId)) {
      inf.ownerSessionId = parentId;
      syncSessionInferenceMembership(state, inf);
    }
  }
}

function linkParentChild(state: SentraState, parent: SessionRecord, child: SessionRecord): void {
  if (parent.id === child.id) return;
  child.parentSessionId = parent.id;
  pushUnique(parent.childSessionIds, child.id);
  realignDerivedOwnership(state, parent.id, child.id);
}

function mergeTokens(
  a: NormalizedTokens,
  b: NormalizedTokens,
  bothFinalized: boolean
): { tokens: NormalizedTokens; conflict: boolean } {
  let conflict = false;
  const out: NormalizedTokens = {
    provenance:
      a.provenance === 'observed' || b.provenance === 'observed'
        ? 'observed'
        : a.provenance === 'derived' || b.provenance === 'derived'
          ? 'derived'
          : 'partial',
  };

  for (const f of TOKEN_NUM_FIELDS) {
    const av = a[f];
    const bv = b[f];
    if (av !== undefined && bv !== undefined) {
      if (bothFinalized && av !== bv) conflict = true;
      out[f] = Math.max(av, bv);
    } else if (av !== undefined) {
      out[f] = av;
    } else if (bv !== undefined) {
      out[f] = bv;
    }
  }

  const acc = a.cacheCreationBreakdown;
  const bcc = b.cacheCreationBreakdown;
  if (acc || bcc) {
    const maxOpt = (x?: number, y?: number) =>
      x !== undefined && y !== undefined ? Math.max(x, y) : (x ?? y);
    const e5 = maxOpt(acc?.ephemeral5m, bcc?.ephemeral5m);
    const e1 = maxOpt(acc?.ephemeral1h, bcc?.ephemeral1h);
    if (e5 !== undefined || e1 !== undefined) {
      out.cacheCreationBreakdown = {
        ...(e5 !== undefined ? { ephemeral5m: e5 } : {}),
        ...(e1 !== undefined ? { ephemeral1h: e1 } : {}),
      };
    }
  }

  return { tokens: out, conflict };
}

function resolveInferenceKeys(obs: ObservationEnvelope<JsonObject>): { primaryKey?: string; aliasKeys: string[] } {
  if (obs.provider === 'codex') {
    const respId = obs.nativeIds.responseId;
    return respId ? { primaryKey: `codex:resp:${respId}`, aliasKeys: [] } : { aliasKeys: [] };
  }
  const aliases: string[] = [];
  if (obs.nativeIds.requestId) aliases.push(`claude:req:${obs.nativeIds.requestId}`);
  if (obs.nativeIds.requestRef) aliases.push(`claude:ref:${obs.nativeIds.requestRef}`);
  if (obs.nativeIds.messageId) return { primaryKey: `claude:msg:${obs.nativeIds.messageId}`, aliasKeys: aliases };
  return aliases.length > 0 ? { primaryKey: aliases[0], aliasKeys: aliases.slice(1) } : { aliasKeys: [] };
}

function isDerivedFrom(state: SentraState, childId: string, ancestorId: string): boolean {
  const child = state.sessions[childId];
  return Boolean(child && (child.parentSessionId === ancestorId || child.derivedFromSessionIds?.includes(ancestorId)));
}

function chooseOwnerSession(
  state: SentraState,
  curOwner?: string,
  incoming?: string,
  curTs?: string | number,
  incTs?: string | number
): string | undefined {
  if (!curOwner) return incoming;
  if (!incoming || curOwner === incoming) return curOwner;
  if (isDerivedFrom(state, incoming, curOwner)) return curOwner;
  if (isDerivedFrom(state, curOwner, incoming)) return incoming;

  const curRef = earlierTs(state.sessions[curOwner]?.startedAt, curTs);
  const incRef = earlierTs(state.sessions[incoming]?.startedAt, incTs);
  if (curRef !== undefined && incRef !== undefined && curRef !== incRef) {
    return earlierTs(curRef, incRef) === curRef ? curOwner : incoming;
  }
  return curOwner <= incoming ? curOwner : incoming;
}

function migrateInferenceKey(state: SentraState, oldId: string, newId: string): InferenceRecord | undefined {
  if (oldId === newId) return state.inferences[newId];
  const rec = state.inferences[oldId];
  if (!rec) return undefined;
  delete state.inferences[oldId];
  rec.id = newId;
  state.inferences[newId] = rec;
  state.inferenceAliases[oldId] = newId;

  for (const [alias, target] of Object.entries(state.inferenceAliases)) {
    if (target === oldId) state.inferenceAliases[alias] = newId;
  }
  const replace = (arr: string[]) => {
    const i = arr.indexOf(oldId);
    if (i !== -1) arr[i] = newId;
  };
  for (const s of Object.values(state.sessions)) {
    replace(s.directInferenceIds);
    replace(s.inheritedInferenceIds);
  }
  for (const t of Object.values(state.turns)) replace(t.inferenceIds);
  return rec;
}

const quotaFingerprint = (
  limitId: string | undefined,
  limitName: string | undefined,
  planType: string | undefined,
  windows: JsonObject
): string => canonicalJson({ limitId, limitName, planType, windows });

function recordQuotaSnapshot(
  state: SentraState,
  scratch: BatchScratch,
  provider: ProviderId,
  categoryKey: string,
  windows: JsonObject,
  opts: {
    limitId?: string;
    limitName?: string;
    planType?: string;
    timestamp?: string | number;
    isCached: boolean;
    sourceKey: string;
  }
): void {
  const fp = quotaFingerprint(opts.limitId, opts.limitName, opts.planType, windows);
  const latest = state.latestQuotaByCategory[categoryKey];

  // Compress ONLY consecutive identical snapshots, preserving first & last observation timestamps.
  if (latest && scratch.latestFingerprints.get(categoryKey) === fp) {
    const prevFirst = latest.firstObservedAt;
    const prevLast = latest.lastObservedAt;
    latest.firstObservedAt = earlierTs(prevFirst, opts.timestamp);
    latest.lastObservedAt = laterTs(prevLast, opts.timestamp);
    if (opts.timestamp !== undefined && (latest.firstObservedAt !== prevFirst || latest.lastObservedAt !== prevLast)) {
      latest.observationCount += 1;
    }
    return;
  }

  // O(1) idempotent guard: skip re-appending historical snapshots already covering this timestamp.
  const idxKey = `${categoryKey}|${fp}`;
  const bucket = scratch.quotaIndex.get(idxKey);
  if (opts.timestamp !== undefined && bucket) {
    const inMs = toEpochMs(opts.timestamp);
    if (inMs !== undefined) {
      for (const q of bucket) {
        const qFirst = toEpochMs(q.firstObservedAt);
        const qLast = toEpochMs(q.lastObservedAt);
        if (qFirst !== undefined && qLast !== undefined && inMs >= qFirst && inMs <= qLast) return;
      }
    }
  }

  const snap: QuotaSnapshotRecord = {
    id: `${categoryKey}#${state.quotaSnapshots.length + 1}`,
    provider,
    categoryKey,
    ...(opts.limitId !== undefined ? { limitId: opts.limitId } : {}),
    ...(opts.limitName !== undefined ? { limitName: opts.limitName } : {}),
    ...(opts.planType !== undefined ? { planType: opts.planType } : {}),
    windows,
    ...(opts.timestamp !== undefined ? { firstObservedAt: opts.timestamp, lastObservedAt: opts.timestamp } : {}),
    observationCount: 1,
    isCached: opts.isCached,
    sourceKey: opts.sourceKey,
  };
  state.quotaSnapshots.push(snap);
  state.latestQuotaByCategory[categoryKey] = snap;
  scratch.latestFingerprints.set(categoryKey, fp);
  if (bucket) bucket.push(snap);
  else scratch.quotaIndex.set(idxKey, [snap]);
}

function putLifecycle(
  state: SentraState,
  obs: ObservationEnvelope<JsonObject>,
  kind: LifecycleEventRecord['kind'],
  idSuffix: string,
  sessionId?: string
): void {
  const id = `${obs.provider}:lc:${obs.source.logicalKey}:${idSuffix}`;
  state.lifecycleEvents[id] = {
    id, provider: obs.provider, sessionId, kind, timestamp: obs.timestamp,
    nativeIds: obs.nativeIds, details: obs.payload, sourceKey: obs.source.logicalKey, position: obs.position,
  };
}

/** Resolves the logical session for an observation, keeping Claude subagents distinct from their parent. */
function resolveObservationSession(
  state: SentraState,
  obs: ObservationEnvelope<JsonObject>
): SessionRecord | undefined {
  const nativeSessionId = obs.nativeIds.sessionId;
  if (!nativeSessionId) return undefined;

  const isClaudeSub =
    obs.provider === 'claude' &&
    (obs.source.kind === 'subagent_transcript' || obs.source.kind === 'subagent_meta') &&
    Boolean(obs.nativeIds.agentId);

  if (isClaudeSub) {
    const agentId = obs.nativeIds.agentId!;
    const parent = ensureSession(state, 'claude', nativeSessionId, obs.source.logicalKey, obs.timestamp, obs.harnessVersion);
    const sub = ensureSession(state, 'claude', `${nativeSessionId}:agent:${agentId}`, obs.source.logicalKey, obs.timestamp, obs.harnessVersion);
    sub.isSubagent = true;
    sub.agentId = agentId;
    linkParentChild(state, parent, sub);
    const cwd = asStr(obs.payload.cwd);
    if (cwd && !sub.workspace) sub.workspace = cwd;
    return sub;
  }

  if (obs.provider === 'codex' && obs.nativeIds.parentThreadId && obs.nativeIds.threadId && obs.nativeIds.threadId !== obs.nativeIds.parentThreadId) {
    const parent = ensureSession(state, 'codex', obs.nativeIds.parentThreadId, obs.source.logicalKey, obs.timestamp, obs.harnessVersion);
    const sub = ensureSession(state, 'codex', obs.nativeIds.threadId, obs.source.logicalKey, obs.timestamp, obs.harnessVersion);
    sub.isSubagent = true;
    sub.agentId = obs.nativeIds.threadId;
    linkParentChild(state, parent, sub);
    const cwd = asStr(obs.payload.cwd);
    if (cwd && !sub.workspace) sub.workspace = cwd;
    return sub;
  }

  const session = ensureSession(state, obs.provider, nativeSessionId, obs.source.logicalKey, obs.timestamp, obs.harnessVersion);
  const cwd = asStr(obs.payload.cwd);
  if (cwd && !session.workspace) session.workspace = cwd;
  return session;
}

function reconcileLifecycle(
  state: SentraState,
  scratch: BatchScratch,
  obs: ObservationEnvelope<JsonObject>,
  session?: SessionRecord
): void {
  const p = obs.payload;
  const pos = positionKey(obs.position);

  if (obs.provider === 'codex') {
    if (obs.eventType === 'session_meta' && session) {
      const parentThread = obs.nativeIds.parentThreadId;
      if (parentThread) linkParentChild(state, ensureSession(state, 'codex', parentThread, obs.source.logicalKey), session);
      const role = asStr(p.agent_role);
      if (role) {
        session.agentType = role;
        if (parentThread) session.isSubagent = true;
      }
      const cw = asNum(p.context_window);
      if (cw !== undefined) scratch.latestContextWindow.set(session.id, cw);
    } else if (obs.eventType === 'turn_context' && session) {
      const model = asStr(p.model);
      if (model) {
        scratch.latestTurnModel.set(session.id, model);
        pushUnique(session.modelsObserved, model);
        session.primaryModel = model;
      }
      const turnId = obs.nativeIds.turnId ?? obs.nativeIds.rootTurnId;
      if (turnId) {
        const t = ensureTurn(state, 'codex', session.id, turnId, obs.source.logicalKey);
        if (model) t.model = model;
        t.startedAt = earlierTs(t.startedAt, obs.timestamp);
      }
    } else if (p.kind === 'turn_lifecycle' && session) {
      const ev = asStr(p.event);
      const cw = asNum(p.model_context_window);
      if (cw !== undefined) scratch.latestContextWindow.set(session.id, cw);
      if (obs.nativeIds.turnId) {
        const t = ensureTurn(state, 'codex', session.id, obs.nativeIds.turnId, obs.source.logicalKey);
        if (ev === 'task_started') { t.startedAt = earlierTs(t.startedAt, obs.timestamp); t.status ??= 'started'; }
        else if (ev === 'task_complete') { t.completedAt = laterTs(t.completedAt, obs.timestamp); t.status = 'completed'; }
        else if (ev === 'turn_aborted') { t.completedAt = laterTs(t.completedAt, obs.timestamp); t.status = 'aborted'; }
      }
      if (ev === 'turn_aborted') putLifecycle(state, obs, 'turn_aborted', `${pos}:turn_aborted`, session.id);
    } else if (obs.eventType === 'compacted') {
      putLifecycle(state, obs, 'compaction', `${pos}:compacted`, session?.id);
    }
    return;
  }

  if (obs.eventType === 'user' && session) {
    // Only record real user-originated prompts as TurnRecords (exclude tool results, meta, compact summaries, system/peer notices).
    const origin = asStr(p.turnOrigin);
    const isNonHumanUser =
      p.isToolResult === true ||
      p.isMeta === true ||
      p.isCompactSummary === true ||
      asStr(p.promptSource) === 'system' ||
      origin === 'task_notification' ||
      origin === 'peer' ||
      origin === 'system';
    if (!isNonHumanUser) {
      const turnId = obs.nativeIds.turnPromptId ?? obs.nativeIds.uuid;
      if (turnId) {
        const t = ensureTurn(state, 'claude', session.id, turnId, obs.source.logicalKey);
        t.startedAt = earlierTs(t.startedAt, obs.timestamp);
      }
    }
  } else if (obs.eventType === 'derived-from' && session) {
    const derivedIds: string[] = [];
    for (const item of Array.isArray(p.sessions) ? p.sessions : []) {
      const pid = asStr(item) ?? asStr(asObj(item)?.sessionId);
      if (!pid) continue;
      const parent = ensureSession(state, 'claude', pid, obs.source.logicalKey);
      pushUnique(derivedIds, parent.id);
      pushUnique(parent.childSessionIds, session.id);
      realignDerivedOwnership(state, parent.id, session.id);
    }
    if (derivedIds.length > 0) {
      session.derivedFromSessionIds = [...new Set([...(session.derivedFromSessionIds ?? []), ...derivedIds])];
      session.parentSessionId ??= derivedIds[0];
    }
    putLifecycle(state, obs, 'derived_from', `${pos}:derived_from`, session.id);
  } else if (obs.eventType === 'system:compact_boundary') {
    putLifecycle(state, obs, 'compaction', `${pos}:compact_boundary`, session?.id);
  } else if (obs.eventType === 'subagent_meta') {
    if (session) {
      session.agentType = asStr(p.agentType) ?? session.agentType;
      const m = asStr(p.model);
      if (m) { pushUnique(session.modelsObserved, m); session.primaryModel ??= m; }
    }
    putLifecycle(state, obs, 'subagent_meta', 'subagent_meta', session?.id);
  } else if (obs.eventType === 'runtime_session') {
    putLifecycle(state, obs, 'runtime_session', 'runtime_session', session?.id);
  }
}

function reconcileInference(
  state: SentraState,
  scratch: BatchScratch,
  obs: ObservationEnvelope<JsonObject>,
  summary: ReconcileSummary,
  session?: SessionRecord
): void {
  const p = obs.payload;
  const cw = session ? scratch.latestContextWindow.get(session.id) : undefined;
  const tokens = obs.provider === 'codex' ? normalizeCodexUsage(p.usage, cw) : normalizeClaudeUsage(p.usage, cw);

  if (obs.provider === 'claude') {
    if (asStr(p.actualModel) === '<synthetic>' || (p.isApiErrorMessage === true && !hasPositiveConsumption(tokens))) {
      summary.syntheticSkipped += 1;
      return;
    }
  }
  if (!tokens) return;

  const { primaryKey, aliasKeys } = resolveInferenceKeys(obs);
  if (!primaryKey) {
    summary.diagnostics.push({
      code: 'missing_inference_id', provider: obs.provider, sourcePath: obs.source.path,
      message: `Skipped ${obs.eventType} without stable inference identifier`,
    });
    return;
  }

  let existing: InferenceRecord | undefined =
    state.inferences[primaryKey] ??
    (state.inferenceAliases[primaryKey] ? state.inferences[state.inferenceAliases[primaryKey]!] : undefined);
  if (!existing) {
    for (const a of aliasKeys) {
      const targetId = state.inferenceAliases[a] ?? (state.inferences[a] ? a : undefined);
      if (targetId && state.inferences[targetId]) {
        existing =
          primaryKey.startsWith('claude:msg:') && !targetId.startsWith('claude:msg:')
            ? migrateInferenceKey(state, targetId, primaryKey)
            : state.inferences[targetId];
        break;
      }
    }
  }

  const canonicalId = existing ? existing.id : primaryKey;
  for (const a of [primaryKey, ...aliasKeys]) {
    if (a !== canonicalId) state.inferenceAliases[a] = canonicalId;
  }

  const model = obs.provider === 'codex' ? (session ? scratch.latestTurnModel.get(session.id) : undefined) : asStr(p.actualModel);
  const requestedModel = asStr(p.requestedModel);
  const stopReason = typeof p.stopReason === 'string' || p.stopReason === null ? p.stopReason : undefined;
  const turnNativeId = obs.nativeIds.turnId ?? obs.nativeIds.rootTurnId ?? obs.nativeIds.turnPromptId;
  const turn = session && turnNativeId ? ensureTurn(state, obs.provider, session.id, turnNativeId, obs.source.logicalKey) : undefined;

  if (session && model) {
    pushUnique(session.modelsObserved, model);
    session.primaryModel = model;
  }

  if (!existing) {
    const rec: InferenceRecord = {
      id: canonicalId, provider: obs.provider, ownerSessionId: session?.id,
      observedInSessionIds: session ? [session.id] : [], turnId: turn?.id,
      agentId: obs.nativeIds.agentId, model, requestedModel, timestamp: obs.timestamp,
      stopReason, apiBlockIndex: obs.nativeIds.apiBlockIndex,
      ...(p.isApiErrorMessage === true ? { isApiError: true } : {}),
      nativeIds: { ...obs.nativeIds }, tokens, nativeUsage: extractRawUsage(p.usage),
      sourceKey: obs.source.logicalKey, position: obs.position,
    };
    state.inferences[canonicalId] = rec;
    syncSessionInferenceMembership(state, rec);
    if (turn) pushUnique(turn.inferenceIds, canonicalId);
    summary.inferencesAdded += 1;
    return;
  }

  const bothFinalized = obs.provider === 'codex' || (typeof existing.stopReason === 'string' && typeof stopReason === 'string');
  const merged = mergeTokens(existing.tokens, tokens, bothFinalized);
  existing.tokens = merged.tokens;
  if (merged.conflict) {
    existing.hasConflictingDuplicates = true;
    summary.conflicts += 1;
    summary.diagnostics.push({
      code: 'conflicting_duplicate_usage', provider: obs.provider, id: canonicalId,
      sourcePath: obs.source.path, message: `Discordant counters on duplicate inference ${canonicalId}`,
    });
  }
  existing.timestamp = earlierTs(existing.timestamp, obs.timestamp);
  if (model && !existing.model) existing.model = model;
  if (requestedModel && !existing.requestedModel) existing.requestedModel = requestedModel;
  if (typeof stopReason === 'string' && typeof existing.stopReason !== 'string') existing.stopReason = stopReason;
  if (obs.nativeIds.apiBlockIndex !== undefined) {
    existing.apiBlockIndex = existing.apiBlockIndex !== undefined
      ? Math.max(existing.apiBlockIndex, obs.nativeIds.apiBlockIndex)
      : obs.nativeIds.apiBlockIndex;
  }
  existing.nativeIds = { ...existing.nativeIds, ...obs.nativeIds };
  if (session) {
    pushUnique(existing.observedInSessionIds, session.id);
    existing.ownerSessionId = chooseOwnerSession(state, existing.ownerSessionId, session.id, existing.timestamp, obs.timestamp);
    syncSessionInferenceMembership(state, existing);
  }
  if (turn && !existing.turnId) existing.turnId = turn.id;
  if (turn && existing.ownerSessionId === session?.id) pushUnique(turn.inferenceIds, canonicalId);
  summary.inferencesUpdated += 1;
}

function reconcileSnapshot(
  state: SentraState,
  scratch: BatchScratch,
  obs: ObservationEnvelope<JsonObject>,
  session?: SessionRecord
): void {
  const p = obs.payload;
  if (obs.provider === 'codex' && obs.eventType === 'event_msg/token_count') {
    const cw = asNum(p.model_context_window);
    if (cw !== undefined && session) scratch.latestContextWindow.set(session.id, cw);
    const lastTokens = normalizeCodexUsage(p.last_token_usage, cw);
    const totalTokens = normalizeCodexUsage(p.total_token_usage, cw);
    if (lastTokens || totalTokens) {
      const snapId = `codex:snap:${session?.id ?? obs.source.logicalKey}`;
      const prev = state.usageSnapshots[snapId];
      if (!prev || (totalTokens?.totalTokens ?? -1) >= (prev.totalTokens?.totalTokens ?? -1)) {
        state.usageSnapshots[snapId] = {
          id: snapId, provider: 'codex', sessionId: session?.id, kind: 'codex_token_count',
          timestamp: obs.timestamp, ...(lastTokens ? { lastTokens } : {}), ...(totalTokens ? { totalTokens } : {}),
          ...(cw !== undefined ? { modelContextWindow: cw } : {}),
          nativeUsage: extractRawUsage(p.total_token_usage ?? p.last_token_usage),
          sourceKey: obs.source.logicalKey, position: obs.position,
        };
      }
    }
    const rl = asObj(p.rate_limits);
    if (rl) {
      const windows = pick(rl, RATE_LIMIT_WINDOW_KEYS);
      if (Object.keys(windows).length > 0) {
        recordQuotaSnapshot(state, scratch, 'codex', `codex:${asStr(rl.limit_id) ?? 'default'}`, windows, {
          limitId: asStr(rl.limit_id), limitName: asStr(rl.limit_name), planType: asStr(rl.plan_type),
          timestamp: obs.timestamp, isCached: false, sourceKey: obs.source.logicalKey,
        });
      }
    }
    return;
  }

  if (obs.provider === 'claude' && obs.eventType === 'cost-state') {
    const snapId = `claude:cost:${session?.id ?? obs.source.logicalKey}`;
    const prev = state.usageSnapshots[snapId];
    const nextCost = asNum(p.totalCostUSD);
    if (!prev || (nextCost !== undefined && nextCost >= (prev.totalCostUSD ?? -1))) {
      state.usageSnapshots[snapId] = {
        id: snapId, provider: 'claude', sessionId: session?.id, kind: 'claude_cost_state',
        timestamp: obs.timestamp, ...(nextCost !== undefined ? { totalCostUSD: nextCost } : {}),
        ...(asObj(p.modelUsage) ? { modelUsage: asObj(p.modelUsage) } : {}),
        nativeUsage: p, sourceKey: obs.source.logicalKey, position: obs.position,
      };
    }
  } else if (obs.provider === 'claude' && obs.eventType === 'quotaLimits') {
    const ql = asObj(p.quotaLimits);
    if (ql && Object.keys(ql).length > 0) {
      recordQuotaSnapshot(state, scratch, 'claude', 'claude:quota_limits', ql, {
        timestamp: obs.timestamp, isCached: false, sourceKey: obs.source.logicalKey,
      });
    }
  } else if (obs.provider === 'claude' && obs.eventType === 'cachedUsageUtilization') {
    const util = asObj(p.utilization);
    if (util && Object.keys(util).length > 0) {
      recordQuotaSnapshot(state, scratch, 'claude', 'claude:cached_utilization', util, {
        timestamp: obs.timestamp, isCached: true, sourceKey: obs.source.logicalKey,
      });
    }
  }
}

function reconcileEvidence(
  evidence: Record<string, RuntimeEvidenceRecord>,
  scratch: BatchScratch,
  obs: ObservationEnvelope<JsonObject>,
  session?: SessionRecord
): void {
  const base = `${obs.provider}:${obs.source.logicalKey}:${positionKey(obs.position)}:${obs.eventType}`;
  const seq = (scratch.posCounter.get(base) ?? 0) + 1;
  scratch.posCounter.set(base, seq);
  const id = seq === 1 ? base : `${base}#${seq}`;
  const ev: RuntimeEvidenceRecord = {
    id, provider: obs.provider, sessionId: session?.id,
    turnId: session && obs.nativeIds.turnId ? `${session.id}:turn:${obs.nativeIds.turnId}` : undefined,
    eventType: obs.eventType, timestamp: obs.timestamp, nativeIds: obs.nativeIds,
    details: obs.payload, sourceKey: obs.source.logicalKey, position: obs.position,
  };
  evidence[id] = ev;
}

/**
 * Reconciles ADR-002 observations into in-memory `SentraState` (and optional on-demand `evidence` map).
 * Idempotent under repeated runs and `.jsonl` -> `.jsonl.zst` transitions.
 */
export function reconcileObservations(
  state: SentraState,
  evidence: Record<string, RuntimeEvidenceRecord> | undefined,
  observations: ReadonlyArray<ObservationEnvelope<JsonObject>>
): ReconcileSummary {
  const summary: ReconcileSummary = {
    processed: 0, inferencesAdded: 0, inferencesUpdated: 0,
    syntheticSkipped: 0, conflicts: 0, diagnostics: [],
  };

  const scratch: BatchScratch = {
    latestTurnModel: new Map(),
    latestContextWindow: new Map(),
    posCounter: new Map(),
    quotaIndex: new Map(),
    latestFingerprints: new Map(),
  };

  // Seed incremental model & contextWindow from existing state so appended Codex inferences keep context across batches.
  for (const s of Object.values(state.sessions)) {
    if (s.primaryModel) scratch.latestTurnModel.set(s.id, s.primaryModel);
  }
  for (const snap of Object.values(state.usageSnapshots)) {
    if (snap.sessionId && snap.modelContextWindow !== undefined) {
      scratch.latestContextWindow.set(snap.sessionId, snap.modelContextWindow);
    }
  }
  for (const inf of Object.values(state.inferences)) {
    if (inf.ownerSessionId && inf.tokens.contextWindow !== undefined && !scratch.latestContextWindow.has(inf.ownerSessionId)) {
      scratch.latestContextWindow.set(inf.ownerSessionId, inf.tokens.contextWindow);
    }
  }

  for (const q of state.quotaSnapshots) {
    const k = `${q.categoryKey}|${quotaFingerprint(q.limitId, q.limitName, q.planType, q.windows)}`;
    const arr = scratch.quotaIndex.get(k);
    if (arr) arr.push(q);
    else scratch.quotaIndex.set(k, [q]);
  }
  for (const [cat, q] of Object.entries(state.latestQuotaByCategory)) {
    scratch.latestFingerprints.set(cat, quotaFingerprint(q.limitId, q.limitName, q.planType, q.windows));
  }

  for (const obs of observations) {
    summary.processed += 1;
    const session = resolveObservationSession(state, obs);
    if (obs.category === 'lifecycle') reconcileLifecycle(state, scratch, obs, session);
    else if (obs.category === 'usage_point') reconcileInference(state, scratch, obs, summary, session);
    else if (obs.category === 'usage_snapshot') reconcileSnapshot(state, scratch, obs, session);
    else if (obs.category === 'runtime_evidence' && evidence) reconcileEvidence(evidence, scratch, obs, session);
  }

  return summary;
}
