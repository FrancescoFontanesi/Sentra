import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonlSource, readJsonSnapshot, SourceCursorStore } from '../../acquisition/jsonl-reader.js';
import { normalizeFsPath, stripRolloutExtension, walkFilesSafe } from '../../acquisition/paths.js';
import type { AcquisitionBatch, DiagnosticEvent, DiscoveredSource, JsonObject, ObservationEnvelope } from '../../acquisition/types.js';
import type { WatchTarget } from '../../acquisition/watcher.js';
import {
  parseCodexModelsCache,
  parseCodexRolloutRecord,
  parseCodexSessionIndexRecord,
  type CodexParseContext,
} from './parser.js';

export interface CodexDiscoveryOptions {
  codexHome?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  mode?: 'historical' | 'incremental';
}

export function resolveCodexHome(options: CodexDiscoveryOptions = {}): string {
  if (options.codexHome) return normalizeFsPath(options.codexHome);
  const envHome = (options.env ?? process.env).CODEX_HOME?.trim();
  return normalizeFsPath(envHome || path.join(options.homeDir ?? os.homedir(), '.codex'));
}

const rolloutLogicalKey = (filePath: string) =>
  `codex:rollout:${stripRolloutExtension(path.basename(filePath))}`;

export async function discoverCodexSources(
  options: CodexDiscoveryOptions = {}
): Promise<DiscoveredSource[]> {
  const codexHome = resolveCodexHome(options);
  if (!fs.existsSync(codexHome)) return [];

  const mode = options.mode ?? 'historical';
  const sources: DiscoveredSource[] = [];

  const addRollouts = async (dir: string, kind: string, watchPlain: boolean) => {
    if (!fs.existsSync(dir)) return;
    for (const filePath of await walkFilesSafe(dir)) {
      const zst = filePath.endsWith('.jsonl.zst');
      if (!zst && !filePath.endsWith('.jsonl')) continue;
      sources.push({
        provider: 'codex',
        path: filePath,
        logicalKey: rolloutLogicalKey(filePath),
        kind,
        compressed: zst,
        watchable: watchPlain && !zst,
      });
    }
  };

  await addRollouts(path.join(codexHome, 'sessions'), 'rollout', true);
  // `archived_sessions/` is strictly historical (excluded from continuous monitoring).
  if (mode === 'historical') {
    await addRollouts(path.join(codexHome, 'archived_sessions'), 'archived_rollout', false);
  }

  for (const [file, kind, key] of [
    ['session_index.jsonl', 'session_index', 'codex:session_index'],
    ['models_cache.json', 'models_cache', 'codex:models_cache'],
  ] as const) {
    const p = normalizeFsPath(path.join(codexHome, file));
    if (fs.existsSync(p)) {
      sources.push({ provider: 'codex', path: p, logicalKey: key, kind, compressed: false, watchable: true });
    }
  }

  return sources;
}

export async function getCodexWatchTargets(options: CodexDiscoveryOptions = {}): Promise<WatchTarget[]> {
  const codexHome = resolveCodexHome(options);
  if (!fs.existsSync(codexHome)) return [];

  const targets: WatchTarget[] = [{
    dirPath: codexHome,
    fileFilter: (name) => name === 'session_index.jsonl' || name === 'models_cache.json',
  }];

  const sessionsDir = normalizeFsPath(path.join(codexHome, 'sessions'));
  if (fs.existsSync(sessionsDir)) {
    const dirs = new Set<string>([sessionsDir]);
    for (const f of await walkFilesSafe(sessionsDir)) {
      if (f.endsWith('.jsonl')) dirs.add(normalizeFsPath(path.dirname(f)));
    }
    for (const dirPath of dirs) targets.push({ dirPath });
  }
  return targets;
}

export async function acquireCodex(
  options: CodexDiscoveryOptions = {},
  cursors: SourceCursorStore = new SourceCursorStore()
): Promise<AcquisitionBatch<JsonObject>> {
  const sources = await discoverCodexSources(options);
  const observations: Array<ObservationEnvelope<JsonObject>> = [];
  const diagnostics: DiagnosticEvent[] = [];
  let filesRead = 0;
  let filesSkippedUnchanged = 0;

  for (const source of sources) {
    if (source.kind === 'models_cache') {
      const snap = await readJsonSnapshot(source, cursors);
      diagnostics.push(...snap.diagnostics);
      if (snap.skippedUnchanged) { filesSkippedUnchanged += 1; continue; }
      filesRead += 1;
      if (snap.data !== undefined) {
        const parsed = parseCodexModelsCache(snap.data, snap.sourceRef);
        observations.push(...parsed.observations);
        diagnostics.push(...parsed.diagnostics);
      }
      continue;
    }

    const ctx: CodexParseContext = {};
    const res = await readJsonlSource(source, cursors, {
      onRecord: (rec, ref) => {
        const parsed = source.kind === 'session_index'
          ? parseCodexSessionIndexRecord(rec.value, ref, rec.position)
          : parseCodexRolloutRecord(rec.value, ref, rec.position, ctx);
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
