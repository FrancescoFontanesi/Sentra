import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonlSource, readJsonSnapshot, SourceCursorStore } from '../../acquisition/jsonl-reader.js';
import { normalizeFsPath, stripRolloutExtension, walkFilesSafe } from '../../acquisition/paths.js';
import type { AcquisitionBatch, DiagnosticEvent, DiscoveredSource, JsonObject, ObservationEnvelope } from '../../acquisition/types.js';
import type { WatchTarget } from '../../acquisition/watcher.js';
import {
  parseClaudeCachedUsageUtilization,
  parseClaudeRuntimeSession,
  parseClaudeSubagentMeta,
  parseClaudeTranscriptRecord,
  type ClaudeTranscriptContext,
} from './parser.js';

export interface ClaudeDiscoveryOptions {
  claudeConfigDir?: string;
  claudeJsonPath?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export function resolveClaudePaths(options: ClaudeDiscoveryOptions = {}) {
  const home = options.homeDir ?? os.homedir();
  const envDir = (options.env ?? process.env).CLAUDE_CONFIG_DIR?.trim();
  return {
    configDir: normalizeFsPath(options.claudeConfigDir || envDir || path.join(home, '.claude')),
    claudeJsonPath: normalizeFsPath(options.claudeJsonPath || path.join(home, '.claude.json')),
  };
}

function subagentContext(projectsDir: string, filePath: string): ClaudeTranscriptContext {
  const parts = path.relative(projectsDir, filePath).split(/[\\/]+/);
  if (parts.length < 4 || parts[parts.length - 2] !== 'subagents') return {};
  const base = parts[parts.length - 1]!;
  const stem = base.endsWith('.meta.json') ? base.slice(0, -10) : stripRolloutExtension(base);
  return {
    parentSessionId: parts[parts.length - 3],
    agentId: stem.startsWith('agent-') ? stem.slice(6) : stem,
  };
}

export async function discoverClaudeSources(
  options: ClaudeDiscoveryOptions = {}
): Promise<DiscoveredSource[]> {
  const { configDir, claudeJsonPath } = resolveClaudePaths(options);
  const sources: DiscoveredSource[] = [];

  const projectsDir = normalizeFsPath(path.join(configDir, 'projects'));
  if (fs.existsSync(projectsDir)) {
    for (const filePath of await walkFilesSafe(projectsDir, 6)) {
      const parts = path.relative(projectsDir, filePath).split(/[\\/]+/);
      const base = parts[parts.length - 1]!;
      if (parts.length === 2 && base.endsWith('.jsonl')) {
        sources.push({
          provider: 'claude',
          path: filePath,
          logicalKey: `claude:transcript:${parts[0]}/${stripRolloutExtension(base)}`,
          kind: 'transcript',
          compressed: false,
          watchable: true,
        });
      } else if (parts.length === 4 && parts[2] === 'subagents' && base.startsWith('agent-')) {
        const isMeta = base.endsWith('.meta.json');
        if (!isMeta && !base.endsWith('.jsonl')) continue;
        const stem = isMeta ? base.slice(0, -10) : stripRolloutExtension(base);
        sources.push({
          provider: 'claude',
          path: filePath,
          logicalKey: `claude:${isMeta ? 'subagent_meta' : 'subagent'}:${parts[0]}/${parts[1]}/${stem}`,
          kind: isMeta ? 'subagent_meta' : 'subagent_transcript',
          compressed: false,
          watchable: true,
        });
      }
    }
  }

  const sessionsDir = normalizeFsPath(path.join(configDir, 'sessions'));
  if (fs.existsSync(sessionsDir)) {
    try {
      for (const e of await fs.promises.readdir(sessionsDir, { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith('.json')) {
          sources.push({
            provider: 'claude',
            path: normalizeFsPath(path.join(sessionsDir, e.name)),
            logicalKey: `claude:runtime_session:${e.name}`,
            kind: 'runtime_session',
            compressed: false,
            watchable: true,
          });
        }
      }
    } catch {
      // Unreadable sessions dir skipped gracefully.
    }
  }

  if (fs.existsSync(claudeJsonPath)) {
    sources.push({
      provider: 'claude',
      path: claudeJsonPath,
      logicalKey: 'claude:cached_usage_utilization',
      kind: 'claude_json_usage',
      compressed: false,
      watchable: true,
    });
  }

  return sources;
}

export async function getClaudeWatchTargets(options: ClaudeDiscoveryOptions = {}): Promise<WatchTarget[]> {
  const { configDir, claudeJsonPath } = resolveClaudePaths(options);
  const targets: WatchTarget[] = [];

  const projectsDir = normalizeFsPath(path.join(configDir, 'projects'));
  if (fs.existsSync(projectsDir)) {
    const dirs = new Set<string>([projectsDir]);
    for (const s of await discoverClaudeSources(options)) {
      if (s.kind === 'transcript' || s.kind === 'subagent_transcript') {
        dirs.add(normalizeFsPath(path.dirname(s.path)));
      }
    }
    for (const dirPath of dirs) targets.push({ dirPath });
  }

  const sessionsDir = normalizeFsPath(path.join(configDir, 'sessions'));
  if (fs.existsSync(sessionsDir)) {
    targets.push({ dirPath: sessionsDir, fileFilter: (n) => n.endsWith('.json') });
  }

  const jsonDir = normalizeFsPath(path.dirname(claudeJsonPath));
  const jsonBase = path.basename(claudeJsonPath);
  if (fs.existsSync(jsonDir)) {
    targets.push({ dirPath: jsonDir, fileFilter: (n) => n === jsonBase });
  }

  return targets;
}

export async function acquireClaude(
  options: ClaudeDiscoveryOptions = {},
  cursors: SourceCursorStore = new SourceCursorStore()
): Promise<AcquisitionBatch<JsonObject>> {
  const { configDir } = resolveClaudePaths(options);
  const projectsDir = normalizeFsPath(path.join(configDir, 'projects'));
  const sources = await discoverClaudeSources(options);
  const observations: Array<ObservationEnvelope<JsonObject>> = [];
  const diagnostics: DiagnosticEvent[] = [];
  let filesRead = 0;
  let filesSkippedUnchanged = 0;

  for (const source of sources) {
    if (source.kind === 'subagent_meta' || source.kind === 'runtime_session' || source.kind === 'claude_json_usage') {
      const snap = await readJsonSnapshot(source, cursors);
      diagnostics.push(...snap.diagnostics);
      if (snap.skippedUnchanged) { filesSkippedUnchanged += 1; continue; }
      filesRead += 1;
      if (snap.data !== undefined) {
        const parsed = source.kind === 'subagent_meta'
          ? parseClaudeSubagentMeta(snap.data, snap.sourceRef, subagentContext(projectsDir, source.path))
          : source.kind === 'runtime_session'
            ? parseClaudeRuntimeSession(snap.data, snap.sourceRef)
            : parseClaudeCachedUsageUtilization(snap.data, snap.sourceRef);
        observations.push(...parsed.observations);
        diagnostics.push(...parsed.diagnostics);
      }
      continue;
    }

    const subCtx = source.kind === 'subagent_transcript' ? subagentContext(projectsDir, source.path) : {};
    const res = await readJsonlSource(source, cursors, {
      onRecord: (rec, ref) => {
        const parsed = parseClaudeTranscriptRecord(rec.value, ref, rec.position, subCtx);
        observations.push(...parsed.observations);
        diagnostics.push(...parsed.diagnostics);
      },
    });
    diagnostics.push(...res.diagnostics);
    if (res.skippedUnchanged) filesSkippedUnchanged += 1;
    else filesRead += 1;
  }

  return { observations, diagnostics, filesScanned: sources.length, filesRead, filesSkippedUnchanged };
}
