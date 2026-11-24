import fs from 'node:fs';
import path from 'node:path';

const WIN_EXT = '\\\\?\\';
const WIN_UNC = '\\\\?\\UNC\\';

const SENSITIVE_FILES = new Set([
  'auth.json', 'auth.json.lock', 'auth.lock', '.credentials.json', 'credentials.json',
  'cap_sid', 'installation_id', 'config.toml', 'settings.json', 'settings.json.bak',
]);

const SENSITIVE_EXTS = ['.key', '.pem', '.p12', '.pfx', '.sqlite', '.sqlite-wal', '.sqlite-shm', '.db'];
const SENSITIVE_DIRS = new Set(['.sandbox-secrets', 'shell-snapshots', 'file-history', 'session-env', 'backups', 'sqlite']);

export function normalizeFsPath(raw: string): string {
  if (raw.startsWith(WIN_UNC)) return path.normalize('\\\\' + raw.slice(WIN_UNC.length));
  if (raw.startsWith(WIN_EXT)) {
    const stripped = raw.slice(WIN_EXT.length);
    return stripped.length >= 260 ? WIN_EXT + path.normalize(stripped) : path.normalize(stripped);
  }
  return path.normalize(raw);
}

export async function resolveCanonicalPath(raw: string): Promise<string> {
  const resolved = normalizeFsPath(path.resolve(raw));
  try {
    return normalizeFsPath(await fs.promises.realpath(resolved));
  } catch {
    return resolved;
  }
}

export const stripRolloutExtension = (filePath: string): string =>
  filePath.endsWith('.jsonl.zst')
    ? filePath.slice(0, -10)
    : filePath.endsWith('.jsonl')
      ? filePath.slice(0, -6)
      : filePath;

export function isSensitivePath(targetPath: string): boolean {
  const parts = normalizeFsPath(targetPath).split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return false;

  const base = parts[parts.length - 1]!.toLowerCase();
  if (SENSITIVE_FILES.has(base) || base === '.env' || base.startsWith('.env.')) return true;
  if (SENSITIVE_EXTS.some((ext) => base.endsWith(ext))) return true;
  return parts.slice(0, -1).some((seg) => SENSITIVE_DIRS.has(seg.toLowerCase()));
}

/** Symlink/junction-safe walk with realpath cycle detection. */
export async function walkFilesSafe(
  rootDir: string,
  maxDepth = 16
): Promise<string[]> {
  const results: string[] = [];
  const visited = new Set<string>();

  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let real: string;
    try {
      real = normalizeFsPath(await fs.promises.realpath(dir));
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const e of entries) {
      const full = normalizeFsPath(path.join(dir, e.name));
      if (e.isDirectory()) {
        await visit(full, depth + 1);
      } else if (e.isFile()) {
        results.push(full);
      } else if (e.isSymbolicLink()) {
        try {
          const st = await fs.promises.stat(full);
          if (st.isDirectory()) await visit(full, depth + 1);
          else if (st.isFile()) results.push(full);
        } catch {
          // Ignore broken symlinks/junctions.
        }
      }
    }
  }

  await visit(rootDir, 0);
  return results;
}
