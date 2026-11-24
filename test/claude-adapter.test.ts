import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SourceCursorStore } from '../src/acquisition/jsonl-reader.js';
import { acquireClaude, discoverClaudeSources, resolveClaudePaths } from '../src/providers/claude/discovery.js';

const fixturesDir = path.resolve(__dirname, '..', '..', 'test', 'fixtures');

function makeClaudeTree() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentra-claude-'));
  const configDir = path.join(homeDir, '.claude');
  const proj = path.join(configDir, 'projects', 'F--Projects-Alpha');
  const sub = path.join(proj, 'csess-1', 'subagents');
  const sess = path.join(configDir, 'sessions');
  fs.mkdirSync(sub, { recursive: true });
  fs.mkdirSync(sess, { recursive: true });

  fs.writeFileSync(path.join(proj, 'csess-1.jsonl'), fs.readFileSync(path.join(fixturesDir, 'claude-transcript.jsonl')));
  fs.writeFileSync(
    path.join(sub, 'agent-sub1.jsonl'),
    '{"type":"assistant","sessionId":"csess-1","uuid":"sa-1","cwd":"F:\\\\Projects\\\\Alpha","version":"2.1.330","message":{"id":"smsg-1","model":"claude-haiku-4-5","usage":{"input_tokens":10,"output_tokens":5},"content":[]}}\n'
  );
  fs.writeFileSync(path.join(sub, 'agent-sub1.meta.json'), JSON.stringify({
    agentType: 'Explore', model: 'claude-haiku-4-5', spawnDepth: 1,
    toolUseId: 'tu-sub-1', finished: true, description: 'SECRET SUBAGENT PROMPT',
  }));
  fs.writeFileSync(path.join(sess, '12345.json'), JSON.stringify({
    pid: 12345, sessionId: 'csess-1', cwd: 'F:\\Projects\\Alpha', status: 'running', version: '2.1.330',
  }));
  fs.writeFileSync(path.join(configDir, '.credentials.json'), '{"oauth":"SECRET_OAUTH"}');

  const claudeJsonPath = path.join(homeDir, '.claude.json');
  fs.writeFileSync(claudeJsonPath, JSON.stringify({
    oauthAccount: { emailAddress: 'private@example.com', accountUuid: 'acct-uuid-secret' },
    skillUsage: { grilling: { usageCount: 3 } },
    cachedUsageUtilization: {
      fetchedAtMs: 1795519000000,
      accountUuid: 'acct-uuid-secret',
      utilization: { five_hour: { utilization: 18, resets_at: '2026-11-24T16:00:00Z' } },
    },
  }));
  return { homeDir, configDir, claudeJsonPath };
}

test('Claude discovery resolves CLAUDE_CONFIG_DIR and excludes credentials', async () => {
  assert.equal(resolveClaudePaths({ env: { CLAUDE_CONFIG_DIR: 'D:\\Cl' }, homeDir: 'C:\\U' }).configDir, path.normalize('D:\\Cl'));
  assert.equal(resolveClaudePaths({ env: {}, homeDir: 'C:\\U' }).configDir, path.normalize('C:\\U\\.claude'));

  const { homeDir, configDir, claudeJsonPath } = makeClaudeTree();
  try {
    const sources = await discoverClaudeSources({ claudeConfigDir: configDir, claudeJsonPath });
    assert.deepEqual(
      new Set(sources.map((s) => s.kind)),
      new Set(['transcript', 'subagent_transcript', 'subagent_meta', 'runtime_session', 'claude_json_usage'])
    );
    assert.equal(sources.some((s) => s.path.includes('.credentials.json')), false);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('acquireClaude preserves duplicate assistant usage, separates snapshots, uses cwd, and strips secrets', async () => {
  const { homeDir, configDir, claudeJsonPath } = makeClaudeTree();
  try {
    const cursors = new SourceCursorStore();
    const batch = await acquireClaude({ claudeConfigDir: configDir, claudeJsonPath }, cursors);
    assert.equal(batch.filesScanned, 5);
    assert.equal(batch.filesRead, 5);

    const assistants = batch.observations.filter((o) => o.category === 'usage_point' && o.eventType === 'assistant');
    assert.equal(assistants.length, 3);
    const dupes = assistants.filter((o) => o.nativeIds.messageId === 'msg-1');
    assert.deepEqual(dupes.map((o) => o.nativeIds.apiBlockIndex), [0, 1]);
    assert.equal(dupes[0]?.nativeIds.requestRef, 'rref-1');
    assert.equal(dupes[0]?.payload.cwd, 'F:\\Projects\\Alpha');

    const usage0 = dupes[0]?.payload.usage as Record<string, unknown>;
    assert.equal(usage0.cache_read_input_tokens, 0);
    assert.deepEqual(usage0.cache_creation, { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 });
    assert.equal(dupes[0]?.payload.hasThinkingBlocks, true);

    const cached = batch.observations.find((o) => o.eventType === 'cachedUsageUtilization');
    assert.equal(cached?.category, 'usage_snapshot');
    assert.equal(cached?.timestamp, 1795519000000);
    assert.equal(cached?.payload.isCachedSnapshot, true);

    for (const ev of [
      'cost-state', 'quotaLimits', 'subagent_meta', 'runtime_session', 'tool_use',
      'api-request', 'api-request-shape', 'tools-used', 'system:stop_hook_summary',
      'system:compact_boundary', 'derived-from',
    ]) assert.equal(batch.observations.some((o) => o.eventType === ev), true, `Missing ${ev}`);

    assert.equal(batch.diagnostics.some((d) => d.code === 'unknown_event_type'), true);

    const dump = JSON.stringify(batch);
    for (const s of [
      'SECRET USER PROMPT', 'SECRET SYSTEM PROMPT', 'SECRET BASE', 'SECRET TAIL',
      'SECRET THOUGHTS', 'SECRET_PATH', 'SECRET REPLY', 'SECRET HOOK CONTEXT',
      'SECRET SUBAGENT PROMPT', 'SECRET_OAUTH', 'private@example.com', 'acct-uuid-secret', 'skillUsage',
    ]) assert.equal(dump.includes(s), false, `Leaked: ${s}`);

    const second = await acquireClaude({ claudeConfigDir: configDir, claudeJsonPath }, cursors);
    assert.equal(second.filesSkippedUnchanged, 5);
    assert.equal(second.observations.length, 0);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
