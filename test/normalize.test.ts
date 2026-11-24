import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasPositiveConsumption,
  normalizeClaudeUsage,
  normalizeCodexUsage,
} from '../src/core/normalize.js';

test('normalizeCodexUsage partitions uncached/cacheRead cleanly and does not double-count reasoning', () => {
  const n = normalizeCodexUsage(
    {
      input_tokens: 1200,
      cached_input_tokens: 400,
      cache_write_input_tokens: 0,
      output_tokens: 340,
      reasoning_output_tokens: 80,
      total_tokens: 1540,
    },
    272000
  );
  assert.deepEqual(n, {
    totalInputTokens: 1200,
    uncachedInputTokens: 800,
    cacheReadTokens: 400,
    cacheWriteTokens: 0,
    outputTokens: 340,
    reasoningTokens: 80,
    totalTokens: 1540,
    contextWindow: 272000,
    provenance: 'derived',
  });
  // Partition invariant: uncached + cacheRead + cacheWrite === totalInput.
  assert.equal((n.uncachedInputTokens ?? 0) + (n.cacheReadTokens ?? 0) + (n.cacheWriteTokens ?? 0), n.totalInputTokens);
});

test('normalizeCodexUsage preserves 0 vs undefined and leaves uncachedInput undefined when cache_write > 0', () => {
  // Missing cached_input_tokens -> uncachedInput stays undefined (never assumes 0).
  const missingCached = normalizeCodexUsage({ input_tokens: 500, output_tokens: 100, total_tokens: 600 });
  assert.equal(missingCached?.cacheReadTokens, undefined);
  assert.equal(missingCached?.uncachedInputTokens, undefined);
  assert.equal(missingCached?.provenance, 'partial');

  // Explicit 0 cached_input_tokens -> derived uncachedInput === input_tokens.
  const zeroCached = normalizeCodexUsage({ input_tokens: 500, cached_input_tokens: 0, output_tokens: 100, total_tokens: 600 });
  assert.equal(zeroCached?.cacheReadTokens, 0);
  assert.equal(zeroCached?.uncachedInputTokens, 500);
  assert.equal(zeroCached?.provenance, 'derived');

  // Positive cache_write_input_tokens: even if input + output === total, do NOT guess overlap semantics.
  const nonNativeCacheWrite = normalizeCodexUsage({
    input_tokens: 1000,
    cached_input_tokens: 200,
    cache_write_input_tokens: 300,
    output_tokens: 100,
    total_tokens: 1100,
  });
  assert.equal(nonNativeCacheWrite?.cacheWriteTokens, 300);
  assert.equal(nonNativeCacheWrite?.uncachedInputTokens, undefined);
  assert.equal(nonNativeCacheWrite?.provenance, 'partial');
});

test('normalizeClaudeUsage sums input buckets, preserves cache breakdown and verified thinking_tokens', () => {
  const n = normalizeClaudeUsage({
    input_tokens: 100,
    cache_read_input_tokens: 500,
    cache_creation_input_tokens: 200,
    cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 },
    output_tokens: 150,
    output_tokens_details: { thinking_tokens: 60 },
  });
  assert.deepEqual(n, {
    totalInputTokens: 800,
    uncachedInputTokens: 100,
    cacheReadTokens: 500,
    cacheWriteTokens: 200,
    outputTokens: 150,
    reasoningTokens: 60,
    totalTokens: 950,
    cacheCreationBreakdown: { ephemeral5m: 200, ephemeral1h: 0 },
    provenance: 'derived',
  });
  // Thinking tokens are NOT added again to outputTokens or totalTokens.
  assert.equal(n.outputTokens, 150);
  assert.equal(n.totalTokens, 950);

  // Unverifiable thinking_tokens > output_tokens is dropped rather than assumed valid.
  const badThinking = normalizeClaudeUsage({
    input_tokens: 10,
    output_tokens: 20,
    output_tokens_details: { thinking_tokens: 99 },
  });
  assert.equal(badThinking?.reasoningTokens, undefined);

  // Zero-token record vs positive consumption helper.
  const zero = normalizeClaudeUsage({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  assert.equal(hasPositiveConsumption(zero), false);
  assert.equal(hasPositiveConsumption(n), true);
});
