import {
  asObj,
  asStr,
  asTs,
  compactIds,
  pick,
  pickNums,
  type DiagnosticEvent,
  type JsonObject,
  type ObservationEnvelope,
  type SourcePosition,
  type SourceRef,
} from '../../acquisition/types.js';

export interface CodexParseContext {
  harnessVersion?: string;
  sessionId?: string;
  parentThreadId?: string;
}

export interface CodexParseResult {
  observations: Array<ObservationEnvelope<JsonObject>>;
  diagnostics: DiagnosticEvent[];
}

const USAGE_KEYS = [
  'input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
  'output_tokens', 'reasoning_output_tokens', 'total_tokens',
] as const;

const SESSION_META_KEYS = [
  'id', 'session_id', 'parent_thread_id', 'cli_version', 'cwd', 'runtime_workspace_roots',
  'model_provider', 'context_window', 'originator', 'source', 'thread_source',
  'history_mode', 'history_base', 'agent_nickname', 'agent_role', 'agent_path', 'multi_agent_version',
] as const;

const TURN_CONTEXT_KEYS = [
  'turn_id', 'root_turn_id', 'model', 'effort', 'cwd', 'approval_policy', 'sandbox_policy',
  'file_system_sandbox_policy', 'collaboration_mode', 'permission_profile',
  'active_permission_profile', 'disabled_plugin_ids', 'comp_hash', 'multi_agent_version',
] as const;

const RATE_LIMIT_KEYS = [
  'limit_id', 'limit_name', 'plan_type', 'credits', 'individual_limit',
  'rate_limit_reached_type', 'spend_control_reached',
] as const;

const MODEL_META_KEYS = [
  'slug', 'display_name', 'context_window', 'max_context_window',
  'effective_context_window_percent', 'default_reasoning_level',
  'default_reasoning_summary', 'supported_reasoning_levels', 'service_tiers',
] as const;

/** Content/output records skipped intentionally so prompts and tool outputs are never captured. */
const IGNORED_EVENTS = new Set([
  'response_item/message', 'response_item/reasoning', 'response_item/function_call_output',
  'response_item/custom_tool_call_output', 'response_item/agent_message', 'response_item/compaction',
  'event_msg/item_completed', 'event_msg/agent_message', 'event_msg/agent_reasoning',
  'event_msg/user_message', 'event_msg/exec_command_begin', 'event_msg/exec_command_end',
  'event_msg/patch_apply_begin', 'event_msg/patch_apply_end',
]);

function pickRateWindow(raw: unknown): JsonObject | undefined {
  const w = asObj(raw);
  if (!w) return undefined;
  const out = pick(w, ['used_percent', 'window_minutes', 'resets_at']);
  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseCodexRolloutRecord(
  raw: unknown,
  source: SourceRef,
  position: SourcePosition,
  ctx: CodexParseContext
): CodexParseResult {
  const rec = asObj(raw);
  if (!rec) return { observations: [], diagnostics: [] };

  const topType = asStr(rec.type);
  const timestamp = asTs(rec.timestamp);
  const p = asObj(rec.payload);

  if (!topType) {
    return {
      observations: [],
      diagnostics: [{
        severity: 'warn', code: 'unknown_event_type', provider: 'codex',
        sourcePath: source.path, position, message: 'Codex rollout record missing type',
      }],
    };
  }

  const emit = (
    category: ObservationEnvelope['category'],
    eventType: string,
    nativeIds: ObservationEnvelope['nativeIds'],
    payload: JsonObject,
    ts: string | number | undefined = timestamp
  ): CodexParseResult => ({
    observations: [{
      provider: 'codex', category, eventType, nativeIds: compactIds(nativeIds),
      timestamp: ts, harnessVersion: ctx.harnessVersion, source, position, payload,
    }],
    diagnostics: [],
  });

  if (topType === 'session_meta' && p) {
    const cliVersion = asStr(p.cli_version);
    const id = asStr(p.id);
    const parentThreadId = asStr(p.parent_thread_id);
    // Keep subagent thread identity distinct when Codex shares parent's `session_id`.
    const sessionId = parentThreadId && id ? id : (asStr(p.session_id) ?? id);
    if (cliVersion) ctx.harnessVersion = cliVersion;
    if (sessionId) ctx.sessionId = sessionId;
    if (parentThreadId) ctx.parentThreadId = parentThreadId;
    const git = asObj(p.git);
    return emit(
      'lifecycle', 'session_meta',
      { sessionId, threadId: id, parentThreadId: asStr(p.parent_thread_id) },
      { kind: 'session_meta', ...pick(p, SESSION_META_KEYS), ...(git ? pick(git, ['branch', 'commit_hash']) : {}) },
      timestamp ?? asTs(p.timestamp)
    );
  }

  if (topType === 'turn_context' && p) {
    return emit(
      'lifecycle', 'turn_context',
      { sessionId: ctx.sessionId, turnId: asStr(p.turn_id), rootTurnId: asStr(p.root_turn_id) },
      { kind: 'turn_context', ...pick(p, TURN_CONTEXT_KEYS) }
    );
  }

  if (topType === 'token_usage_record' && p) {
    const usage = pickNums(p.usage, USAGE_KEYS);
    const turnUsage = pickNums(p.turn_token_usage, USAGE_KEYS);
    const threadUsage = pickNums(p.thread_token_usage, USAGE_KEYS);
    const rawSessionId = asStr(p.session_id);
    const threadId = asStr(p.thread_id);
    // On Codex subagent rollouts, `payload.session_id` carries the parent ID while `payload.thread_id` is the subagent.
    const inferredParent =
      ctx.parentThreadId ?? (rawSessionId && threadId && rawSessionId !== threadId ? rawSessionId : undefined);
    const sessionId = inferredParent ? (threadId ?? ctx.sessionId) : (rawSessionId ?? ctx.sessionId);
    return emit(
      'usage_point', 'token_usage_record',
      {
        sessionId,
        threadId,
        parentThreadId: inferredParent,
        turnId: asStr(p.turn_id),
        rootTurnId: asStr(p.root_turn_id),
        responseId: asStr(p.response_id),
      },
      {
        kind: 'token_usage_record',
        ...(usage ? { usage } : {}),
        ...(turnUsage ? { turn_token_usage: turnUsage } : {}),
        ...(threadUsage ? { thread_token_usage: threadUsage } : {}),
      }
    );
  }

  if (topType === 'compacted' && p) {
    const latestTur = asObj(p.latest_token_usage_record);
    const latestUsage = pickNums(latestTur?.usage ?? latestTur, USAGE_KEYS);
    return emit(
      'lifecycle', 'compacted',
      { sessionId: ctx.sessionId, responseId: asStr(p.compaction_response_id) },
      {
        kind: 'compacted',
        ...pick(p, [
          'window_id', 'window_number', 'first_window_id', 'previous_window_id',
          'compaction_response_id', 'replacement_history_metadata', 'resume_metadata',
        ]),
        ...(latestUsage ? { latest_token_usage: latestUsage } : {}),
      }
    );
  }

  if (topType === 'world_state' && p) {
    const st = asObj(p.state);
    return emit('runtime_evidence', 'world_state', { sessionId: ctx.sessionId }, {
      kind: 'world_state',
      hasFull: p.full !== undefined && p.full !== null,
      stateKeys: st ? Object.keys(st).sort() : [],
    });
  }

  if (topType === 'inter_agent_communication_metadata' && p) {
    return emit(
      'runtime_evidence', 'inter_agent_communication_metadata',
      { sessionId: ctx.sessionId, threadId: asStr(p.thread_id) },
      { kind: 'inter_agent_communication_metadata', metadataKeys: Object.keys(p).sort() }
    );
  }

  const subType = asStr(p?.type);
  const fullType = subType ? `${topType}/${subType}` : topType;

  if (topType === 'event_msg' && p && subType) {
    if (subType === 'token_count') {
      const info = asObj(p.info);
      const rl = asObj(p.rate_limits);
      const primary = pickRateWindow(rl?.primary);
      const secondary = pickRateWindow(rl?.secondary);
      const rateLimits = rl
        ? { ...pick(rl, RATE_LIMIT_KEYS), ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}) }
        : undefined;
      const lastUsage = pickNums(info?.last_token_usage, USAGE_KEYS);
      const totalUsage = pickNums(info?.total_token_usage, USAGE_KEYS);
      return emit('usage_snapshot', fullType, { sessionId: ctx.sessionId, turnId: asStr(p.turn_id) }, {
        kind: 'token_count',
        ...(lastUsage ? { last_token_usage: lastUsage } : {}),
        ...(totalUsage ? { total_token_usage: totalUsage } : {}),
        ...(info ? pick(info, ['last_usage_includes_reasoning', 'model_context_window']) : {}),
        ...(rateLimits && Object.keys(rateLimits).length > 0 ? { rate_limits: rateLimits } : {}),
      });
    }

    if (subType === 'task_started' || subType === 'task_complete' || subType === 'turn_aborted') {
      return emit('lifecycle', fullType, { sessionId: ctx.sessionId, turnId: asStr(p.turn_id) }, {
        kind: 'turn_lifecycle',
        event: subType,
        ...pick(p, ['turn_id', 'reason', 'model_context_window', 'collaboration_mode_kind']),
      });
    }

    if (subType === 'thread_settings_applied') {
      return emit('runtime_evidence', fullType, { sessionId: ctx.sessionId }, {
        kind: 'thread_settings_applied',
        settingsKeys: Object.keys(p).filter((k) => k !== 'type').sort(),
      });
    }
  }

  if (topType === 'response_item' && p && subType) {
    if (subType === 'function_call' || subType === 'custom_tool_call' || subType === 'web_search_call') {
      return emit('runtime_evidence', fullType, { sessionId: ctx.sessionId, callId: asStr(p.call_id) }, {
        kind: 'tool_call',
        toolKind: subType,
        ...pick(p, ['name', 'namespace', 'call_id', 'id', 'status']),
        ...(subType === 'web_search_call' && !p.name ? { name: 'web_search' } : {}),
      });
    }

    if (subType === 'additional_tools') {
      const tools = Array.isArray(p.tools) ? p.tools : [];
      const toolNames = tools
        .map((t) => asStr(asObj(t)?.name) ?? asStr(asObj(asObj(t)?.function)?.name))
        .filter((n): n is string => Boolean(n));
      return emit('runtime_evidence', fullType, { sessionId: ctx.sessionId }, {
        kind: 'additional_tools',
        ...pick(p, ['id', 'role']),
        toolNames,
        toolCount: tools.length,
      });
    }
  }

  if (IGNORED_EVENTS.has(fullType)) return { observations: [], diagnostics: [] };

  return {
    observations: [],
    diagnostics: [{
      severity: 'info', code: 'unknown_event_type', provider: 'codex',
      sourcePath: source.path, position, message: `Unrecognized Codex event type: ${fullType}`,
    }],
  };
}

export function parseCodexSessionIndexRecord(
  raw: unknown,
  source: SourceRef,
  position: SourcePosition
): CodexParseResult {
  const obj = asObj(raw);
  if (!obj) return { observations: [], diagnostics: [] };
  const id = asStr(obj.id);
  return {
    observations: [{
      provider: 'codex',
      category: 'lifecycle',
      eventType: 'session_index_entry',
      nativeIds: compactIds({ sessionId: id, threadId: id }),
      timestamp: asTs(obj.updated_at),
      source,
      position,
      payload: { kind: 'session_index_entry', ...pick(obj, ['id', 'thread_name', 'updated_at']) },
    }],
    diagnostics: [],
  };
}

export function parseCodexModelsCache(raw: unknown, source: SourceRef): CodexParseResult {
  const obj = asObj(raw);
  if (!obj) return { observations: [], diagnostics: [] };
  const models = (Array.isArray(obj.models) ? obj.models : [])
    .map(asObj)
    .filter((m): m is JsonObject => Boolean(m && asStr(m.slug)))
    .map((m) => pick(m, MODEL_META_KEYS));

  // Excludes `identity` intentionally.
  return {
    observations: [{
      provider: 'codex',
      category: 'runtime_evidence',
      eventType: 'models_cache',
      nativeIds: {},
      timestamp: asTs(obj.fetched_at),
      harnessVersion: asStr(obj.client_version),
      source,
      position: { kind: 'document', fieldPath: 'models' },
      payload: { kind: 'models_cache', ...pick(obj, ['client_version', 'fetched_at']), models },
    }],
    diagnostics: [],
  };
}
