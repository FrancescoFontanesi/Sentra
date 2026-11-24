import fs from 'node:fs';
import path from 'node:path';
import { normalizeFsPath } from './paths.js';

export interface WatchTarget {
  dirPath: string;
  fileFilter?: (fileName: string) => boolean;
}

export interface WatchEvent {
  dirPath: string;
  filePath?: string;
  reason: 'fs_watch' | 'reconcile';
}

export interface IncrementalWatcherOptions {
  debounceMs?: number;
  reconcileIntervalMs?: number;
  onTrigger: (event: WatchEvent) => void | Promise<void>;
  onError?: (dirPath: string, error: Error) => void;
}

/** Targeted non-recursive `fs.watch` with debounce and periodic reconciliation for Windows. */
export class IncrementalWatcher {
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private reconcileTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly opts: IncrementalWatcherOptions) {}

  addTarget(target: WatchTarget): boolean {
    if (this.closed) return false;
    const dirPath = normalizeFsPath(target.dirPath);
    if (this.watchers.has(dirPath)) return true;
    if (!fs.existsSync(dirPath)) return false;

    try {
      const watcher = fs.watch(dirPath, { persistent: false }, (_ev, filename) => {
        if (this.closed) return;
        const name = typeof filename === 'string' ? filename : undefined;
        if (name !== undefined && target.fileFilter && !target.fileFilter(name)) return;
        const filePath = name ? normalizeFsPath(path.join(dirPath, name)) : undefined;
        const key = filePath ?? dirPath;
        const prev = this.timers.get(key);
        if (prev) clearTimeout(prev);
        const t = setTimeout(() => {
          this.timers.delete(key);
          if (!this.closed) void this.opts.onTrigger({ dirPath, filePath, reason: 'fs_watch' });
        }, this.opts.debounceMs ?? 200);
        t.unref();
        this.timers.set(key, t);
      });
      watcher.on('error', (err) => {
        this.removeTarget(dirPath);
        this.opts.onError?.(dirPath, err);
      });
      this.watchers.set(dirPath, watcher);
      return true;
    } catch (err) {
      this.opts.onError?.(dirPath, err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  }

  removeTarget(dirPath: string): void {
    const norm = normalizeFsPath(dirPath);
    this.watchers.get(norm)?.close();
    this.watchers.delete(norm);
  }

  startReconciliation(): void {
    const ms = this.opts.reconcileIntervalMs ?? 30_000;
    if (this.closed || ms <= 0 || this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => {
      if (this.closed) return;
      for (const dirPath of this.watchers.keys()) void this.opts.onTrigger({ dirPath, reason: 'reconcile' });
    }, ms);
    this.reconcileTimer.unref();
  }

  get watchedDirectories(): string[] {
    return [...this.watchers.keys()];
  }

  close(): void {
    this.closed = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    for (const t of this.timers.values()) clearTimeout(t);
    for (const w of this.watchers.values()) w.close();
    this.timers.clear();
    this.watchers.clear();
  }
}
