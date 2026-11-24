import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { readJsonlSource, readJsonSnapshot, SourceCursorStore } from '../src/acquisition/jsonl-reader.js';
import { isSensitivePath, normalizeFsPath, stripRolloutExtension } from '../src/acquisition/paths.js';
import type { DiscoveredSource } from '../src/acquisition/types.js';
import { IncrementalWatcher } from '../src/acquisition/watcher.js';

const tmpDir = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const makeSource = (filePath: string, extra: Partial<DiscoveredSource> = {}): DiscoveredSource => {
  const compressed = filePath.endsWith('.zst');
  return {
    provider: 'codex', path: filePath,
    logicalKey: `test:${stripRolloutExtension(path.basename(filePath))}`,
    kind: 'rollout', compressed, watchable: !compressed, ...extra,
  };
};

test('Windows path normalization and sensitive path guard', async () => {
  assert.equal(normalizeFsPath('\\\\?\\C:\\Work\\Sentra\\File.JSONL'), path.normalize('C:\\Work\\Sentra\\File.JSONL'));
  assert.equal(normalizeFsPath('\\\\?\\UNC\\srv\\share\\Dir'), path.normalize('\\\\srv\\share\\Dir'));
  assert.ok(normalizeFsPath('\\\\?\\C:\\' + 'a'.repeat(270) + '\\r.jsonl').startsWith('\\\\?\\'));

  for (const p of [
    'C:\\u\\.codex\\auth.json', 'C:\\u\\.claude\\.credentials.json',
    'C:\\u\\.codex\\state_5.sqlite', 'C:\\u\\.codex\\.sandbox-secrets\\x',
    'C:\\u\\proj\\.env.local', 'C:\\u\\proj\\priv.key',
  ]) assert.equal(isSensitivePath(p), true, p);
  assert.equal(isSensitivePath('C:\\u\\.codex\\sessions\\2026\\r.jsonl'), false);
  assert.equal(isSensitivePath('C:\\u\\.claude.json'), false);

  const dir = tmpDir('sentra-sens-');
  try {
    const f = path.join(dir, 'auth.json');
    fs.writeFileSync(f, '{"token":"x"}\n');
    const res = await readJsonlSource(makeSource(f), new SourceCursorStore());
    assert.equal(res.records.length, 0);
    assert.equal(res.diagnostics[0]?.code, 'sensitive_path_blocked');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('JSONL streaming: UTF-8, CRLF, malformed JSON, partial line, incremental append without re-emission', async () => {
  const dir = tmpDir('sentra-jsonl-');
  try {
    const f = path.join(dir, 'r1.jsonl');
    const cursors = new SourceCursorStore();
    const src = makeSource(f);
    const l1 = '{"id":1,"t":"caffè 🚀 日本語"}\r\n';
    fs.writeFileSync(f, l1 + '{bad\n{"id":3,"s":"pen', 'utf8');

    const r1 = await readJsonlSource(src, cursors);
    assert.equal(r1.records.length, 1);
    assert.deepEqual(r1.records[0]?.value, { id: 1, t: 'caffè 🚀 日本語' });
    assert.deepEqual(r1.records[0]?.position, {
      kind: 'byte_range', byteOffset: 0, byteLength: Buffer.byteLength(l1, 'utf8'), lineNumber: 1,
    });
    assert.equal(r1.diagnostics.some((d) => d.code === 'malformed_json'), true);

    assert.equal((await readJsonlSource(src, cursors)).records.length, 0);

    fs.appendFileSync(f, 'ding"}\n{"id":4}\n', 'utf8');
    const r2 = await readJsonlSource(src, cursors);
    assert.equal(r2.sourceRef.generation, 1);
    assert.equal(r2.sourceRef.rereadReason, undefined);
    assert.deepEqual(r2.records.map((r) => r.value), [{ id: 3, s: 'pending' }, { id: 4 }]);
    assert.equal((await readJsonlSource(src, cursors)).skippedUnchanged, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('JSONL lifecycle: truncation, in-place replacement, removal, and JSON snapshot caching', async () => {
  const dir = tmpDir('sentra-life-');
  try {
    const f = path.join(dir, 'life.jsonl');
    const cursors = new SourceCursorStore();
    const src = makeSource(f);

    fs.writeFileSync(f, '{"seq":1,"pad":"aaaaaaaaaa"}\n{"seq":2}\n');
    assert.equal((await readJsonlSource(src, cursors)).records.length, 2);

    fs.writeFileSync(f, '{"seq":10}\n');
    const trunc = await readJsonlSource(src, cursors);
    assert.equal(trunc.sourceRef.generation, 2);
    assert.equal(trunc.sourceRef.rereadReason, 'truncated');

    fs.writeFileSync(f, '{"seq":99,"replaced":true}\n');
    const repl = await readJsonlSource(src, cursors);
    assert.equal(repl.sourceRef.generation, 3);
    assert.equal(repl.sourceRef.rereadReason, 'replaced');

    fs.unlinkSync(f);
    assert.equal((await readJsonlSource(src, cursors)).diagnostics.some((d) => d.code === 'source_removed'), true);

    const snap = path.join(dir, 'meta.json');
    const snapSrc = makeSource(snap, { kind: 'meta', compressed: false });
    fs.writeFileSync(snap, '{"v":1}');
    assert.deepEqual((await readJsonSnapshot(snapSrc, cursors)).data, { v: 1 });
    assert.equal((await readJsonSnapshot(snapSrc, cursors)).skippedUnchanged, true);
    fs.writeFileSync(snap, '{"v":2,"x":true}');
    assert.deepEqual((await readJsonSnapshot(snapSrc, cursors)).data, { v: 2, x: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Zstandard decompression, .jsonl -> .jsonl.zst continuity, corrupt/truncated/unsupported diagnostics', async () => {
  const dir = tmpDir('sentra-zst-');
  try {
    const cursors = new SourceCursorStore();
    const plain = path.join(dir, 'rollout-t.jsonl');
    const zst = path.join(dir, 'rollout-t.jsonl.zst');
    const body = '{"step":1}\n{"step":2}\n';

    fs.writeFileSync(plain, body);
    const r1 = await readJsonlSource(makeSource(plain), cursors);
    const compressed = zlib.zstdCompressSync(Buffer.from(body));
    fs.writeFileSync(zst, compressed);
    fs.unlinkSync(plain);

    const r2 = await readJsonlSource(makeSource(zst), cursors);
    assert.equal(r2.records.length, 2);
    assert.equal(r2.sourceRef.logicalKey, r1.sourceRef.logicalKey);
    assert.equal(r2.sourceRef.generation, 2);
    assert.equal(r2.sourceRef.rereadReason, 'compressed');
    assert.equal(r2.sourceRef.previousPath, r1.sourceRef.path);
    assert.equal(r2.records[0]?.position.kind, 'logical_line');
    assert.equal(r2.diagnostics.some((d) => d.code === 'source_compressed_transition'), true);
    assert.equal((await readJsonlSource(makeSource(zst), cursors)).skippedUnchanged, true);

    const corrupt = path.join(dir, 'corrupt.jsonl.zst');
    fs.writeFileSync(corrupt, Buffer.from('not-zstd'));
    assert.equal((await readJsonlSource(makeSource(corrupt), cursors)).diagnostics.some((d) => d.code === 'zstd_error'), true);

    const trunc = path.join(dir, 'trunc.jsonl.zst');
    fs.writeFileSync(trunc, compressed.subarray(0, 6));
    assert.equal(
      (await readJsonlSource(makeSource(trunc), cursors)).diagnostics.some(
        (d) => d.code === 'zstd_truncated_or_empty' || d.code === 'zstd_error'
      ),
      true
    );

    const trailing = path.join(dir, 'trail.jsonl.zst');
    fs.writeFileSync(trailing, zlib.zstdCompressSync(Buffer.from('{"ok":1}\n{"cut":tru')));
    const rTrail = await readJsonlSource(makeSource(trailing), cursors);
    assert.equal(rTrail.records.length, 1);
    assert.equal(rTrail.diagnostics.some((d) => d.code === 'incomplete_trailing_line'), true);

    const rUnsup = await readJsonlSource(makeSource(zst, { logicalKey: 'test:unsup' }), new SourceCursorStore(), { allowZstdOverride: false });
    assert.equal(rUnsup.diagnostics.some((d) => d.code === 'zstd_unsupported_runtime'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('IncrementalWatcher debounces fs.watch and filters filenames', async () => {
  const dir = tmpDir('sentra-watch-');
  const hits: string[] = [];
  const watcher = new IncrementalWatcher({
    debounceMs: 40, reconcileIntervalMs: 0,
    onTrigger: (ev) => { hits.push(ev.filePath ?? ev.dirPath); },
  });
  try {
    assert.equal(watcher.addTarget({ dirPath: dir, fileFilter: (n) => n === 'target.jsonl' }), true);
    fs.writeFileSync(path.join(dir, 'ignored.jsonl'), '{}\n');
    fs.writeFileSync(path.join(dir, 'target.jsonl'), '{"a":1}\n');
    fs.appendFileSync(path.join(dir, 'target.jsonl'), '{"a":2}\n');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(hits.some((p) => p.endsWith('ignored.jsonl')), false);
    assert.equal(hits.some((p) => p.endsWith('target.jsonl')), true);
  } finally {
    watcher.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
