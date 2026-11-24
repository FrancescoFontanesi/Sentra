import type { ProviderId } from '../acquisition/types.js';
import type { ObservatorySnapshot, ProviderObservatorySnapshot } from '../observatory/metrics.js';
import type { ObservatoryHandle } from '../observatory/observatory.js';
import {
  evaluateProviderRules,
  MONITORING_THRESHOLDS,
  type MonitoringSnapshot,
  type PreventiveAlert,
  type ProviderMonitoringSnapshot,
} from './rules.js';

export type MonitoringListener = (snapshot: MonitoringSnapshot) => void;

export interface PreventiveMonitorOptions {
  quotaFreshnessMaxAgeMs?: number;
}

function monitoringSignature(alerts: ReadonlyArray<PreventiveAlert>): string {
  return JSON.stringify(
    alerts.map((a) => [
      a.id,
      a.sessionId,
      a.turnId,
      a.state,
      a.severity,
      a.observedValue,
      a.threshold,
      a.activatedAtMs,
      a.resolvedAtMs,
      a.coverage.evaluable,
      a.coverage.status,
      a.coverage.reason,
      a.summary,
    ])
  );
}

function freezeAlert(alert: PreventiveAlert): PreventiveAlert {
  Object.freeze(alert.evidence);
  Object.freeze(alert.coverage);
  return Object.freeze(alert);
}

/**
 * Passive preventive monitor subscribed exclusively to UsageObservatory updates (`onDidUpdate`).
 * Zero timers, zero watchers, zero transcript reads, zero persistence, and isolated per provider.
 */
export class PreventiveMonitor {
  private readonly alertsByProvider: Record<ProviderId, Map<string, PreventiveAlert>> = {
    codex: new Map(),
    claude: new Map(),
  };
  private readonly snapshots: Record<ProviderId, ProviderMonitoringSnapshot>;
  private readonly signatures: Record<ProviderId, string>;
  private readonly lastSessionId: Partial<Record<ProviderId, string>> = {};
  private readonly lastProviderRef: Partial<Record<ProviderId, ProviderObservatorySnapshot>> = {};
  private readonly listeners = new Set<MonitoringListener>();
  private readonly quotaFreshnessMaxAgeMs: number;

  private unsubscribe?: () => void;
  private updatedAtMs: number;
  private disposed = false;

  constructor(
    observatory: Pick<ObservatoryHandle, 'getSnapshot' | 'onDidUpdate'>,
    options: PreventiveMonitorOptions = {}
  ) {
    this.quotaFreshnessMaxAgeMs =
      options.quotaFreshnessMaxAgeMs ?? MONITORING_THRESHOLDS.quotaPressure.freshnessMaxAgeMs;

    const initial = observatory.getSnapshot();
    this.updatedAtMs = initial.updatedAtMs;
    this.snapshots = {
      codex: Object.freeze({ provider: 'codex', updatedAtMs: initial.updatedAtMs, alerts: Object.freeze([]) as unknown as PreventiveAlert[] }),
      claude: Object.freeze({ provider: 'claude', updatedAtMs: initial.updatedAtMs, alerts: Object.freeze([]) as unknown as PreventiveAlert[] }),
    };
    this.signatures = {
      codex: '[]',
      claude: '[]',
    };

    this.evaluateSnapshot(initial, false);
    this.unsubscribe = observatory.onDidUpdate((snap) => {
      if (!this.disposed) this.evaluateSnapshot(snap, true);
    });
  }

  getSnapshot(): MonitoringSnapshot {
    return Object.freeze({
      updatedAtMs: this.updatedAtMs,
      providers: Object.freeze({
        codex: this.snapshots.codex,
        claude: this.snapshots.claude,
      }),
    });
  }

  getProviderSnapshot(provider: ProviderId): ProviderMonitoringSnapshot {
    return this.snapshots[provider];
  }

  onDidUpdate(listener: MonitoringListener): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.listeners.clear();
  }

  private evaluateSnapshot(obsSnap: ObservatorySnapshot, notify: boolean): void {
    let anyChanged = false;
    for (const provider of ['codex', 'claude'] as const) {
      try {
        if (this.evaluateProvider(provider, obsSnap.providers[provider])) {
          anyChanged = true;
        }
      } catch {
        // Isolate evaluation errors per provider so the other provider continues unaffected.
      }
    }

    if (!anyChanged) return;
    this.updatedAtMs = obsSnap.updatedAtMs;
    if (!notify || this.listeners.size === 0) return;

    const snapshot = this.getSnapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Isolate subscriber errors.
      }
    }
  }

  private evaluateProvider(provider: ProviderId, providerSnap: ProviderObservatorySnapshot): boolean {
    // O(1) skip when Observatory did not publish a new snapshot object for this provider.
    if (this.lastProviderRef[provider] === providerSnap) return false;
    this.lastProviderRef[provider] = providerSnap;

    const prevMap = this.alertsByProvider[provider];
    const nextSessionId = providerSnap.identity.sessionId;
    const prevSessionId = this.lastSessionId[provider];

    // On session change (or session disappearance), clear prior session-scoped alerts while preserving account-scoped quota alerts.
    if (prevSessionId !== nextSessionId) {
      for (const [id, alert] of prevMap.entries()) {
        if (alert.scope === 'session') prevMap.delete(id);
      }
      this.lastSessionId[provider] = nextSessionId;
    }

    const nextAlerts = evaluateProviderRules(
      providerSnap,
      prevMap,
      providerSnap.updatedAtMs,
      this.quotaFreshnessMaxAgeMs
    ).map(freezeAlert);
    Object.freeze(nextAlerts);

    const nextMap = new Map<string, PreventiveAlert>();
    for (const a of nextAlerts) nextMap.set(a.id, a);
    this.alertsByProvider[provider] = nextMap;

    const nextSig = monitoringSignature(nextAlerts);
    const changed = nextSig !== this.signatures[provider];
    this.signatures[provider] = nextSig;

    this.snapshots[provider] = Object.freeze({
      provider,
      updatedAtMs: providerSnap.updatedAtMs,
      ...(nextSessionId !== undefined ? { sessionId: nextSessionId } : {}),
      alerts: nextAlerts,
    });
    return changed;
  }
}
