import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { SourceCursorStore } from '../src/acquisition/jsonl-reader.js';
import {
  acquireCodex,
  discoverCodexSources,
  getCodexWatchTargets,
  resolveCodexHome,
} from '../src/providers/codex/discovery.js';

const fixturesDir = path.resolve(__dirname, '..', '..', 'test', 'fixtures');

function makeCodexTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentra-codex-'));
  const day = path.join(root, 'sessions', '2026', '11', '24');
  const arch = path.join(root, 'archived_sessions');
  fs.mkdirSync(day, { recursive: true });
  fs.mkdirSync(arch, { recursive: true });

  const modern = fs.readFileSync(path.join(fixturesDir, 'codex-rollout.jsonl'));
  const legacy = fs.readFileSync(path.join(fixturesDir, 'codex-legacy.jsonl'));
  fs.writeFileSync(path.join(day, 'rollout-modern.jsonl'), modern);
  fs.writeFileSync(path.join(day, 'rollout-compressed.jsonl.zst'), zlib.zstdCompressSync(modern));
  fs.writeFileSync(path.join(arch, 'rollout-legacy.jsonl.zst'), zlib.zstdCompressSync(legacy));
  fs.writeFileSync(path.join(root, 'session_index.jsonl'), '{"id":"sess-001","thread_name":"Demo","updated_at":"2026-11-24T10:05:00Z"}\n');
  fs.writeFileSync(path.join(root, 'models_cache.json'), JSON.stringify({
    client_version: '0.171.0-alpha.13', fetched_at: '2026-11-24T09:00:00Z',
    identity: { email: 'secret@example.com' }, models: [{ slug: 'gpt-5.4', context_window: 272000 }],
  }));
  fs.writeFileSync(path.join(root, 'auth.json'), '{"access_token":"SECRET_TOKEN"}');
  fs.writeFileSync(path.join(root, 'state_5.sqlite'), 'SQLite format 3');
  return root;
}

test('Codex discovery resolves CODEX_HOME, scopes archived_sessions to historical, and excludes sensitive files', async () => {
  assert.equal(resolveCodexHome({ env: { CODEX_HOME: 'D:\\C' }, homeDir: 'C:\\U' }), path.normalize('D:\\C'));
  assert.equal(resolveCodexHome({ env: {}, homeDir: 'C:\\U' }), path.normalize('C:\\U\\.codex'));

  const root = makeCodexTree();
  try {
    const hist = await discoverCodexSources({ codexHome: root, mode: 'historical' });
    assert.equal(hist.some((s) => s.kind === 'archived_rollout'), true);
    assert.equal(hist.some((s) => s.path.endsWith('auth.json') || s.path.endsWith('state_5.sqlite')), false);

    const incr = await discoverCodexSources({ codexHome: root, mode: 'incremental' });
    assert.equal(incr.some((s) => s.kind === 'archived_rollout'), false);
    assert.equal((await getCodexWatchTargets({ codexHome: root })).some((t) => t.dirPath.includes('archived_sessions')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('acquireCodex extracts native observations, keeps 0 vs undefined, separates usage types, and strips secrets', async () => {
  const root = makeCodexTree();
  try {
    const cursors = new SourceCursorStore();
    const batch = await acquireCodex({ codexHome: root, mode: 'historical' }, cursors);
    assert.equal(batch.filesScanned, 5);
    assert.equal(batch.filesRead, 5);

    const turs = batch.observations.filter((o) => o.category === 'usage_point' && o.eventType === 'token_usage_record');
    const tcs = batch.observations.filter((o) => o.category === 'usage_snapshot' && o.eventType === 'event_msg/token_count');
    assert.equal(turs.length, 2);
    assert.equal(tcs.length, 3);

    const turUsage = turs[0]?.payload.usage as Record<string, number> | undefined;
    assert.equal(turs[0]?.nativeIds.responseId, 'resp-1');
    assert.equal(turs[0]?.harnessVersion, '0.171.0-alpha.13');
    assert.equal(turUsage?.cached_input_tokens, 0);
    assert.equal(turUsage?.cache_write_input_tokens, undefined);
    assert.equal(turUsage?.reasoning_output_tokens, 80);

    const legacy = tcs.find((o) => o.harnessVersion === '0.45.0-alpha.5');
    assert.equal(legacy?.position.kind, 'logical_line');
    assert.equal(batch.diagnostics.some((d) => d.code === 'unknown_event_type'), true);

    const dump = JSON.stringify(batch);
    for (const s of [
      'acct-secret', 'user-secret-456', 'TOP SECRET SYSTEM PROMPT', 'DO NOT EXPORT SUMMARY TEXT',
      'SECRET_ARG', 'SECRET PATCH BODY', 'SECRET COMPACT TEXT', 'SECRET HISTORY',
      'SECRET ASSISTANT TEXT', 'secret@example.com', 'SECRET_TOKEN',
    ]) assert.equal(dump.includes(s), false, `Leaked: ${s}`);

    const second = await acquireCodex({ codexHome: root, mode: 'historical' }, cursors);
    assert.equal(second.filesSkippedUnchanged, 5);
    assert.equal(second.observations.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
