import { asNum, asObj, type JsonObject } from '../acquisition/types.js';
import type { MetricProvenance, NormalizedTokens } from './model.js';

/**
 * Normalizes Codex native usage (`input_tokens` already includes `cached_input_tokens`;
 * `output_tokens` already includes `reasoning_output_tokens`).
 * Partition: `uncachedInputTokens` excludes both `cacheReadTokens` and `cacheWriteTokens`.
 * When `cache_write_input_tokens > 0`, its overlap semantics with `input_tokens` are not
 * assumed from `input + output === total`; `uncachedInputTokens` is left undefined (`partial`).
 */
export function normalizeCodexUsage(
  rawUsage: unknown,
  contextWindow?: number
): NormalizedTokens | undefined {
  const u = asObj(rawUsage);
  if (!u) return undefined;

  const totalInput = asNum(u.input_tokens);
  const cacheRead = asNum(u.cached_input_tokens);
  const cacheWrite = asNum(u.cache_write_input_tokens);
  const output = asNum(u.output_tokens);
  const reasoning = asNum(u.reasoning_output_tokens);
  const total = asNum(u.total_tokens);

  if (
    totalInput === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    output === undefined &&
    reasoning === undefined &&
    total === undefined
  ) {
    return undefined;
  }

  let uncachedInput: number | undefined;
  let provenance: MetricProvenance = 'observed';

  if (cacheWrite !== undefined && cacheWrite > 0) {
    // Unverified cache_write overlap semantics on non-native Codex providers: keep undefined.
    uncachedInput = undefined;
    provenance = 'partial';
  } else if (totalInput !== undefined && cacheRead !== undefined) {
    if (totalInput >= cacheRead) {
      uncachedInput = totalInput - cacheRead;
      provenance = 'derived';
    } else {
      provenance = 'partial';
    }
  } else {
    provenance = 'partial';
  }

  return {
    ...(totalInput !== undefined ? { totalInputTokens: totalInput } : {}),
    ...(uncachedInput !== undefined ? { uncachedInputTokens: uncachedInput } : {}),
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    ...(total !== undefined ? { totalTokens: total } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    provenance,
  };
}

/**
 * Normalizes Claude Code `assistant.message.usage`:
 * - `input_tokens` is strictly uncached input.
 * - `totalInputTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.
 * - `output_tokens_details.thinking_tokens` (verified <= `output_tokens` on real logs)
 *   is preserved as `reasoningTokens` without adding it again to `outputTokens`.
 */
export function normalizeClaudeUsage(
  rawUsage: unknown,
  contextWindow?: number
): NormalizedTokens | undefined {
  const u = asObj(rawUsage);
  if (!u) return undefined;

  const uncachedInput = asNum(u.input_tokens);
  const cacheRead = asNum(u.cache_read_input_tokens);
  const cacheWrite = asNum(u.cache_creation_input_tokens);
  const output = asNum(u.output_tokens);

  const cc = asObj(u.cache_creation);
  const ephemeral5m = asNum(cc?.ephemeral_5m_input_tokens);
  const ephemeral1h = asNum(cc?.ephemeral_1h_input_tokens);
  const cacheCreationBreakdown =
    ephemeral5m !== undefined || ephemeral1h !== undefined
      ? {
          ...(ephemeral5m !== undefined ? { ephemeral5m } : {}),
          ...(ephemeral1h !== undefined ? { ephemeral1h } : {}),
        }
      : undefined;

  const outDetails = asObj(u.output_tokens_details);
  const rawThinking = asNum(outDetails?.thinking_tokens);
  // Only accept thinking_tokens as a verified component of output_tokens when <= output_tokens.
  const reasoning =
    rawThinking !== undefined && (output === undefined || rawThinking <= output)
      ? rawThinking
      : undefined;

  if (
    uncachedInput === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    output === undefined &&
    reasoning === undefined
  ) {
    return undefined;
  }

  const totalInput =
    uncachedInput !== undefined
      ? uncachedInput + (cacheRead ?? 0) + (cacheWrite ?? 0)
      : undefined;
  const total =
    totalInput !== undefined && output !== undefined ? totalInput + output : undefined;

  const provenance: MetricProvenance =
    totalInput !== undefined && output !== undefined ? 'derived' : 'partial';

  return {
    ...(totalInput !== undefined ? { totalInputTokens: totalInput } : {}),
    ...(uncachedInput !== undefined ? { uncachedInputTokens: uncachedInput } : {}),
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    ...(total !== undefined ? { totalTokens: total } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(cacheCreationBreakdown ? { cacheCreationBreakdown } : {}),
    provenance,
  };
}

/** True when a usage record carries verifiable non-zero token consumption. */
export function hasPositiveConsumption(tokens: NormalizedTokens | undefined): boolean {
  if (!tokens) return false;
  return (
    (tokens.totalInputTokens ?? 0) > 0 ||
    (tokens.uncachedInputTokens ?? 0) > 0 ||
    (tokens.cacheReadTokens ?? 0) > 0 ||
    (tokens.cacheWriteTokens ?? 0) > 0 ||
    (tokens.outputTokens ?? 0) > 0 ||
    (tokens.totalTokens ?? 0) > 0
  );
}

export function extractRawUsage(raw: unknown): JsonObject {
  const obj = asObj(raw);
  if (!obj) return {};
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}
