import fs from 'node:fs';
import type { ProviderId } from '../acquisition/types.js';
import {
  ProviderSessionMonitor,
  type SessionRefreshResult,
  type SessionSelection,
} from '../core/session-monitor.js';
import { resolveClaudePaths, type ClaudeDiscoveryOptions } from '../providers/claude/discovery.js';
import { resolveCodexHome, type CodexDiscoveryOptions } from '../providers/codex/discovery.js';
import {
  computeProviderMetrics,
  createInitialProviderSnapshot,
  DEFAULT_CLAUDE_QUOTA_STALE_MS,
  snapshotChangeSignature,
  updateTimeDependentMetrics,
  type ObservatorySnapshot,
  type ProviderObservatorySnapshot,
} from './metrics.js';

export const DEFAULT_REFRESH_INTERVAL_MS = 3_000;

export type ObservatoryListener = (snapshot: ObservatorySnapshot) => void;

export interface ObservatoryHandle {
  getSnapshot(): ObservatorySnapshot;
  getProviderSnapshot(provider: ProviderId): ProviderObservatorySnapshot;
  onDidUpdate(listener: ObservatoryListener): () => void;
  refresh(): Promise<ObservatorySnapshot>;
}

export interface UsageObservatoryOptions {
  workspace?: string;
  refreshIntervalMs?: number;
  claudeQuotaStaleMs?: number;
  nowMs?: () => number;
  codex?: CodexDiscoveryOptions;
  claude?: ClaudeDiscoveryOptions & { checkPidLiveness?: boolean };
  /** Test seam to inject custom monitors without mocking filesystem/OS state. */
  monitors?: Partial<Record<ProviderId, ProviderSessionMonitor>>;
}

function sameSelectionMeta(a?: SessionSelection, b?: SessionSelection): boolean {
  if (!a || !b) return false;
  if (
    a.sessionId !== b.sessionId ||
    a.reason !== b.reason ||
    a.workspace !== b.workspace ||
    a.ambiguous !== b.ambiguous ||
    a.candidates.length !== b.candidates.length
  ) {
    return false;
  }
  for (let i = 0; i < a.candidates.length; i += 1) {
    if (a.candidates[i]!.sessionId !== b.candidates[i]!.sessionId) return false;
  }
  return true;
}

function sanitizeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Strip Windows, UNC, and POSIX file paths to avoid leaking local user paths in status snapshots.
  return raw.replace(/(?:[A-Za-z]:\\|\\\\|\/(?:Users|home|var|tmp))[^\s'"]*/g, '<path>').slice(0, 200);
}

/**
 * Session-centric Usage Observatory coordinating one independent monitor per provider (`codex`, `claude`)
 * with a single periodic timer, per-provider concurrency guards, error isolation, and zero state duplication.
 */
export class UsageObservatory {
  private readonly monitors: Record<ProviderId, ProviderSessionMonitor>;
  private readonly snapshots: Record<ProviderId, ProviderObservatorySnapshot>;
  private readonly signatures: Record<ProviderId, string>;
  private readonly lastSelections: Partial<Record<ProviderId, SessionSelection>> = {};
  private readonly inFlight: Partial<Record<ProviderId, Promise<void>>> = {};
  private readonly listeners = new Set<ObservatoryListener>();
  private readonly nowMs: () => number;
  private readonly refreshIntervalMs: number;
  private readonly claudeQuotaStaleMs: number;
  private readonly codexOpts: CodexDiscoveryOptions;
  private readonly claudeOpts: ClaudeDiscoveryOptions & { checkPidLiveness?: boolean };

  private workspace?: string;
  private workspaceVersion = 0;
  private updatedAtMs: number;
  private timer?: NodeJS.Timeout;
  private started = false;
  private disposed = false;

  constructor(options: UsageObservatoryOptions = {}) {
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.claudeQuotaStaleMs = options.claudeQuotaStaleMs ?? DEFAULT_CLAUDE_QUOTA_STALE_MS;
    this.workspace = options.workspace;
    this.codexOpts = options.codex ?? {};
    this.claudeOpts = options.claude ?? {};

    this.monitors = {
      codex:
        options.monitors?.codex ??
        new ProviderSessionMonitor('codex', {
          ...this.codexOpts,
          workspace: this.workspace,
          nowMs: this.nowMs,
        }),
      claude:
        options.monitors?.claude ??
        new ProviderSessionMonitor('claude', {
          ...this.claudeOpts,
          workspace: this.workspace,
          nowMs: this.nowMs,
        }),
    };

    const initTs = this.nowMs();
    this.updatedAtMs = initTs;
    this.snapshots = {
      codex: createInitialProviderSnapshot('codex', initTs),
      claude: createInitialProviderSnapshot('claude', initTs),
    };
    this.signatures = {
      codex: snapshotChangeSignature(this.snapshots.codex),
      claude: snapshotChangeSignature(this.snapshots.claude),
    };
  }

  /** Starts non-blocking initial refresh and the single periodic refresh timer. */
  start(): void {
    if (this.disposed || this.started) return;
    this.started = true;
    void this.refreshAll();
    if (this.refreshIntervalMs > 0) {
      this.timer = setInterval(() => {
        if (!this.disposed) void this.refreshAll();
      }, this.refreshIntervalMs);
      this.timer.unref();
    }
  }

  getSnapshot(): ObservatorySnapshot {
    return {
      updatedAtMs: this.updatedAtMs,
      ...(this.workspace !== undefined ? { workspace: this.workspace } : {}),
      providers: {
        codex: this.snapshots.codex,
        claude: this.snapshots.claude,
      },
    };
  }

  getProviderSnapshot(provider: ProviderId): ProviderObservatorySnapshot {
    return this.snapshots[provider];
  }

  onDidUpdate(listener: ObservatoryListener): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setWorkspace(workspace?: string): void {
    if (this.disposed || workspace === this.workspace) return;
    this.workspace = workspace;
    this.workspaceVersion += 1;
    this.monitors.codex.setWorkspace(workspace);
    this.monitors.claude.setWorkspace(workspace);
    if (this.started) void this.refreshAll();
  }

  async refreshAll(): Promise<ObservatorySnapshot> {
    if (this.disposed) return this.getSnapshot();
    await Promise.all([this.refreshProvider('codex'), this.refreshProvider('claude')]);
    return this.getSnapshot();
  }

  async refreshProvider(provider: ProviderId): Promise<ProviderObservatorySnapshot> {
    if (this.disposed) return this.snapshots[provider];
    const existing = this.inFlight[provider];
    if (existing) {
      // Never overlap refreshes of the same provider; coalesce callers onto the in-flight run.
      await existing;
      return this.snapshots[provider];
    }

    const run = this.executeProviderRefresh(provider).finally(() => {
      delete this.inFlight[provider];
    });
    this.inFlight[provider] = run;
    await run;
    return this.snapshots[provider];
  }

  /** Minimal read-only facade exported from `activate()` without exposing internal mutable state. */
  createHandle(): ObservatoryHandle {
    return {
      getSnapshot: () => this.getSnapshot(),
      getProviderSnapshot: (provider: ProviderId) => this.getProviderSnapshot(provider),
      onDidUpdate: (listener: ObservatoryListener) => this.onDidUpdate(listener),
      refresh: () => this.refreshAll(),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.listeners.clear();
  }

  private isProviderAvailable(provider: ProviderId): boolean {
    if (provider === 'codex') {
      return fs.existsSync(resolveCodexHome(this.codexOpts));
    }
    const { configDir, claudeJsonPath } = resolveClaudePaths(this.claudeOpts);
    return fs.existsSync(configDir) || fs.existsSync(claudeJsonPath);
  }

  private async executeProviderRefresh(provider: ProviderId): Promise<void> {
    const monitor = this.monitors[provider];
    // Re-run cleanly inside the same in-flight promise if workspace changes mid-refresh.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (this.disposed) return;
      const startWsVersion = this.workspaceVersion;
      let res: SessionRefreshResult;

      try {
        res = await monitor.refresh();
      } catch (err) {
        if (this.disposed) return;
        if (this.workspaceVersion !== startWsVersion) continue;
        const now = this.nowMs();
        const prevSel = this.lastSelections[provider] ?? {
          provider,
          reason: 'none' as const,
          ambiguous: false,
          candidates: [],
          sources: [],
        };
        const errSnap = computeProviderMetrics(provider, monitor.currentState, prevSel, now, {
          providerAvailable: true,
          claudeQuotaStaleMs: this.claudeQuotaStaleMs,
          lastError: sanitizeErrorMessage(err),
        });
        this.publishIfChanged(provider, errSnap, now);
        return;
      }

      if (this.disposed) return;
      if (this.workspaceVersion !== startWsVersion) continue;

      const now = this.nowMs();
      const providerAvailable = res.selection.sessionId !== undefined || this.isProviderAvailable(provider);
      const prev = this.snapshots[provider];
      const prevSel = this.lastSelections[provider];
      const isUnchangedIdle =
        prev.identity.status !== 'initializing' &&
        prev.identity.status !== 'error' &&
        !res.switched &&
        res.filesRead === 0 &&
        sameSelectionMeta(prevSel, res.selection) &&
        (providerAvailable ? prev.identity.status !== 'unavailable' : prev.identity.status === 'unavailable');

      const nextSnap = isUnchangedIdle
        ? updateTimeDependentMetrics(prev, monitor.currentState, res.selection, now, {
            providerAvailable,
            claudeQuotaStaleMs: this.claudeQuotaStaleMs,
          })
        : computeProviderMetrics(provider, monitor.currentState, res.selection, now, {
            providerAvailable,
            claudeQuotaStaleMs: this.claudeQuotaStaleMs,
          });

      this.lastSelections[provider] = res.selection;
      this.publishIfChanged(provider, nextSnap, now);
      return;
    }
  }

  private publishIfChanged(
    provider: ProviderId,
    nextSnap: ProviderObservatorySnapshot,
    nowMs: number
  ): void {
    const nextSig = snapshotChangeSignature(nextSnap);
    const changed = nextSig !== this.signatures[provider];
    this.snapshots[provider] = nextSnap;
    this.signatures[provider] = nextSig;

    if (!changed) return;
    this.updatedAtMs = nowMs;
    if (this.listeners.size === 0) return;

    const snapshot = this.getSnapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Isolate subscriber errors so Observatory ticks continue uninterrupted.
      }
    }
  }
}
