import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { UsageObservatory } from '../src/observatory/observatory.js';
import { PreventiveMonitor } from '../src/monitoring/monitoring.js';

const tmpDir = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function writeWithMtime(filePath: string, content: string, mtimeMs: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  const d = new Date(mtimeMs);
  fs.utimesSync(filePath, d, d);
}

test('PreventiveMonitor reacts via Observatory onDidUpdate without duplicates, decays both burn-rate windows, drops session alerts on switch while keeping account quota, and cleans up on dispose', async () => {
  const root = tmpDir('sentra-mon-e2e-');
  const codexHome = path.join(root, '.codex');
  const claudeConfig = path.join(root, '.claude');
  const claudeJson = path.join(root, '.claude.json');
  let clockMs = Date.parse('2026-11-24T10:10:00Z');

  try {
    const codexDay = path.join(codexHome, 'sessions', '2026', '11', '24');
    const fileA = path.join(codexDay, 'rollout-A.jsonl');
    const resetUnixSec = Math.floor(Date.parse('2026-11-24T15:00:00Z') / 1000);

    // Session A:
    // - 2 inferences in previous 5-min window (10:01, 10:02) totaling 500k input -> 100k/min baseline
    // - 3 inferences in current 5-min window (10:07, 10:08, 10:09) totaling 2.1M input -> 420k/min (4.2x -> Critical acceleration!)
    // - Context occupancy = 90k / 100k = 90% -> Critical context pressure!
    // - Codex quota = 85% fresh (1 min old) -> Warning quota pressure!
    writeWithMtime(
      fileA,
      '{"timestamp":"2026-11-24T10:00:00Z","type":"session_meta","payload":{"id":"A","session_id":"A","cwd":"F:\\\\Work\\\\Sentra","context_window":100000}}\n' +
      '{"timestamp":"2026-11-24T10:00:01Z","type":"turn_context","payload":{"turn_id":"t1","model":"gpt-5.4"}}\n' +
      '{"timestamp":"2026-11-24T10:01:00Z","type":"token_usage_record","payload":{"session_id":"A","turn_id":"t1","response_id":"p1","usage":{"input_tokens":250000,"cached_input_tokens":200000,"output_tokens":100,"total_tokens":250100}}}\n' +
      '{"timestamp":"2026-11-24T10:02:00Z","type":"token_usage_record","payload":{"session_id":"A","turn_id":"t1","response_id":"p2","usage":{"input_tokens":250000,"cached_input_tokens":200000,"output_tokens":100,"total_tokens":250100}}}\n' +
      '{"timestamp":"2026-11-24T10:07:00Z","type":"token_usage_record","payload":{"session_id":"A","turn_id":"t1","response_id":"c1","usage":{"input_tokens":1000000,"cached_input_tokens":900000,"output_tokens":100,"total_tokens":1000100}}}\n' +
      '{"timestamp":"2026-11-24T10:08:00Z","type":"token_usage_record","payload":{"session_id":"A","turn_id":"t1","response_id":"c2","usage":{"input_tokens":1010000,"cached_input_tokens":900000,"output_tokens":100,"total_tokens":1010100}}}\n' +
      '{"timestamp":"2026-11-24T10:09:00Z","type":"token_usage_record","payload":{"session_id":"A","turn_id":"t1","response_id":"c3","usage":{"input_tokens":90000,"cached_input_tokens":80000,"output_tokens":100,"total_tokens":90100}}}\n' +
      `{"timestamp":"2026-11-24T10:09:05Z","type":"event_msg","payload":{"type":"token_count","info":{"model_context_window":100000},"rate_limits":{"limit_id":"codex","primary":{"used_percent":85,"window_minutes":300,"resets_at":${resetUnixSec}}}}}\n`,
      clockMs - 5_000
    );

    const obs = new UsageObservatory({
      workspace: 'F:\\Work\\Sentra',
      refreshIntervalMs: 0,
      nowMs: () => clockMs,
      codex: { codexHome },
      claude: { claudeConfigDir: claudeConfig, claudeJsonPath: claudeJson },
    });
    const mon = new PreventiveMonitor(obs);

    let monUpdates = 0;
    const unsub = mon.onDidUpdate(() => { monUpdates += 1; });

    await obs.refreshAll();
    const m1 = mon.getProviderSnapshot('codex');
    const find = (rule: string) => m1.alerts.find((a) => a.ruleId === rule);

    // Published snapshots are strictly read-only (immutable at runtime).
    assert.throws(() => { (m1.alerts as unknown[]).push({}); }, TypeError);
    assert.throws(() => { (m1.alerts[0] as unknown as Record<string, unknown>).state = 'resolved'; }, TypeError);
    assert.throws(() => { (m1.alerts[0]!.evidence as Record<string, unknown>).tampered = true; }, TypeError);

    assert.equal(find('context_pressure')?.state, 'active');
    assert.equal(find('context_pressure')?.severity, 'critical');
    assert.equal(find('consumption_acceleration')?.state, 'active');
    assert.equal(find('consumption_acceleration')?.severity, 'critical');
    assert.equal(find('quota_pressure')?.state, 'active');
    assert.equal(find('quota_pressure')?.severity, 'warning');
    // Claude is unavailable independently without affecting Codex!
    assert.equal(mon.getProviderSnapshot('claude').alerts[0]?.state, 'not_evaluable');

    // Repeated unchanged refresh -> ZERO duplicate notifications and single alert per rule.
    const updatesAfterInit = monUpdates;
    clockMs += 3_000;
    await obs.refreshAll();
    assert.equal(monUpdates, updatesAfterInit);
    assert.equal(
      mon.getProviderSnapshot('codex').alerts.filter((a) => a.ruleId === 'context_pressure').length,
      1
    );

    // Advance 6 minutes (10:16:03): current 5-min window decays to 0 while previous 5-min window holds the 3 inferences ->
    // Consumption Acceleration cleanly resolves (measured drop to 0 against active baseline)!
    clockMs += 6 * 60_000;
    await obs.refreshAll();
    const brAfter6m = obs.getProviderSnapshot('codex').burnRate;
    assert.equal(brAfter6m.inferencesInWindow, 0);
    assert.equal(brAfter6m.previousWindow?.inferencesInWindow, 3);
    assert.equal(
      mon.getProviderSnapshot('codex').alerts.find((a) => a.ruleId === 'consumption_acceleration')?.state,
      'resolved'
    );

    // Advance 11 more minutes (10:27:03, > 15 min since 10:09:05 quota & > 10 min since last inference):
    // BOTH burn-rate windows decay to 0 AND Codex quota crosses 15-min staleness via Observatory's time-dependent update ->
    // Quota Pressure transitions automatically to `not_evaluable` (NEVER `resolved`)!
    clockMs += 11 * 60_000;
    await obs.refreshAll();
    const brAfter17m = obs.getProviderSnapshot('codex').burnRate;
    assert.equal(brAfter17m.inferencesInWindow, 0);
    assert.equal(brAfter17m.previousWindow?.inferencesInWindow, 0);
    const qStale = mon.getProviderSnapshot('codex').alerts.find((a) => a.ruleId === 'quota_pressure')!;
    assert.equal(qStale.state, 'not_evaluable');
    assert.equal(qStale.coverage.reason, 'quota_stale');

    // Refresh quota freshly on Session A first (85% active), then switch to Session B (low context 10%) ->
    // Session A's `context_pressure` alert is removed & replaced by Session B's resolved state, while account `quota_pressure` stays active!
    fs.appendFileSync(
      fileA,
      `{"timestamp":"${new Date(clockMs).toISOString()}","type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex","primary":{"used_percent":85,"window_minutes":300,"resets_at":${resetUnixSec}}}}}\n`
    );
    fs.utimesSync(fileA, new Date(clockMs), new Date(clockMs));
    await obs.refreshAll();
    const activeQuotaBeforeSwitch = mon.getProviderSnapshot('codex').alerts.find((a) => a.ruleId === 'quota_pressure')!;
    assert.equal(activeQuotaBeforeSwitch.state, 'active');
    const quotaActivatedAt = activeQuotaBeforeSwitch.activatedAtMs;

    clockMs += 5_000;
    writeWithMtime(
      path.join(codexDay, 'rollout-B.jsonl'),
      `{"timestamp":"${new Date(clockMs - 1000).toISOString()}","type":"session_meta","payload":{"id":"B","session_id":"B","cwd":"F:\\\\Work\\\\Sentra","context_window":100000}}\n` +
      `{"timestamp":"${new Date(clockMs).toISOString()}","type":"token_usage_record","payload":{"session_id":"B","response_id":"rb1","usage":{"input_tokens":10000,"cached_input_tokens":0,"output_tokens":50,"total_tokens":10050}}}\n`,
      clockMs
    );
    await obs.refreshAll();
    const mB = mon.getProviderSnapshot('codex');
    assert.equal(mB.sessionId, 'codex:B');
    const ctxB = mB.alerts.find((a) => a.ruleId === 'context_pressure')!;
    assert.equal(ctxB.sessionId, 'codex:B');
    assert.equal(ctxB.state, 'resolved');
    const qB = mB.alerts.find((a) => a.ruleId === 'quota_pressure')!;
    assert.equal(qB.state, 'active');
    assert.equal(qB.activatedAtMs, quotaActivatedAt); // Account-scoped quota alert preserved across session switch!

    // Completing the active turn on Session B updates summary/turnPhase and notifies subscribers cleanly.
    const updatesBeforeComplete = monUpdates;
    clockMs += 2_000;
    const fileB = path.join(codexDay, 'rollout-B.jsonl');
    fs.appendFileSync(
      fileB,
      `{"timestamp":"${new Date(clockMs - 1000).toISOString()}","type":"turn_context","payload":{"turn_id":"tb1","model":"gpt-5.4"}}\n` +
      `{"timestamp":"${new Date(clockMs - 500).toISOString()}","type":"event_msg","payload":{"type":"task_started","turn_id":"tb1"}}\n`
    );
    fs.utimesSync(fileB, new Date(clockMs - 500), new Date(clockMs - 500));
    await obs.refreshAll();
    assert.equal(
      mon.getProviderSnapshot('codex').alerts.find((a) => a.ruleId === 'agentic_intensity')?.evidence.turnPhase,
      'current'
    );
    const updatesWhileStarted = monUpdates;
    fs.appendFileSync(
      fileB,
      `{"timestamp":"${new Date(clockMs).toISOString()}","type":"event_msg","payload":{"type":"task_complete","turn_id":"tb1"}}\n`
    );
    fs.utimesSync(fileB, new Date(clockMs), new Date(clockMs));
    await obs.refreshAll();
    assert.equal(
      mon.getProviderSnapshot('codex').alerts.find((a) => a.ruleId === 'agentic_intensity')?.evidence.turnPhase,
      'completed'
    );
    assert.ok(monUpdates > updatesWhileStarted && updatesWhileStarted >= updatesBeforeComplete);

    // Dispose unsubscribes from Observatory and emits zero further notifications.
    unsub();
    mon.dispose();
    const countAfterDispose = monUpdates;
    clockMs += 5_000;
    await obs.refreshAll();
    assert.equal(monUpdates, countAfterDispose);
    obs.dispose();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
