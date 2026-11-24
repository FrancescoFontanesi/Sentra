import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProviderSessionMonitor, type SessionRefreshResult } from '../src/core/session-monitor.js';
import { UsageObservatory } from '../src/observatory/observatory.js';

const tmpDir = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function writeWithMtime(filePath: string, content: string, mtimeMs: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  const d = new Date(mtimeMs);
  fs.utimesSync(filePath, d, d);
}

test('UsageObservatory tracks incremental Codex & Claude sessions, preserves model/contextWindow across appends, suppresses redundant idle notifications, decays burn rate, and resets cleanly on switch', async () => {
  const root = tmpDir('sentra-obs-e2e-');
  const codexHome = path.join(root, '.codex');
  const claudeConfig = path.join(root, '.claude');
  const claudeJson = path.join(root, '.claude.json');
  let clockMs = Date.parse('2026-11-24T10:05:00Z');

  try {
    const codexDay = path.join(codexHome, 'sessions', '2026', '11', '24');
    const codexFileA = path.join(codexDay, 'rollout-sess-A.jsonl');
    writeWithMtime(
      codexFileA,
      '{"timestamp":"2026-11-24T10:00:00Z","type":"session_meta","payload":{"id":"sess-A","session_id":"sess-A","cwd":"F:\\\\Work\\\\Sentra","context_window":200000}}\n' +
      '{"timestamp":"2026-11-24T10:00:01Z","type":"turn_context","payload":{"turn_id":"t1","model":"gpt-5.4"}}\n' +
      '{"timestamp":"2026-11-24T10:04:00Z","type":"token_usage_record","payload":{"session_id":"sess-A","turn_id":"t1","response_id":"r1","usage":{"input_tokens":1000,"cached_input_tokens":200,"output_tokens":100,"total_tokens":1100}}}\n' +
      '{"timestamp":"2026-11-24T10:04:01Z","type":"event_msg","payload":{"type":"token_count","info":{"model_context_window":200000,"total_token_usage":{"input_tokens":1000,"cached_input_tokens":200,"output_tokens":100,"total_tokens":1100}},"rate_limits":{"limit_id":"codex","primary":{"used_percent":10,"window_minutes":300,"resets_at":1795600000}}}}\n',
      clockMs - 5_000
    );

    const claudeProj = path.join(claudeConfig, 'projects', 'F--Work-Sentra');
    writeWithMtime(
      path.join(claudeProj, 'c1.jsonl'),
      '{"type":"user","sessionId":"c1","uuid":"u1","cwd":"F:\\\\Work\\\\Sentra","turnOrigin":"human","timestamp":"2026-11-24T10:00:00Z"}\n' +
      '{"type":"assistant","sessionId":"c1","uuid":"a1","cwd":"F:\\\\Work\\\\Sentra","timestamp":"2026-11-24T10:04:30Z","message":{"id":"cm1","model":"claude-opus-4-6","stop_reason":"end_turn","usage":{"input_tokens":500,"cache_read_input_tokens":1500,"output_tokens":100},"content":[]}}\n',
      clockMs - 4_000
    );
    writeWithMtime(
      path.join(claudeConfig, 'sessions', `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: 'c1', cwd: 'F:\\Work\\Sentra', status: 'running', updatedAt: clockMs - 2_000 }),
      clockMs - 2_000
    );
    writeWithMtime(
      claudeJson,
      JSON.stringify({
        cachedUsageUtilization: {
          fetchedAtMs: clockMs - 60_000,
          utilization: { five_hour: { utilization: 15, resets_at: '2026-11-24T15:00:00Z' } },
        },
      }),
      clockMs - 60_000
    );

    const obs = new UsageObservatory({
      workspace: 'F:\\Work\\Sentra',
      refreshIntervalMs: 0,
      nowMs: () => clockMs,
      codex: { codexHome },
      claude: { claudeConfigDir: claudeConfig, claudeJsonPath: claudeJson },
    });

    const handle = obs.createHandle();
    assert.deepEqual(Object.keys(handle).sort(), ['getProviderSnapshot', 'getSnapshot', 'onDidUpdate', 'refresh']);

    let notifications = 0;
    const unsub = handle.onDidUpdate(() => { notifications += 1; });

    const snap1 = await handle.refresh();
    assert.equal(snap1.providers.codex.identity.sessionId, 'codex:sess-A');
    assert.equal(snap1.providers.codex.identity.status, 'recent');
    assert.equal(snap1.providers.codex.usage.direct.totalTokens, 1100);
    assert.equal(snap1.providers.claude.identity.sessionId, 'claude:c1');
    assert.equal(snap1.providers.claude.identity.status, 'active');
    assert.equal(snap1.providers.claude.usage.direct.totalTokens, 2100);
    assert.ok(notifications >= 1);

    // Incremental Codex append WITHOUT a new turn_context/token_count must retain model & contextWindow!
    clockMs += 5_000;
    fs.appendFileSync(
      codexFileA,
      '{"timestamp":"2026-11-24T10:05:02Z","type":"token_usage_record","payload":{"session_id":"sess-A","turn_id":"t1","response_id":"r2","usage":{"input_tokens":2000,"cached_input_tokens":500,"output_tokens":200,"total_tokens":2200}}}\n'
    );
    fs.utimesSync(codexFileA, new Date(clockMs), new Date(clockMs));
    const snap2 = await handle.refresh();
    assert.equal(snap2.providers.codex.usage.direct.totalTokens, 3300);
    assert.equal(snap2.providers.codex.usage.byModel['gpt-5.4']?.totalTokens, 3300);
    assert.equal(snap2.providers.codex.context.contextWindowTokens, 200_000);
    assert.equal(snap2.providers.codex.context.currentContextTokens, 2000);

    // Idle refresh with no new observations & no burn-rate change -> reuses references, ZERO redundant notifications!
    const prevNotif = notifications;
    const prevCodexUsage = snap2.providers.codex.usage;
    const prevCodexCtx = snap2.providers.codex.context;
    clockMs += 3_000;
    const snapIdle = await handle.refresh();
    assert.equal(notifications, prevNotif);
    assert.equal(snapIdle.providers.codex.usage, prevCodexUsage);
    assert.equal(snapIdle.providers.codex.context, prevCodexCtx);

    // Advance clock 10 minutes with zero new log lines -> burn rate decays to 0 and DOES notify!
    clockMs += 10 * 60_000;
    const snapDecayed = await handle.refresh();
    assert.equal(snapDecayed.providers.codex.burnRate.inferencesPerMin, 0);
    assert.equal(snapDecayed.providers.codex.burnRate.inputTokensPerMin, 0);
    assert.equal(snapDecayed.providers.claude.burnRate.inferencesPerMin, 0);
    assert.ok(notifications > prevNotif);

    // Switch Codex session -> old totals dropped, new totals clean, provider quota preserved.
    clockMs += 5_000;
    writeWithMtime(
      path.join(codexDay, 'rollout-sess-B.jsonl'),
      '{"timestamp":"2026-11-24T10:15:10Z","type":"session_meta","payload":{"id":"sess-B","session_id":"sess-B","cwd":"F:\\\\Work\\\\Sentra"}}\n' +
      '{"timestamp":"2026-11-24T10:15:11Z","type":"token_usage_record","payload":{"session_id":"sess-B","response_id":"rb1","usage":{"input_tokens":50,"cached_input_tokens":0,"output_tokens":10,"total_tokens":60}}}\n',
      clockMs
    );
    const snapSwitched = await handle.refresh();
    assert.equal(snapSwitched.providers.codex.identity.sessionId, 'codex:sess-B');
    assert.equal(snapSwitched.providers.codex.usage.direct.totalTokens, 60);
    assert.equal(snapSwitched.providers.codex.subscription.categories?.[0]?.windows[0]?.usedPercent, 10);

    // Deleting all Codex rollouts -> transitions cleanly to 'no_session' and clears old session state.
    fs.rmSync(codexDay, { recursive: true, force: true });
    const snapNone = await handle.refresh();
    assert.equal(snapNone.providers.codex.identity.status, 'no_session');
    assert.equal(snapNone.providers.codex.usage.direct.inferenceCount, 0);
    assert.equal(snapNone.providers.codex.subscription.categories?.[0]?.windows[0]?.usedPercent, 10);

    unsub();
    obs.dispose();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('UsageObservatory prevents concurrent refreshes on same provider, isolates provider errors/unavailability, handles mid-refresh workspace change, and blocks post-dispose updates', async () => {
  const missingRoot = path.join(os.tmpdir(), `sentra-missing-${Date.now()}`);

  // Custom slow Codex monitor + throwing Claude monitor to verify concurrency & error isolation.
  let codexCalls = 0;
  let releaseCodex!: () => void;
  const codexGate = new Promise<void>((r) => { releaseCodex = r; });

  const slowCodexMonitor = new ProviderSessionMonitor('codex', { codexHome: missingRoot });
  const origRefresh = slowCodexMonitor.refresh.bind(slowCodexMonitor);
  slowCodexMonitor.refresh = async (): Promise<SessionRefreshResult> => {
    codexCalls += 1;
    if (codexCalls === 1) await codexGate;
    return origRefresh();
  };

  const failingClaudeMonitor = new ProviderSessionMonitor('claude', { claudeConfigDir: missingRoot, claudeJsonPath: path.join(missingRoot, '.claude.json') });
  failingClaudeMonitor.refresh = async (): Promise<SessionRefreshResult> => {
    throw new Error('EACCES reading C:\\Users\\secret\\file.jsonl and \\\\filesrv\\priv\\data.json');
  };

  const obs = new UsageObservatory({
    workspace: 'F:\\Work\\A',
    refreshIntervalMs: 0,
    codex: { codexHome: missingRoot },
    claude: { claudeConfigDir: missingRoot, claudeJsonPath: path.join(missingRoot, '.claude.json') },
    monitors: { codex: slowCodexMonitor, claude: failingClaudeMonitor },
  });

  // Launch two concurrent refreshes on codex -> must execute only ONCE (no overlap), while claude fails independently.
  const p1 = obs.refreshProvider('codex');
  const p2 = obs.refreshProvider('codex');
  const pClaude = obs.refreshProvider('claude');

  const claudeSnap = await pClaude;
  assert.equal(claudeSnap.identity.status, 'error');
  assert.ok(claudeSnap.identity.lastError?.includes('<path>')); // path sanitized
  assert.equal(claudeSnap.identity.lastError?.includes('secret'), false);
  assert.equal(claudeSnap.identity.lastError?.includes('filesrv'), false);
  assert.equal(codexCalls, 1);

  // Change workspace while codex refresh #1 is in flight -> rerun #2 finishes inside the SAME awaited promise!
  obs.setWorkspace('F:\\Work\\B');
  releaseCodex();
  await Promise.all([p1, p2]);
  assert.equal(codexCalls, 2);
  assert.equal(obs.getSnapshot().workspace, 'F:\\Work\\B');
  assert.equal(obs.getProviderSnapshot('codex').identity.status, 'unavailable');

  // Dispose during an in-flight async refresh must NEVER publish updates afterward.
  let releaseAfterDispose!: () => void;
  const disposeGate = new Promise<void>((r) => { releaseAfterDispose = r; });
  const delayedMonitor = new ProviderSessionMonitor('codex', { codexHome: missingRoot });
  delayedMonitor.refresh = async () => {
    await disposeGate;
    return origRefresh();
  };

  const obs2 = new UsageObservatory({
    refreshIntervalMs: 50,
    codex: { codexHome: missingRoot },
    claude: { claudeConfigDir: missingRoot, claudeJsonPath: path.join(missingRoot, '.claude.json') },
    monitors: { codex: delayedMonitor },
  });
  let postDisposeEvents = 0;
  obs2.onDidUpdate(() => { postDisposeEvents += 1; });
  obs2.start();
  const inFlight = obs2.refreshProvider('codex');
  obs2.dispose();
  const eventsAtDispose = postDisposeEvents;
  releaseAfterDispose();
  await inFlight;
  assert.equal(postDisposeEvents, eventsAtDispose);
});
