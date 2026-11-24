import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import {
  ProviderSessionMonitor,
  selectClaudeSession,
  selectCodexSession,
} from '../src/core/session-monitor.js';

const tmpDir = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function writeWithMtime(filePath: string, content: string | Buffer, mtimeMs: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  const d = new Date(mtimeMs);
  fs.utimesSync(filePath, d, d);
}

test('Codex monitor selects workspace primary session (never subagent), reconstructs compressed segments, updates incrementally, and resets on session switch', async () => {
  const root = tmpDir('sentra-codex-mon-');
  const now = Date.now();
  try {
    const day = path.join(root, 'sessions', '2026', '11', '24');
    const arch = path.join(root, 'archived_sessions');

    // Unrelated historical session (MUST NOT be indexed or read).
    writeWithMtime(
      path.join(arch, 'rollout-unrelated.jsonl.zst'),
      zlib.zstdCompressSync(Buffer.from(
        '{"timestamp":"2026-11-01T00:00:00Z","type":"session_meta","payload":{"id":"old-sess","cwd":"F:\\\\Other"}}\n' +
        '{"timestamp":"2026-11-01T00:00:01Z","type":"token_usage_record","payload":{"session_id":"old-sess","response_id":"resp-old","usage":{"input_tokens":999,"cached_input_tokens":0,"output_tokens":1,"total_tokens":1000}}}\n'
      )),
      now - 86_400_000
    );

    // Earlier compressed segment of active session `sess-A` + active segment + subagent of `sess-A`.
    const seg1 =
      '{"timestamp":"2026-11-24T10:00:00Z","type":"session_meta","payload":{"id":"sess-A","session_id":"sess-A","cwd":"F:\\\\Work\\\\Sentra","cli_version":"0.171.0"}}\n' +
      '{"timestamp":"2026-11-24T10:00:01Z","type":"token_usage_record","payload":{"session_id":"sess-A","response_id":"resp-seg1","usage":{"input_tokens":500,"cached_input_tokens":100,"output_tokens":50,"total_tokens":550}}}\n';
    writeWithMtime(path.join(day, 'rollout-sess-A-part1.jsonl.zst'), zlib.zstdCompressSync(Buffer.from(seg1)), now - 60_000);

    const activePath = path.join(day, 'rollout-sess-A-part2.jsonl');
    writeWithMtime(
      activePath,
      '{"timestamp":"2026-11-24T10:05:00Z","type":"session_meta","payload":{"id":"sess-A","session_id":"sess-A","cwd":"F:\\\\Work\\\\Sentra","cli_version":"0.171.0"}}\n' +
      '{"timestamp":"2026-11-24T10:05:01Z","type":"token_usage_record","payload":{"session_id":"sess-A","response_id":"resp-seg2","usage":{"input_tokens":600,"cached_input_tokens":200,"output_tokens":60,"total_tokens":660}}}\n' +
      '{"timestamp":"2026-11-24T10:05:02Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex","primary":{"used_percent":14,"window_minutes":300,"resets_at":1795600000}}}}\n',
      now - 5_000
    );

    // Subagent rollout is NEWER than main rollout, shares parent `session_id` on token_usage_record, and MUST NOT replace `sess-A` or merge into parent direct inferences.
    writeWithMtime(
      path.join(day, 'rollout-sub-1.jsonl'),
      '{"timestamp":"2026-11-24T10:06:00Z","type":"session_meta","payload":{"id":"sub-1","session_id":"sess-A","parent_thread_id":"sess-A","agent_role":"worker","cwd":"F:\\\\Work\\\\Sentra"}}\n' +
      '{"timestamp":"2026-11-24T10:06:01Z","type":"token_usage_record","payload":{"session_id":"sess-A","thread_id":"sub-1","response_id":"resp-sub1","usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":20,"total_tokens":120}}}\n',
      now - 1_000
    );

    const monitor = new ProviderSessionMonitor('codex', {
      codexHome: root,
      workspace: 'F:\\Work\\Sentra',
      nowMs: () => now,
    });

    const r1 = await monitor.refresh();
    assert.equal(r1.selection.sessionId, 'sess-A');
    assert.equal(r1.selection.reason, 'runtime_workspace');
    assert.equal(r1.selection.ambiguous, false);
    assert.equal(r1.filesRead, 3); // seg1.zst + seg2.jsonl + sub-1.jsonl (NOT unrelated archive!)
    assert.equal(monitor.currentState.inferences['codex:resp:resp-old'], undefined);
    assert.ok(monitor.currentState.inferences['codex:resp:resp-seg1']);
    assert.ok(monitor.currentState.inferences['codex:resp:resp-seg2']);
    assert.ok(monitor.currentState.inferences['codex:resp:resp-sub1']);
    assert.equal(monitor.currentState.sessions['codex:sess-A']?.isSubagent, false);
    assert.equal(monitor.currentState.sessions['codex:sub-1']?.isSubagent, true);
    assert.deepEqual(monitor.currentState.sessions['codex:sess-A']?.childSessionIds, ['codex:sub-1']);
    assert.deepEqual(monitor.currentState.sessions['codex:sub-1']?.directInferenceIds, ['codex:resp:resp-sub1']);
    assert.equal(monitor.currentState.sessions['codex:sess-A']?.directInferenceIds.includes('codex:resp:resp-sub1'), false);

    // Incremental append on active rollout reads only the new line.
    const appendedLine =
      '{"timestamp":"2026-11-24T10:07:00Z","type":"token_usage_record","payload":{"session_id":"sess-A","response_id":"resp-seg3","usage":{"input_tokens":700,"cached_input_tokens":300,"output_tokens":70,"total_tokens":770}}}\n';
    fs.appendFileSync(activePath, appendedLine);
    const r2 = await monitor.refresh();
    assert.equal(r2.switched, false);
    assert.equal(r2.filesRead, 1);
    assert.equal(r2.filesSkippedUnchanged, 2);
    assert.equal(r2.bytesRead, Buffer.byteLength(appendedLine, 'utf8'));
    assert.ok(monitor.currentState.inferences['codex:resp:resp-seg3']);

    // Unchanged refresh skips all files.
    const r3 = await monitor.refresh();
    assert.equal(r3.filesRead, 0);
    assert.equal(r3.filesSkippedUnchanged, 3);

    // Switch to a brand-new session `sess-B` -> previous session state discarded, provider quota retained.
    writeWithMtime(
      path.join(day, 'rollout-sess-B.jsonl'),
      '{"timestamp":"2026-11-24T11:00:00Z","type":"session_meta","payload":{"id":"sess-B","session_id":"sess-B","cwd":"F:\\\\Work\\\\Sentra"}}\n' +
      '{"timestamp":"2026-11-24T11:00:01Z","type":"token_usage_record","payload":{"session_id":"sess-B","response_id":"resp-B1","usage":{"input_tokens":50,"cached_input_tokens":0,"output_tokens":10,"total_tokens":60}}}\n',
      now + 5_000
    );
    // Mark `sess-A` inactive by advancing monitor clock past active window for `sess-A` only, or test ambiguity first.
    const amb = await selectCodexSession({ codexHome: root, workspace: 'F:\\Work\\Sentra', nowMs: now + 6_000 });
    assert.equal(amb.sessionId, 'sess-B');
    assert.equal(amb.ambiguous, true);
    assert.equal(amb.candidates.length, 2);

    const r4 = await monitor.refresh();
    assert.equal(r4.switched, true);
    assert.equal(r4.selection.sessionId, 'sess-B');
    assert.equal(monitor.currentState.inferences['codex:resp:resp-seg1'], undefined);
    assert.equal(monitor.currentState.sessions['codex:sess-A'], undefined);
    assert.ok(monitor.currentState.inferences['codex:resp:resp-B1']);
    // Provider-scoped quota survives session switch.
    assert.ok(monitor.currentState.latestQuotaByCategory['codex:codex']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Claude monitor prioritizes runtime session + workspace, isolates subagents, skips unrelated sessions, and resets cleanly on switch', async () => {
  const home = tmpDir('sentra-claude-mon-');
  const configDir = path.join(home, '.claude');
  const claudeJson = path.join(home, '.claude.json');
  const now = Date.now();
  try {
    const proj = path.join(configDir, 'projects', 'F--Work-Sentra');
    const sessDir = path.join(configDir, 'sessions');

    // Unrelated older session (must never be read).
    writeWithMtime(
      path.join(proj, 'old-c.jsonl'),
      '{"type":"assistant","sessionId":"old-c","cwd":"F:\\\\Other","message":{"id":"m-old","model":"claude-opus-4-6","usage":{"input_tokens":999,"output_tokens":99},"content":[]}}\n',
      now - 86_400_000
    );

    // Current session `c-1` + its subagent + active runtime PID file + ~/.claude.json quota.
    const c1Path = path.join(proj, 'c-1.jsonl');
    writeWithMtime(
      c1Path,
      '{"type":"user","sessionId":"c-1","uuid":"u1","cwd":"F:\\\\Work\\\\Sentra","timestamp":"2026-11-24T10:00:00Z"}\n' +
      '{"type":"assistant","sessionId":"c-1","uuid":"a1","cwd":"F:\\\\Work\\\\Sentra","message":{"id":"m-c1","model":"claude-opus-4-6","usage":{"input_tokens":100,"cache_read_input_tokens":200,"output_tokens":40},"content":[]}}\n',
      now - 10_000
    );
    // Newer subagent file must NOT hijack primary target.
    writeWithMtime(
      path.join(proj, 'c-1', 'subagents', 'agent-s1.jsonl'),
      '{"type":"assistant","sessionId":"c-1","uuid":"sa1","cwd":"F:\\\\Work\\\\Sentra","message":{"id":"m-sub","model":"claude-haiku-4-5","usage":{"input_tokens":20,"output_tokens":10},"content":[]}}\n',
      now - 1_000
    );
    writeWithMtime(
      path.join(sessDir, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: 'c-1', cwd: 'F:\\Work\\Sentra', status: 'running', updatedAt: now - 2_000 }),
      now - 2_000
    );
    writeWithMtime(
      claudeJson,
      JSON.stringify({
        cachedUsageUtilization: {
          fetchedAtMs: now - 3_000,
          accountUuid: 'secret-acct',
          utilization: { five_hour: { utilization: 22, resets_at: '2026-11-24T16:00:00Z' } },
        },
      }),
      now - 3_000
    );

    const monitor = new ProviderSessionMonitor('claude', {
      claudeConfigDir: configDir,
      claudeJsonPath: claudeJson,
      workspace: 'F:\\Work\\Sentra',
    });

    const r1 = await monitor.refresh();
    assert.equal(r1.selection.sessionId, 'c-1');
    assert.equal(r1.selection.reason, 'runtime_workspace');
    assert.equal(r1.filesRead, 4); // c-1.jsonl + agent-s1.jsonl + <pid>.json + .claude.json (NOT old-c.jsonl!)
    assert.equal(monitor.currentState.inferences['claude:msg:m-old'], undefined);
    assert.ok(monitor.currentState.inferences['claude:msg:m-c1']);
    assert.ok(monitor.currentState.inferences['claude:msg:m-sub']);
    assert.equal(monitor.currentState.sessions['claude:c-1']?.isSubagent, false);
    assert.equal(monitor.currentState.sessions['claude:c-1:agent:s1']?.isSubagent, true);
    assert.ok(monitor.currentState.latestQuotaByCategory['claude:cached_utilization']);
    assert.ok(
      Object.values(monitor.currentState.lifecycleEvents).some(
        (ev) => ev.kind === 'runtime_session' && ev.sessionId === 'claude:c-1' && ev.details.status === 'running'
      )
    );

    // Two active runtime sessions in the same workspace -> ambiguity explicitly preserved.
    writeWithMtime(
      path.join(proj, 'c-2.jsonl'),
      '{"type":"assistant","sessionId":"c-2","cwd":"F:\\\\Work\\\\Sentra","message":{"id":"m-c2","model":"claude-opus-4-6","usage":{"input_tokens":30,"output_tokens":15},"content":[]}}\n',
      now + 2_000
    );
    writeWithMtime(
      path.join(sessDir, `${process.pid + 1}.json`),
      JSON.stringify({ pid: process.pid, sessionId: 'c-2', cwd: 'F:\\Work\\Sentra', status: 'running', updatedAt: now + 2_000 }),
      now + 2_000
    );
    const sel = await selectClaudeSession({
      claudeConfigDir: configDir,
      claudeJsonPath: claudeJson,
      workspace: 'F:\\Work\\Sentra',
      checkPidLiveness: false,
    });
    assert.equal(sel.sessionId, 'c-2');
    assert.equal(sel.ambiguous, true);
    assert.equal(sel.candidates.length, 2);

    // Switch to `c-2` -> `c-1` state dropped, provider quota preserved.
    const r2 = await monitor.refresh();
    assert.equal(r2.switched, true);
    assert.equal(r2.selection.sessionId, 'c-2');
    assert.equal(monitor.currentState.sessions['claude:c-1'], undefined);
    assert.equal(monitor.currentState.inferences['claude:msg:m-c1'], undefined);
    assert.ok(monitor.currentState.inferences['claude:msg:m-c2']);
    assert.ok(monitor.currentState.latestQuotaByCategory['claude:cached_utilization']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
