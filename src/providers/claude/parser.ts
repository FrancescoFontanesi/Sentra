import {
  asNum,
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

export interface ClaudeTranscriptContext {
  agentId?: string;
  parentSessionId?: string;
}

export interface ClaudeParseResult {
  observations: Array<ObservationEnvelope<JsonObject>>;
  diagnostics: DiagnosticEvent[];
}

const USER_KEYS = [
  'cwd', 'gitBranch', 'entrypoint', 'isSidechain', 'isMeta', 'isCompactSummary',
  'promptSource', 'turnOrigin', 'turnPosition', 'turnAttributionKey',
  'permissionMode', 'permissionDecision', 'toolDenialKind',
  'sourceToolUseID', 'sourceToolAssistantUUID', 'sandboxed',
] as const;

const ASSISTANT_META_KEYS = [
  'cwd', 'gitBranch', 'entrypoint', 'isSidechain', 'requestedModel', 'advisorModel',
  'effort', 'perTurnEffort', 'promptCacheRequested', 'thinkingDisplay',
  'thinkingDurationMs', 'toolInputStreamMs', 'isApiErrorMessage', 'apiErrorType', 'apiErrorStatus',
] as const;

const ATTRIBUTION_KEYS = [
  'attributionAgent', 'attributionMcpServer', 'attributionMcpTool', 'attributionPlugin', 'attributionSkill',
] as const;

const USAGE_NUM_KEYS = [
  'input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens',
] as const;

const USAGE_EXTRA_KEYS = [
  'service_tier', 'speed', 'inference_geo', 'server_tool_use', 'iterations', 'output_tokens_details',
] as const;

const COST_STATE_KEYS = [
  'startTime', 'totalCostUSD', 'hasUnknownModelCost', 'modelUsage',
  'totalDuration', 'totalAPIDuration', 'totalAPIDurationWithoutRetries',
  'totalToolDuration', 'totalLinesAdded', 'totalLinesRemoved',
] as const;

const STOP_HOOK_KEYS = [
  'cwd', 'isSidechain', 'hookCount', 'hookInfos', 'hookErrors',
  'failedHookErrorIndexes', 'hasOutput', 'preventedContinuation', 'stopReason',
] as const;

const SUBAGENT_META_KEYS = [
  'agentType', 'model', 'effort', 'pickedEffortModel', 'isBuiltIn',
  'launchedWithDefaults', 'spawnDepth', 'toolUseId', 'finished', 'requestNonInteractive',
] as const;

const RUNTIME_SESSION_KEYS = [
  'pid', 'pidDomain', 'procStart', 'cwd', 'entrypoint', 'kind',
  'name', 'status', 'startedAt', 'updatedAt', 'statusUpdatedAt',
] as const;

const IGNORED_TYPES = new Set([
  'agent-name', 'ai-title', 'api-request-blob', 'atis-latch', 'attachment', 'custom-title',
  'data-flow-incomplete', 'data-flow-records', 'file-history-delta', 'file-history-snapshot',
  'last-prompt', 'mode', 'pr-link', 'progress', 'queue-operation', 'session-owner',
  'summary', 'system:informational', 'system:local_command',
]);

function extractUsage(raw: unknown): JsonObject | undefined {
  const u = asObj(raw);
  if (!u) return undefined;
  const out: JsonObject = { ...(pickNums(u, USAGE_NUM_KEYS) ?? {}), ...pick(u, USAGE_EXTRA_KEYS) };
  const cc = pickNums(u.cache_creation, ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens']);
  if (cc) out.cache_creation = cc;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseClaudeTranscriptRecord(
  raw: unknown,
  source: SourceRef,
  position: SourcePosition,
  ctx: ClaudeTranscriptContext = {}
): ClaudeParseResult {
  const rec = asObj(raw);
  if (!rec) return { observations: [], diagnostics: [] };

  const rawType = asStr(rec.type);
  if (!rawType) {
    return {
      observations: [],
      diagnostics: [{
        severity: 'warn', code: 'unknown_event_type', provider: 'claude',
        sourcePath: source.path, position, message: 'Claude transcript record missing type',
      }],
    };
  }

  const subtype = asStr(rec.subtype);
  const fullType = subtype ? `${rawType}:${subtype}` : rawType;
  const sessionId = asStr(rec.sessionId) ?? ctx.parentSessionId;
  const agentId = asStr(rec.agentId) ?? ctx.agentId;
  const timestamp = asTs(rec.timestamp);
  const harnessVersion = asStr(rec.version);

  const makeObs = (
    category: ObservationEnvelope['category'],
    eventType: string,
    nativeIds: ObservationEnvelope['nativeIds'],
    payload: JsonObject,
    ts = timestamp
  ): ObservationEnvelope<JsonObject> => ({
    provider: 'claude', category, eventType, nativeIds: compactIds(nativeIds),
    timestamp: ts, harnessVersion, source, position, payload,
  });

  if (rawType === 'user') {
    const mcpMeta = asObj(rec.mcpMeta);
    const msgContent = asObj(rec.message)?.content;
    // Flag tool-result user frames as a boolean without ever capturing toolUseResult payloads.
    const isToolResult =
      rec.toolUseResult !== undefined ||
      (Array.isArray(msgContent) &&
        msgContent.length > 0 &&
        msgContent.every((b) => asObj(b)?.type === 'tool_result'));
    return {
      observations: [makeObs(
        'lifecycle', 'user',
        {
          sessionId, agentId, uuid: asStr(rec.uuid), parentUuid: asStr(rec.parentUuid),
          turnPromptId: asStr(rec.turnPromptId), promptId: asStr(rec.promptId), toolUseId: asStr(rec.sourceToolUseID),
        },
        {
          kind: 'user_turn',
          ...pick(rec, USER_KEYS),
          ...(isToolResult ? { isToolResult: true } : {}),
          ...(mcpMeta ? { mcpMetaKeys: Object.keys(mcpMeta).sort() } : {}),
        }
      )],
      diagnostics: [],
    };
  }

  if (rawType === 'assistant') {
    const msg = asObj(rec.message);
    const content = Array.isArray(msg?.content) ? msg.content : [];
    const attribution = pick(rec, ATTRIBUTION_KEYS);
    const hasAttr = Object.keys(attribution).length > 0;

    let thinkingBlockCount = 0;
    const toolUses: Array<{ id?: string; name?: string }> = [];
    for (const b of content) {
      const bObj = asObj(b);
      if (bObj?.type === 'thinking') thinkingBlockCount += 1;
      else if (bObj?.type === 'tool_use') toolUses.push({ id: asStr(bObj.id), name: asStr(bObj.name) });
    }

    const baseIds = {
      sessionId, agentId, uuid: asStr(rec.uuid), parentUuid: asStr(rec.parentUuid),
      messageId: asStr(msg?.id), requestId: asStr(rec.requestId),
      requestRef: asStr(rec.requestRef), apiBlockIndex: asNum(rec.apiBlockIndex),
    };

    const observations: Array<ObservationEnvelope<JsonObject>> = [];
    const usage = extractUsage(msg?.usage);
    if (usage) {
      observations.push(makeObs('usage_point', 'assistant', baseIds, {
        kind: 'assistant_usage',
        ...pick(rec, ASSISTANT_META_KEYS),
        ...(asStr(msg?.model) !== undefined ? { actualModel: asStr(msg?.model) } : {}),
        ...(msg?.stop_reason !== undefined ? { stopReason: msg.stop_reason } : {}),
        hasThinkingBlocks: thinkingBlockCount > 0,
        thinkingBlockCount,
        ...(hasAttr ? { attribution } : {}),
        usage,
      }));
    }

    if (rec.quotaLimits !== undefined && rec.quotaLimits !== null) {
      observations.push(makeObs('usage_snapshot', 'quotaLimits', baseIds, {
        kind: 'quota_limits', quotaLimits: rec.quotaLimits,
      }));
    }

    for (const t of toolUses) {
      observations.push(makeObs('runtime_evidence', 'tool_use', { ...baseIds, toolUseId: t.id }, {
        kind: 'tool_use', toolUseId: t.id, toolName: t.name, ...(hasAttr ? { attribution } : {}),
      }));
    }
    return { observations, diagnostics: [] };
  }

  if (rawType === 'cost-state') {
    return {
      observations: [makeObs(
        'usage_snapshot', 'cost-state', { sessionId, agentId },
        { kind: 'cost_state', ...pick(rec, COST_STATE_KEYS) },
        timestamp ?? asTs(rec.startTime)
      )],
      diagnostics: [],
    };
  }

  if (rawType === 'quotaLimits') {
    return {
      observations: [makeObs('usage_snapshot', 'quotaLimits', { sessionId, agentId, uuid: asStr(rec.uuid) }, {
        kind: 'quota_limits', quotaLimits: rec.quotaLimits ?? rec.limits ?? rec,
      })],
      diagnostics: [],
    };
  }

  if (rawType === 'derived-from') {
    return {
      observations: [makeObs('lifecycle', 'derived-from', { sessionId }, {
        kind: 'derived_from', ...pick(rec, ['sessions', 'v']),
      })],
      diagnostics: [],
    };
  }

  if (fullType === 'system:compact_boundary') {
    return {
      observations: [makeObs(
        'lifecycle', fullType,
        { sessionId, agentId, uuid: asStr(rec.uuid), parentUuid: asStr(rec.parentUuid), logicalParentUuid: asStr(rec.logicalParentUuid) },
        { kind: 'compact_boundary', ...pick(rec, ['cwd', 'isSidechain', 'compactMetadata']) }
      )],
      diagnostics: [],
    };
  }

  if (fullType === 'system:stop_hook_summary') {
    return {
      observations: [makeObs(
        'runtime_evidence', fullType,
        { sessionId, agentId, uuid: asStr(rec.uuid), parentUuid: asStr(rec.parentUuid), toolUseId: asStr(rec.toolUseID) },
        { kind: 'stop_hook_summary', ...pick(rec, STOP_HOOK_KEYS) }
      )],
      diagnostics: [],
    };
  }

  if (rawType === 'api-request') {
    const params = asObj(rec.params);
    return {
      observations: [makeObs('runtime_evidence', 'api-request', { sessionId, agentId, requestId: asStr(rec.id) }, {
        kind: 'api_request',
        ...pick(rec, ['id', 'shapeHash', 'requestDigest', 'querySource', 'cacheControl']),
        ...(params ? { paramsKeys: Object.keys(params).sort() } : {}),
      })],
      diagnostics: [],
    };
  }

  if (rawType === 'api-request-shape') {
    const shape = asObj(rec.shape);
    return {
      observations: [makeObs('runtime_evidence', 'api-request-shape', { sessionId, agentId }, {
        kind: 'api_request_shape',
        ...pick(rec, ['shapeHash']),
        shapeKeys: shape ? Object.keys(shape).sort() : [],
      })],
      diagnostics: [],
    };
  }

  if (rawType === 'tools-used') {
    const tools = Array.isArray(rec.tools) ? rec.tools.filter((t): t is string => typeof t === 'string') : [];
    return {
      observations: [makeObs('runtime_evidence', 'tools-used', { sessionId, agentId }, { kind: 'tools_used', tools })],
      diagnostics: [],
    };
  }

  if (IGNORED_TYPES.has(fullType) || IGNORED_TYPES.has(rawType)) {
    return { observations: [], diagnostics: [] };
  }

  return {
    observations: [],
    diagnostics: [{
      severity: 'info', code: 'unknown_event_type', provider: 'claude',
      sourcePath: source.path, position, message: `Unrecognized Claude Code event type: ${fullType}`,
    }],
  };
}

export function parseClaudeSubagentMeta(
  raw: unknown,
  source: SourceRef,
  ctx: ClaudeTranscriptContext
): ClaudeParseResult {
  const obj = asObj(raw);
  if (!obj) return { observations: [], diagnostics: [] };
  return {
    observations: [{
      provider: 'claude',
      category: 'lifecycle',
      eventType: 'subagent_meta',
      nativeIds: compactIds({ sessionId: ctx.parentSessionId, agentId: ctx.agentId, toolUseId: asStr(obj.toolUseId) }),
      source,
      position: { kind: 'document' },
      payload: {
        kind: 'subagent_meta',
        parentSessionId: ctx.parentSessionId,
        agentId: ctx.agentId,
        ...pick(obj, SUBAGENT_META_KEYS),
      },
    }],
    diagnostics: [],
  };
}

export function parseClaudeRuntimeSession(raw: unknown, source: SourceRef): ClaudeParseResult {
  const obj = asObj(raw);
  if (!obj) return { observations: [], diagnostics: [] };
  return {
    observations: [{
      provider: 'claude',
      category: 'lifecycle',
      eventType: 'runtime_session',
      nativeIds: compactIds({ sessionId: asStr(obj.sessionId), pid: asNum(obj.pid) }),
      timestamp: asTs(obj.updatedAt) ?? asTs(obj.statusUpdatedAt) ?? asTs(obj.startedAt),
      harnessVersion: asStr(obj.version),
      source,
      position: { kind: 'document' },
      payload: { kind: 'runtime_session', ...pick(obj, RUNTIME_SESSION_KEYS) },
    }],
    diagnostics: [],
  };
}

const SENSITIVE_KEY_RE = /account|email|org|token|secret|oauth/i;

function sanitizeUtilization(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(sanitizeUtilization);
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(val as JsonObject)) {
    if (!SENSITIVE_KEY_RE.test(k)) out[k] = sanitizeUtilization(v);
  }
  return out;
}

/** Extracts ONLY `cachedUsageUtilization` (timestamp + reset/utilization windows), excluding `accountUuid`. */
export function parseClaudeCachedUsageUtilization(raw: unknown, source: SourceRef): ClaudeParseResult {
  const cached = asObj(asObj(raw)?.cachedUsageUtilization);
  if (!cached) return { observations: [], diagnostics: [] };
  const fetchedAtMs = asNum(cached.fetchedAtMs);
  const util = asObj(cached.utilization);
  return {
    observations: [{
      provider: 'claude',
      category: 'usage_snapshot',
      eventType: 'cachedUsageUtilization',
      nativeIds: {},
      timestamp: fetchedAtMs,
      source,
      position: { kind: 'document', fieldPath: 'cachedUsageUtilization' },
      payload: {
        kind: 'cached_usage_utilization',
        isCachedSnapshot: true,
        ...(fetchedAtMs !== undefined ? { fetchedAtMs } : {}),
        utilization: util ? sanitizeUtilization(util) : {},
      },
    }],
    diagnostics: [],
  };
}
