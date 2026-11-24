import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { readJsonlSource, readJsonSnapshot, SourceCursorStore } from '../acquisition/jsonl-reader.js';
import { normalizeFsPath } from '../acquisition/paths.js';
import {
  asNum,
  asObj,
  asStr,
  type DiagnosticEvent,
  type DiscoveredSource,
  type JsonObject,
  type ObservationEnvelope,
  type ProviderId,
} from '../acquisition/types.js';
import {
  discoverClaudeSources,
  type ClaudeDiscoveryOptions,
} from '../providers/claude/discovery.js';
import {
  parseClaudeCachedUsageUtilization,
  parseClaudeRuntimeSession,
  parseClaudeSubagentMeta,
  parseClaudeTranscriptRecord,
} from '../providers/claude/parser.js';
import {
  discoverCodexSources,
  resolveCodexHome,
  type CodexDiscoveryOptions,
} from '../providers/codex/discovery.js';
import { parseCodexRolloutRecord, type CodexParseContext } from '../providers/codex/parser.js';
import { createEmptyState, type SentraState } from './model.js';
import { reconcileObservations, type ReconcileSummary } from './reconcile.js';

export type SelectionReason =
  | 'runtime_workspace'
  | 'runtime_active'
  | 'workspace_recent'
  | 'most_recent'
  | 'none';

export interface SessionCandidate {
  sessionId: string;
  workspace?: string;
  updatedAtMs: number;
  sourcePath: string;
}

export interface SessionSelection {
  provider: ProviderId;
  sessionId?: string;
  reason: SelectionReason;
  workspace?: string;
  ambiguous: boolean;
  candidates: SessionCandidate[];
  sources: DiscoveredSource[];
}

export interface SessionRefreshResult {
  selection: SessionSelection;
  switched: boolean;
  filesRead: number;
  filesSkippedUnchanged: number;
  bytesRead: number;
  summary: ReconcileSummary;
  diagnostics: DiagnosticEvent[];
}

interface CodexHeaderMeta {
  sessionId?: string;
  threadId?: string;
  parentThreadId?: string;
  isSubagent: boolean;
  cwd?: string;
}

const ACTIVE_WINDOW_MS = 15 * 60 * 1000;
const CODEX_HEADER_PEEK_LIMIT = 40;
const CLAUDE_WORKSPACE_PEEK_LIMIT = 15;
const MAX_RECENT_QUOTA_SNAPSHOTS = 1000;

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sameWorkspace(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const na = normalizeFsPath(a);
  const nb = normalizeFsPath(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** Reads only the first JSONL line (handling plain and `.zst`) without loading the full file. */
async function peekFirstJsonlLine(filePath: string): Promise<JsonObject | undefined> {
  const isZst = filePath.endsWith('.zst');
  return new Promise((resolve) => {
    const src = fs.createReadStream(filePath);
    const stream = isZst ? src.pipe(zlib.createZstdDecompress()) : src;
    const chunks: Buffer[] = [];
    let len = 0;
    let done = false;
    const finish = (val: JsonObject | undefined) => {
      if (done) return;
      done = true;
      src.destroy();
      if (isZst) stream.destroy();
      resolve(val);
    };
    stream.on('data', (raw: Buffer | string) => {
      const c = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      const nl = c.indexOf(0x0a);
      if (nl !== -1) {
        chunks.push(c.subarray(0, nl));
        const end = len + nl;
        const buf = Buffer.concat(chunks, end);
        const trim = buf.length > 0 && buf[buf.length - 1] === 0x0d ? buf.length - 1 : buf.length;
        try {
          finish(asObj(JSON.parse(buf.subarray(0, trim).toString('utf8'))));
        } catch {
          finish(undefined);
        }
      } else {
        chunks.push(Buffer.from(c));
        len += c.length;
      }
    });
    stream.on('error', () => finish(undefined));
    stream.on('end', () => finish(undefined));
  });
}

/** Peeks the first few JSONL lines of a Claude transcript to read its `cwd` without full parsing. */
async function peekClaudeCwd(filePath: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const src = fs.createReadStream(filePath);
    let pending = Buffer.alloc(0);
    let linesChecked = 0;
    let done = false;
    const finish = (cwd?: string) => {
      if (done) return;
      done = true;
      src.destroy();
      resolve(cwd);
    };
    src.on('data', (raw: Buffer | string) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      const combined = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      let start = 0;
      while (start < combined.length) {
        const nl = combined.indexOf(0x0a, start);
        if (nl === -1) break;
        const text = combined.subarray(start, nl).toString('utf8').trim();
        start = nl + 1;
        if (!text) continue;
        linesChecked += 1;
        try {
          const obj = asObj(JSON.parse(text));
          const cwd = asStr(obj?.cwd);
          if (cwd) { finish(cwd); return; }
        } catch {
          // Ignore malformed early line.
        }
        if (linesChecked >= 8) { finish(undefined); return; }
      }
      pending = start < combined.length ? Buffer.from(combined.subarray(start)) : Buffer.alloc(0);
    });
    src.on('error', () => finish(undefined));
    src.on('end', () => finish(undefined));
  });
}

function parseCodexHeader(hdr: JsonObject | undefined): CodexHeaderMeta | undefined {
  if (!hdr || hdr.type !== 'session_meta') return undefined;
  const p = asObj(hdr.payload);
  if (!p) return undefined;
  const parentThreadId = asStr(p.parent_thread_id);
  const srcObj = asObj(p.source);
  const isSubagent = Boolean(parentThreadId || (srcObj && 'subagent' in srcObj));
  return {
    sessionId: asStr(p.session_id) ?? asStr(p.id),
    threadId: asStr(p.id),
    parentThreadId,
    isSubagent,
    cwd: asStr(p.cwd),
  };
}

async function statMtime(filePath: string): Promise<number> {
  try {
    return (await fs.promises.stat(filePath)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Selects the current Codex session without scanning the full history:
 * prioritizes active uncompressed rollouts + workspace match, never choosing a subagent as primary target.
 */
export async function selectCodexSession(
  options: CodexDiscoveryOptions & { workspace?: string; nowMs?: number } = {}
): Promise<SessionSelection> {
  const nowMs = options.nowMs ?? Date.now();
  const discovered = (await discoverCodexSources({ ...options, mode: 'incremental' })).filter(
    (s) => s.kind === 'rollout'
  );
  if (discovered.length === 0) {
    return { provider: 'codex', reason: 'none', ambiguous: false, candidates: [], sources: [] };
  }

  const ranked = await Promise.all(discovered.map(async (s) => ({ s, mtimeMs: await statMtime(s.path) })));
  ranked.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // Peek headers only for the most recent rollouts to find primary sessions & associated segments/subagents.
  const inspected: Array<{ s: DiscoveredSource; mtimeMs: number; meta?: CodexHeaderMeta }> = [];
  for (const item of ranked.slice(0, CODEX_HEADER_PEEK_LIMIT)) {
    const meta = parseCodexHeader(await peekFirstJsonlLine(item.s.path));
    inspected.push({ ...item, meta });
  }

  const primaryBySession = new Map<string, SessionCandidate & { active: boolean; workspaceMatch: boolean }>();
  for (const item of inspected) {
    if (!item.meta?.sessionId || item.meta.isSubagent) continue;
    const sid = item.meta.sessionId;
    const isActive = !item.s.compressed && nowMs - item.mtimeMs <= ACTIVE_WINDOW_MS;
    const wsMatch = sameWorkspace(item.meta.cwd, options.workspace);
    const prev = primaryBySession.get(sid);
    if (!prev || item.mtimeMs > prev.updatedAtMs) {
      primaryBySession.set(sid, {
        sessionId: sid,
        workspace: item.meta.cwd ?? prev?.workspace,
        updatedAtMs: item.mtimeMs,
        sourcePath: item.s.path,
        active: isActive || Boolean(prev?.active),
        workspaceMatch: wsMatch || Boolean(prev?.workspaceMatch),
      });
    }
  }

  const allPrimary = [...primaryBySession.values()].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  if (allPrimary.length === 0) {
    return { provider: 'codex', reason: 'none', ambiguous: false, candidates: [], sources: [] };
  }

  const tiers: Array<[SelectionReason, typeof allPrimary]> = [
    ['runtime_workspace', allPrimary.filter((c) => c.active && c.workspaceMatch)],
    ['runtime_active', allPrimary.filter((c) => c.active)],
    ['workspace_recent', allPrimary.filter((c) => c.workspaceMatch)],
    ['most_recent', allPrimary],
  ];
  const [reason, pool] = tiers.find(([, list]) => list.length > 0)!;
  const chosen = pool[0]!;
  const ambiguous =
    reason === 'runtime_workspace' || reason === 'runtime_active'
      ? pool.length > 1
      : pool.length > 1 && pool[0]!.updatedAtMs === pool[1]!.updatedAtMs;

  // Gather ONLY segments & subagents belonging to `chosen.sessionId`.
  const chosenSources: DiscoveredSource[] = [];
  const seenPaths = new Set<string>();
  const addSource = (s: DiscoveredSource) => {
    if (!seenPaths.has(s.path)) {
      seenPaths.add(s.path);
      chosenSources.push(s);
    }
  };

  for (const item of inspected) {
    if (!item.meta) continue;
    const matchesSession =
      item.meta.sessionId === chosen.sessionId ||
      item.meta.threadId === chosen.sessionId ||
      item.meta.parentThreadId === chosen.sessionId;
    if (matchesSession) addSource(item.s);
  }

  // Also pick up older compressed segments whose filename carries the exact sessionId (without full history scan).
  for (const item of ranked.slice(CODEX_HEADER_PEEK_LIMIT)) {
    if (path.basename(item.s.path).includes(chosen.sessionId)) addSource(item.s);
  }
  const archivedDir = path.join(resolveCodexHome(options), 'archived_sessions');
  if (fs.existsSync(archivedDir)) {
    try {
      for (const name of await fs.promises.readdir(archivedDir)) {
        if (name.includes(chosen.sessionId) && (name.endsWith('.jsonl.zst') || name.endsWith('.jsonl'))) {
          const full = normalizeFsPath(path.join(archivedDir, name));
          addSource({
            provider: 'codex',
            path: full,
            logicalKey: `codex:rollout:${name.replace(/\.jsonl(\.zst)?$/, '')}`,
            kind: 'archived_rollout',
            compressed: name.endsWith('.jsonl.zst'),
            watchable: false,
          });
        }
      }
    } catch {
      // Unreadable archive dir skipped.
    }
  }

  return {
    provider: 'codex',
    sessionId: chosen.sessionId,
    reason,
    workspace: chosen.workspace,
    ambiguous,
    candidates: pool.map(({ sessionId, workspace, updatedAtMs, sourcePath }) => ({
      sessionId, workspace, updatedAtMs, sourcePath,
    })),
    sources: chosenSources,
  };
}

/**
 * Selects the current Claude Code session:
 * prioritizes live `sessions/<pid>.json` runtime evidence + workspace match, falling back to the
 * most recently updated main transcript (never selecting a subagent as primary target).
 */
export async function selectClaudeSession(
  options: ClaudeDiscoveryOptions & { workspace?: string; checkPidLiveness?: boolean } = {}
): Promise<SessionSelection> {
  const discovered = await discoverClaudeSources(options);
  const mainTranscripts = discovered.filter((s) => s.kind === 'transcript');
  if (mainTranscripts.length === 0) {
    return { provider: 'claude', reason: 'none', ambiguous: false, candidates: [], sources: [] };
  }

  const transcriptById = new Map<string, { s: DiscoveredSource; mtimeMs: number }>();
  const rankedTranscripts = await Promise.all(
    mainTranscripts.map(async (s) => {
      const mtimeMs = await statMtime(s.path);
      const id = path.basename(s.path, '.jsonl');
      transcriptById.set(id, { s, mtimeMs });
      return { id, s, mtimeMs };
    })
  );
  rankedTranscripts.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // 1. Inspect runtime `sessions/<pid>.json` files.
  const activeRuntime: Array<SessionCandidate & { workspaceMatch: boolean }> = [];
  const checkPid = options.checkPidLiveness ?? true;
  for (const rs of discovered.filter((s) => s.kind === 'runtime_session')) {
    try {
      const data = asObj(JSON.parse(await fs.promises.readFile(rs.path, 'utf8')));
      const sid = asStr(data?.sessionId);
      const pid = asNum(data?.pid);
      if (!sid) continue;
      if (checkPid && pid !== undefined && !isProcessAlive(pid)) continue;
      const cwd = asStr(data?.cwd);
      const updated = asNum(data?.updatedAt) ?? asNum(data?.statusUpdatedAt) ?? (await statMtime(rs.path));
      const t = transcriptById.get(sid);
      activeRuntime.push({
        sessionId: sid,
        workspace: cwd,
        updatedAtMs: Math.max(updated, t?.mtimeMs ?? 0),
        sourcePath: t?.s.path ?? rs.path,
        workspaceMatch: sameWorkspace(cwd, options.workspace),
      });
    } catch {
      // Ignore unreadable runtime session file.
    }
  }
  activeRuntime.sort((a, b) => b.updatedAtMs - a.updatedAtMs);

  let reason: SelectionReason = 'most_recent';
  let pool: SessionCandidate[] = [];

  const rtWs = activeRuntime.filter((c) => c.workspaceMatch);
  if (rtWs.length > 0) {
    reason = 'runtime_workspace';
    pool = rtWs;
  } else if (activeRuntime.length > 0) {
    reason = 'runtime_active';
    pool = activeRuntime;
  } else if (options.workspace) {
    const wsMatches: SessionCandidate[] = [];
    for (const t of rankedTranscripts.slice(0, CLAUDE_WORKSPACE_PEEK_LIMIT)) {
      const cwd = await peekClaudeCwd(t.s.path);
      if (sameWorkspace(cwd, options.workspace)) {
        wsMatches.push({ sessionId: t.id, workspace: cwd, updatedAtMs: t.mtimeMs, sourcePath: t.s.path });
      }
    }
    if (wsMatches.length > 0) {
      reason = 'workspace_recent';
      pool = wsMatches;
    }
  }

  if (pool.length === 0) {
    reason = 'most_recent';
    pool = rankedTranscripts.slice(0, 5).map((t) => ({
      sessionId: t.id, updatedAtMs: t.mtimeMs, sourcePath: t.s.path,
    }));
  }

  const chosen = pool[0]!;
  const ambiguous =
    reason === 'runtime_workspace' || reason === 'runtime_active'
      ? pool.length > 1
      : pool.length > 1 && pool[0]!.updatedAtMs === pool[1]!.updatedAtMs;

  // Gather ONLY the chosen session's transcript, its own subagents, its runtime json, and provider quota.
  const subPrefix = `/${chosen.sessionId}/`;
  const chosenSources = discovered.filter(
    (s) =>
      (s.kind === 'transcript' && path.basename(s.path, '.jsonl') === chosen.sessionId) ||
      ((s.kind === 'subagent_transcript' || s.kind === 'subagent_meta') && s.logicalKey.includes(subPrefix)) ||
      s.kind === 'claude_json_usage'
  );

  return {
    provider: 'claude',
    sessionId: chosen.sessionId,
    reason,
    workspace: chosen.workspace,
    ambiguous,
    candidates: pool,
    sources: chosenSources,
  };
}

/**
 * In-memory session-centric monitor for a single provider (Codex or Claude Code).
 * Tracks only the current session (+ its subagents) and provider-scoped quota state;
 * switching sessions discards previous session state so memory never grows unboundedly.
 */
export class ProviderSessionMonitor {
  private state: SentraState = createEmptyState();
  private cursors = new SourceCursorStore();
  private currentSelection?: SessionSelection;

  constructor(
    public readonly provider: ProviderId,
    private readonly options: (CodexDiscoveryOptions & ClaudeDiscoveryOptions) & {
      workspace?: string;
      checkPidLiveness?: boolean;
      nowMs?: () => number;
    } = {}
  ) {}

  get currentState(): SentraState {
    return this.state;
  }

  get selection(): SessionSelection | undefined {
    return this.currentSelection;
  }

  async refresh(): Promise<SessionRefreshResult> {
    const selection =
      this.provider === 'codex'
        ? await selectCodexSession({ ...this.options, nowMs: this.options.nowMs?.() })
        : await selectClaudeSession(this.options);

    const prevId = this.currentSelection?.sessionId;
    const switched = Boolean(selection.sessionId && prevId && selection.sessionId !== prevId);

    if (switched) {
      // Drop previous session state while preserving provider/account-scoped quota history.
      const prevQuotas = this.state.quotaSnapshots.slice(-MAX_RECENT_QUOTA_SNAPSHOTS);
      const prevLatestQuota = { ...this.state.latestQuotaByCategory };
      this.state = createEmptyState();
      this.state.quotaSnapshots = prevQuotas;
      this.state.latestQuotaByCategory = prevLatestQuota;
      this.cursors = new SourceCursorStore();
    }

    this.currentSelection = selection;
    const observations: Array<ObservationEnvelope<JsonObject>> = [];
    const diagnostics: DiagnosticEvent[] = [];
    let filesRead = 0;
    let filesSkippedUnchanged = 0;
    let bytesRead = 0;

    const activeSession = selection.sessionId
      ? this.state.sessions[`${this.provider}:${selection.sessionId}`]
      : undefined;

    for (const source of selection.sources) {
      if (source.kind === 'subagent_meta' || source.kind === 'runtime_session' || source.kind === 'claude_json_usage') {
        const snap = await readJsonSnapshot(source, this.cursors);
        diagnostics.push(...snap.diagnostics);
        if (snap.skippedUnchanged) { filesSkippedUnchanged += 1; continue; }
        filesRead += 1;
        bytesRead += this.cursors.getByPath(snap.sourceRef.path)?.size ?? 0;
        if (snap.data !== undefined) {
          const parsed =
            source.kind === 'subagent_meta'
              ? parseClaudeSubagentMeta(snap.data, snap.sourceRef, {
                  parentSessionId: selection.sessionId,
                  agentId: path.basename(source.path, '.meta.json').replace(/^agent-/, ''),
                })
              : source.kind === 'runtime_session'
                ? parseClaudeRuntimeSession(snap.data, snap.sourceRef)
                : parseClaudeCachedUsageUtilization(snap.data, snap.sourceRef);
          observations.push(...parsed.observations);
          diagnostics.push(...parsed.diagnostics);
        }
        continue;
      }

      const prevOffset = this.cursors.getByLogicalKey(source.logicalKey)?.byteOffset ?? 0;
      const codexCtx: CodexParseContext = {
        sessionId: selection.sessionId,
        harnessVersion: activeSession?.harnessVersion,
      };
      const claudeSubCtx =
        source.kind === 'subagent_transcript'
          ? {
              parentSessionId: selection.sessionId,
              agentId: path.basename(source.path, '.jsonl').replace(/^agent-/, ''),
            }
          : { parentSessionId: selection.sessionId };

      const res = await readJsonlSource(source, this.cursors, {
        onRecord: (rec, ref) => {
          const parsed =
            this.provider === 'codex'
              ? parseCodexRolloutRecord(rec.value, ref, rec.position, codexCtx)
              : parseClaudeTranscriptRecord(rec.value, ref, rec.position, claudeSubCtx);
          observations.push(...parsed.observations);
          diagnostics.push(...parsed.diagnostics);
        },
      });
      diagnostics.push(...res.diagnostics);
      if (res.skippedUnchanged) {
        filesSkippedUnchanged += 1;
      } else {
        filesRead += 1;
        const cur = this.cursors.getByPath(res.sourceRef.path);
        bytesRead += cur ? Math.max(0, cur.byteOffset - prevOffset) : 0;
      }
    }

    const summary = reconcileObservations(this.state, undefined, observations);
    return {
      selection,
      switched,
      filesRead,
      filesSkippedUnchanged,
      bytesRead,
      summary,
      diagnostics,
    };
  }
}
