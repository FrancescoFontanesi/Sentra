import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject, ObservationEnvelope, SourceRef } from '../src/acquisition/types.js';
import { createEmptyState, type RuntimeEvidenceRecord } from '../src/core/model.js';
import { reconcileObservations } from '../src/core/reconcile.js';

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

test('Claude streaming dedup is order-independent, unifies primary/fallback keys, and flags finalized conflicts', () => {
  const chunk1 = obs({
    provider: 'claude', category: 'usage_point', eventType: 'assistant',
    nativeIds: { sessionId: 'c1', requestId: 'req-1', apiBlockIndex: 0 },
    timestamp: '2026-11-24T10:00:01Z',
    source: ref({ logicalKey: 'claude:transcript:c1' }),
    payload: { kind: 'assistant_usage', actualModel: 'claude-opus-4-6', stopReason: null, usage: { input_tokens: 100, output_tokens: 20 } },
  });
  const chunk2 = obs({
    provider: 'claude', category: 'usage_point', eventType: 'assistant',
    nativeIds: { sessionId: 'c1', messageId: 'msg-1', requestId: 'req-1', apiBlockIndex: 1 },
    timestamp: '2026-11-24T10:00:02Z',
    source: ref({ logicalKey: 'claude:transcript:c1' }),
    payload: { kind: 'assistant_usage', actualModel: 'claude-opus-4-6', stopReason: 'end_turn', usage: { input_tokens: 100, output_tokens: 90 } },
  });

  // Forward order (fallback key first, then primary messageId arrives -> migrated under claude:msg:msg-1).
  const sFwd = createEmptyState();
  reconcileObservations(sFwd, undefined, [chunk1, chunk2]);

  // Reverse order (primary messageId first, then fallback chunk).
  const sRev = createEmptyState();
  reconcileObservations(sRev, undefined, [chunk2, chunk1]);

  assert.deepEqual(Object.keys(sFwd.inferences), ['claude:msg:msg-1']);
  assert.deepEqual(Object.keys(sRev.inferences), ['claude:msg:msg-1']);
  assert.equal(sFwd.inferences['claude:msg:msg-1']?.tokens.outputTokens, 90);
  assert.equal(sRev.inferences['claude:msg:msg-1']?.tokens.outputTokens, 90);
  assert.equal(sFwd.inferences['claude:msg:msg-1']?.stopReason, 'end_turn');
  assert.equal(sRev.inferences['claude:msg:msg-1']?.stopReason, 'end_turn');
  assert.equal(sFwd.inferences['claude:msg:msg-1']?.hasConflictingDuplicates, undefined);

  // Discordant finalized duplicate sets conflict flag without summing.
  const discordant = obs({
    provider: 'claude', category: 'usage_point', eventType: 'assistant',
    nativeIds: { sessionId: 'c1', messageId: 'msg-1', requestId: 'req-1' },
    timestamp: '2026-11-24T10:00:03Z',
    source: ref({ logicalKey: 'claude:transcript:c1' }),
    payload: { kind: 'assistant_usage', actualModel: 'claude-opus-4-6', stopReason: 'end_turn', usage: { input_tokens: 100, output_tokens: 120 } },
  });
  const res = reconcileObservations(sFwd, undefined, [discordant]);
  assert.equal(res.conflicts, 1);
  assert.equal(sFwd.inferences['claude:msg:msg-1']?.hasConflictingDuplicates, true);
  assert.equal(sFwd.inferences['claude:msg:msg-1']?.tokens.outputTokens, 120);
});

test('Claude skips <synthetic> and zero-token errors, but preserves error records with verifiable consumption', () => {
  const state = createEmptyState();
  const res = reconcileObservations(state, undefined, [
    obs({
      provider: 'claude', category: 'usage_point', eventType: 'assistant',
      nativeIds: { sessionId: 'c1', messageId: 'm-synth' },
      payload: { kind: 'assistant_usage', actualModel: '<synthetic>', isApiErrorMessage: true, usage: { input_tokens: 0, output_tokens: 0 } },
    }),
    obs({
      provider: 'claude', category: 'usage_point', eventType: 'assistant',
      nativeIds: { sessionId: 'c1', messageId: 'm-err-zero' },
      payload: { kind: 'assistant_usage', actualModel: 'claude-opus-4-6', isApiErrorMessage: true, usage: { input_tokens: 0, output_tokens: 0 } },
    }),
    obs({
      provider: 'claude', category: 'usage_point', eventType: 'assistant',
      nativeIds: { sessionId: 'c1', messageId: 'm-err-real' },
      payload: { kind: 'assistant_usage', actualModel: 'claude-opus-4-6', isApiErrorMessage: true, usage: { input_tokens: 250, output_tokens: 15 } },
    }),
  ]);
  assert.equal(res.syntheticSkipped, 2);
  assert.deepEqual(Object.keys(state.inferences), ['claude:msg:m-err-real']);
  assert.equal(state.inferences['claude:msg:m-err-real']?.isApiError, true);
});

test('Fork, rollback, subagents, legacy rollouts, and .jsonl -> .jsonl.zst transition preserve accuracy and idempotency', () => {
  const state = createEmptyState();
  const evidence: Record<string, RuntimeEvidenceRecord> = {};

  const batch: Array<ObservationEnvelope<JsonObject>> = [
    // Parent Codex session + inference + rollback (must NOT delete inference).
    obs({
      provider: 'codex', category: 'lifecycle', eventType: 'session_meta',
      nativeIds: { sessionId: 'p1', threadId: 'p1' },
      timestamp: '2026-11-24T09:00:00Z',
      payload: { kind: 'session_meta', cwd: 'F:\\Work', cli_version: '0.171.0' },
    }),
    obs({
      provider: 'codex', category: 'lifecycle', eventType: 'turn_context',
      nativeIds: { sessionId: 'p1', turnId: 't1' },
      timestamp: '2026-11-24T09:00:01Z',
      payload: { kind: 'turn_context', model: 'gpt-5.4' },
    }),
    obs({
      provider: 'codex', category: 'usage_point', eventType: 'token_usage_record',
      nativeIds: { sessionId: 'p1', turnId: 't1', responseId: 'resp-shared' },
      timestamp: '2026-11-24T09:00:02Z',
      position: { kind: 'byte_range', byteOffset: 100, byteLength: 50, lineNumber: 3 },
      payload: { kind: 'token_usage_record', usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 50, total_tokens: 550 } },
    }),
    obs({
      provider: 'codex', category: 'lifecycle', eventType: 'event_msg/turn_aborted',
      nativeIds: { sessionId: 'p1', turnId: 't1' },
      timestamp: '2026-11-24T09:00:03Z',
      position: { kind: 'byte_range', byteOffset: 150, byteLength: 40, lineNumber: 4 },
      payload: { kind: 'turn_lifecycle', event: 'turn_aborted', reason: 'interrupted' },
    }),
    // Forked Codex session re-observing `resp-shared` -> must be inherited, NOT direct!
    obs({
      provider: 'codex', category: 'lifecycle', eventType: 'session_meta',
      nativeIds: { sessionId: 'fork1', threadId: 'fork1', parentThreadId: 'p1' },
      timestamp: '2026-11-24T09:05:00Z',
      source: ref({ logicalKey: 'codex:rollout:fork1' }),
      payload: { kind: 'session_meta', cwd: 'F:\\Work' },
    }),
    obs({
      provider: 'codex', category: 'usage_point', eventType: 'token_usage_record',
      nativeIds: { sessionId: 'fork1', turnId: 't1', responseId: 'resp-shared' },
      timestamp: '2026-11-24T09:00:02Z',
      source: ref({ logicalKey: 'codex:rollout:fork1' }),
      payload: { kind: 'token_usage_record', usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 50, total_tokens: 550 } },
    }),
    // Legacy Codex rollout: only token_count -> UsageSnapshotRecord, zero synthetic inferences.
    obs({
      provider: 'codex', category: 'usage_snapshot', eventType: 'event_msg/token_count',
      nativeIds: { sessionId: 'legacy1' },
      timestamp: '2025-10-01T08:00:00Z',
      source: ref({ logicalKey: 'codex:rollout:legacy1', compressed: true }),
      position: { kind: 'logical_line', lineNumber: 3, decompressedByteOffset: 0, decompressedByteLength: 40 },
      payload: { kind: 'token_count', total_token_usage: { input_tokens: 400, output_tokens: 100, total_tokens: 500 } },
    }),
    // Claude parent + subagent: separate directInferenceIds without double counting.
    obs({
      provider: 'claude', category: 'usage_point', eventType: 'assistant',
      nativeIds: { sessionId: 'cs1', messageId: 'cm-parent' },
      source: ref({ logicalKey: 'claude:transcript:cs1', kind: 'transcript' }),
      payload: { kind: 'assistant_usage', actualModel: 'claude-opus-4-6', cwd: 'F:\\Work', usage: { input_tokens: 100, output_tokens: 40 } },
    }),
    obs({
      provider: 'claude', category: 'usage_point', eventType: 'assistant',
      nativeIds: { sessionId: 'cs1', agentId: 'sub1', messageId: 'cm-sub' },
      source: ref({ logicalKey: 'claude:subagent:cs1/sub1', kind: 'subagent_transcript' }),
      payload: { kind: 'assistant_usage', actualModel: 'claude-haiku-4-5', cwd: 'F:\\Work', usage: { input_tokens: 50, output_tokens: 10 } },
    }),
    // Runtime evidence on line 5 of s1.
    obs({
      provider: 'codex', category: 'runtime_evidence', eventType: 'response_item/function_call',
      nativeIds: { sessionId: 'p1', callId: 'call-1' },
      position: { kind: 'byte_range', byteOffset: 200, byteLength: 30, lineNumber: 5 },
      payload: { kind: 'tool_call', name: 'shell_command' },
    }),
  ];

  reconcileObservations(state, evidence, batch);

  assert.equal(state.turns['codex:p1:turn:t1']?.status, 'aborted');
  assert.deepEqual(state.sessions['codex:p1']?.directInferenceIds, ['codex:resp:resp-shared']);
  assert.deepEqual(state.sessions['codex:fork1']?.directInferenceIds, []);
  assert.deepEqual(state.sessions['codex:fork1']?.inheritedInferenceIds, ['codex:resp:resp-shared']);
  assert.equal(state.usageSnapshots['codex:snap:codex:legacy1']?.totalTokens?.totalTokens, 500);
  assert.deepEqual(state.sessions['claude:cs1']?.directInferenceIds, ['claude:msg:cm-parent']);
  assert.equal(state.sessions['claude:cs1']?.isSubagent, false);
  assert.deepEqual(state.sessions['claude:cs1']?.childSessionIds, ['claude:cs1:agent:sub1']);
  assert.deepEqual(state.sessions['claude:cs1:agent:sub1']?.directInferenceIds, ['claude:msg:cm-sub']);
  assert.equal(state.sessions['claude:cs1:agent:sub1']?.isSubagent, true);

  // Out-of-order derived-from: child arrives first (alphabetically smaller ID), then parent, then derived-from.
  const forkState = createEmptyState();
  reconcileObservations(forkState, undefined, [
    obs({
      provider: 'claude', category: 'usage_point', eventType: 'assistant',
      nativeIds: { sessionId: 'a-child', messageId: 'shared-m' },
      timestamp: '2026-11-24T10:00:00Z',
      payload: { kind: 'assistant_usage', actualModel: 'claude-opus-4-6', usage: { input_tokens: 10, output_tokens: 5 } },
    }),
    obs({
      provider: 'claude', category: 'usage_point', eventType: 'assistant',
      nativeIds: { sessionId: 'z-parent', messageId: 'shared-m' },
      timestamp: '2026-11-24T10:00:00Z',
      payload: { kind: 'assistant_usage', actualModel: 'claude-opus-4-6', usage: { input_tokens: 10, output_tokens: 5 } },
    }),
    obs({
      provider: 'claude', category: 'lifecycle', eventType: 'derived-from',
      nativeIds: { sessionId: 'a-child' },
      payload: { kind: 'derived_from', sessions: ['z-parent'] },
    }),
  ]);
  assert.equal(forkState.inferences['claude:msg:shared-m']?.ownerSessionId, 'claude:z-parent');
  assert.deepEqual(forkState.sessions['claude:z-parent']?.directInferenceIds, ['claude:msg:shared-m']);
  assert.deepEqual(forkState.sessions['claude:a-child']?.directInferenceIds, []);
  assert.deepEqual(forkState.sessions['claude:a-child']?.inheritedInferenceIds, ['claude:msg:shared-m']);

  // Simulate `.jsonl` -> `.jsonl.zst` reread of s1 (same line numbers, `logical_line` position): 100% idempotent.
  const zstReplay = batch
    .filter((o) => o.source.logicalKey === 'codex:rollout:s1')
    .map((o) => ({
      ...o,
      source: { ...o.source, path: 'C:\\logs\\s1.jsonl.zst', compressed: true, generation: 2, rereadReason: 'compressed' as const },
      position:
        o.position.kind === 'byte_range'
          ? { kind: 'logical_line' as const, lineNumber: o.position.lineNumber, decompressedByteOffset: o.position.byteOffset, decompressedByteLength: o.position.byteLength }
          : o.position,
    }));

  const infCountBefore = Object.keys(state.inferences).length;
  const lcCountBefore = Object.keys(state.lifecycleEvents).length;
  const evCountBefore = Object.keys(evidence).length;

  reconcileObservations(state, evidence, zstReplay);

  assert.equal(Object.keys(state.inferences).length, infCountBefore);
  assert.equal(Object.keys(state.lifecycleEvents).length, lcCountBefore);
  assert.equal(Object.keys(evidence).length, evCountBefore);
});

test('Quota snapshots compress only consecutive identical states and preserve all actual changes across categories', () => {
  const state = createEmptyState();
  const q = (ts: string, limitId: string, pct: number, resetsAt: number) =>
    obs({
      provider: 'codex', category: 'usage_snapshot', eventType: 'event_msg/token_count',
      timestamp: ts,
      payload: { kind: 'token_count', rate_limits: { limit_id: limitId, primary: { used_percent: pct, window_minutes: 300, resets_at: resetsAt } } },
    });

  reconcileObservations(state, undefined, [
    q('2026-11-24T10:00:00Z', 'codex', 10.0, 1000),
    q('2026-11-24T10:01:00Z', 'codex', 10.0, 1000), // identical consecutive -> compressed
    q('2026-11-24T10:02:00Z', 'codex', 10.1, 1000), // tiny 0.1% change -> MUST be preserved
    q('2026-11-24T10:03:00Z', 'codex', 10.1, 2000), // reset window changed -> MUST be preserved
    q('2026-11-24T10:04:00Z', 'other', 10.1, 2000), // distinct category -> kept separate
  ]);

  assert.equal(state.quotaSnapshots.length, 4);
  assert.equal(state.quotaSnapshots[0]?.firstObservedAt, '2026-11-24T10:00:00Z');
  assert.equal(state.quotaSnapshots[0]?.lastObservedAt, '2026-11-24T10:01:00Z');
  assert.equal(state.quotaSnapshots[0]?.observationCount, 2);
  assert.equal(state.latestQuotaByCategory['codex:codex']?.lastObservedAt, '2026-11-24T10:03:00Z');
  assert.equal(state.latestQuotaByCategory['codex:other']?.lastObservedAt, '2026-11-24T10:04:00Z');

  // Replaying the same batch is idempotent.
  reconcileObservations(state, undefined, [
    q('2026-11-24T10:00:00Z', 'codex', 10.0, 1000),
    q('2026-11-24T10:02:00Z', 'codex', 10.1, 1000),
    q('2026-11-24T10:03:00Z', 'codex', 10.1, 2000),
  ]);
  assert.equal(state.quotaSnapshots.length, 4);
});
