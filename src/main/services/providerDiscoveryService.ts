import { normalizeRawGlobalMetaId } from '../shared/globalMetaId';
import type { IdchatOnlineStatusEntry, IdchatPresenceService } from './idchatPresenceService';
import { PollBackoffController } from './pollBackoffController';

/**
 * Skip a forced refresh when the last snapshot is younger than the poll cadence.
 * Issue #24: the polling cadence is now gated by a PollBackoffController —
 * consecutive online-status fetch failures escalate the retry delay and
 * eventually open the circuit (attempts paused for a cooldown, then one
 * half-open probe). Demand-driven refreshes (refreshNow / refreshNowIfStale
 * callers) are NOT gated — they always run; their outcomes still feed the
 * same controller so a successful external probe recovers the poller.
 */
export const DISCOVERY_SNAPSHOT_MIN_AGE_MS = 10 * 1000;
const PRESENCE_POLL_INTERVAL_MS = DISCOVERY_SNAPSHOT_MIN_AGE_MS;

type ProviderGroup = {
  key: string;
  globalMetaId: string;
  address: string;
  services: any[];
};

type RefreshOptions = {
  rebroadcast?: boolean;
};

type PollingOptions = {
  onRefreshError?: (error: unknown, phase: 'initial' | 'interval') => void | Promise<void>;
};

type ResolvedRefreshOptions = {
  rebroadcast: boolean;
};

export interface DiscoveryProviderState {
  key: string;
  globalMetaId: string;
  address: string;
  lastSeenSec: number | null;
  lastCheckAt: number | null;
  lastSource: string | null;
  lastError: string | null;
  online: boolean;
  optimisticLocal: boolean;
}

export interface DiscoverySnapshot {
  onlineBots: Record<string, number>;
  availableServices: any[];
  providers: Record<string, DiscoveryProviderState>;
}

export interface ProviderDiscoveryServiceDeps {
  presence: Pick<IdchatPresenceService, 'fetchOnlineStatus'>;
  now?: () => number;
  /** Retry-hygiene controller (issue #24); defaults to a local instance. */
  backoff?: PollBackoffController;
}

type DiscoveryListener = (snapshot: DiscoverySnapshot) => void;

const EMPTY_SNAPSHOT: DiscoverySnapshot = {
  onlineBots: {},
  availableServices: [],
  providers: {},
};

const toSafeString = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
};

const normalizeComparableGlobalMetaId = (value: unknown): string => {
  return normalizeRawGlobalMetaId(value) ?? toSafeString(value);
};

const resolveServiceGlobalMetaId = (service: any): string => {
  return normalizeComparableGlobalMetaId(service?.providerGlobalMetaId || service?.globalMetaId);
};

const resolveServiceProviderAddress = (service: any): string => {
  return toSafeString(service?.providerAddress || service?.createAddress || service?.address);
};

const buildProviderKey = (globalMetaId: string, address: string): string => {
  return `${globalMetaId}::${address}`;
};

const cloneProviderState = (state: DiscoveryProviderState): DiscoveryProviderState => ({ ...state });

const cloneDiscoverySnapshot = (snapshot: DiscoverySnapshot): DiscoverySnapshot => ({
  onlineBots: { ...snapshot.onlineBots },
  availableServices: snapshot.availableServices.map((service) => ({ ...service })),
  providers: Object.fromEntries(
    Object.entries(snapshot.providers).map(([key, state]) => [key, cloneProviderState(state)]),
  ),
});

const normalizeForComparison = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((entry) => normalizeForComparison(entry));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, normalizeForComparison(nestedValue)]),
  );
};

const serializeSnapshot = (snapshot: DiscoverySnapshot): string => {
  return JSON.stringify(normalizeForComparison(snapshot));
};

const normalizeRefreshOptions = (options?: RefreshOptions): ResolvedRefreshOptions => ({
  rebroadcast: Boolean(options?.rebroadcast),
});

const mergeRefreshOptions = (
  left: ResolvedRefreshOptions,
  right: ResolvedRefreshOptions,
): ResolvedRefreshOptions => ({
  rebroadcast: left.rebroadcast || right.rebroadcast,
});

const buildProviderGroups = (services: any[]): ProviderGroup[] => {
  const groups = new Map<string, ProviderGroup>();
  for (const service of services) {
    const status = Number(service?.status ?? 0);
    if (Number.isFinite(status) && status < 0) continue;
    const available = Number(service?.available ?? 1);
    if (Number.isFinite(available) && available === 0) continue;
    const address = resolveServiceProviderAddress(service);
    if (!address) continue;
    const globalMetaId = resolveServiceGlobalMetaId(service);
    const key = buildProviderKey(globalMetaId, address);
    const existing = groups.get(key);
    if (existing) {
      existing.services.push(service);
      continue;
    }
    groups.set(key, { key, globalMetaId, address, services: [service] });
  }
  return [...groups.values()];
};

const toLastSeenSec = (entry: IdchatOnlineStatusEntry | undefined): number | null => {
  if (!entry || !entry.isOnline || !Number.isFinite(entry.lastSeenAt) || entry.lastSeenAt <= 0) return null;
  return Math.floor(entry.lastSeenAt / 1000);
};

const uniqueGlobalMetaIds = (groups: ProviderGroup[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const group of groups) {
    if (!group.globalMetaId || seen.has(group.globalMetaId)) continue;
    seen.add(group.globalMetaId);
    result.push(group.globalMetaId);
  }
  return result;
};

export class ProviderDiscoveryService {
  private readonly deps: ProviderDiscoveryServiceDeps;
  private readonly backoff: PollBackoffController;
  private readonly listeners: Set<DiscoveryListener> = new Set();
  private readonly forcedOfflineGlobalMetaIds: Set<string> = new Set();
  private snapshot: DiscoverySnapshot = cloneDiscoverySnapshot(EMPTY_SNAPSHOT);
  private snapshotSignature = serializeSnapshot(EMPTY_SNAPSHOT);
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollingActive = false;
  private onPollRefreshError: ((error: unknown, phase: 'initial' | 'interval') => void) | null = null;
  private getServices: (() => any[]) | null = null;
  private refreshPromise: Promise<void> | null = null;
  private pendingRefresh = false;
  private pendingRefreshOptions: ResolvedRefreshOptions = normalizeRefreshOptions({ rebroadcast: false });
  private lastRefreshAtMs: number | null = null;

  constructor(deps: ProviderDiscoveryServiceDeps) {
    this.deps = deps;
    this.backoff = deps.backoff ?? new PollBackoffController({
      name: 'provider-discovery',
      baseMs: PRESENCE_POLL_INTERVAL_MS,
      now: deps.now,
      emitLog: (line: string) => console.log(line),
    });
  }

  /** Issue #24: retry-hygiene state of the polling loop (tests / future UI). */
  getPollBackoff(): PollBackoffController {
    return this.backoff;
  }

  get availableServices(): any[] {
    return this.snapshot.availableServices;
  }

  getDiscoverySnapshot(): DiscoverySnapshot {
    return cloneDiscoverySnapshot(this.snapshot);
  }

  subscribe(listener: DiscoveryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  startPolling(getServices: () => any[], options?: PollingOptions): void {
    this.stopPolling();
    this.getServices = getServices;
    const onRefreshError = options?.onRefreshError;
    const handleRefreshError = (error: unknown, phase: 'initial' | 'interval'): void => {
      if (onRefreshError) {
        void Promise.resolve(onRefreshError(error, phase)).catch((handlerError) => {
          console.warn('[ProviderDiscovery] refresh error handler failed:', handlerError);
        });
        return;
      }
      console.warn(`[ProviderDiscovery] ${phase} refresh failed:`, error);
    };
    this.onPollRefreshError = handleRefreshError;
    this.pollingActive = true;
    // Immediate first refresh (parity with the old loop: callers can observe
    // refreshPromise right after startPolling), then self-rescheduling ticks
    // gated by the backoff controller.
    this.pollTick('initial');
  }

  stopPolling(): void {
    this.pollingActive = false;
    this.onPollRefreshError = null;
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.getServices = null;
  }

  /**
   * Issue #24: one guarded polling tick. The backoff gate only throttles the
   * AUTOMATIC loop; demand-driven refreshNow callers are unaffected. Unexpected
   * throws (e.g. getServices blowing up) count as failures too.
   */
  /**
   * The first (immediate) tick reports phase 'initial', later ones 'interval'
   * — same contract as the pre-backoff loop.
   */
  private pollTick(phase: 'initial' | 'interval' = 'interval'): void {
    this.pollTimer = null;
    if (!this.pollingActive) return;
    const handleRefreshError = this.onPollRefreshError
      ?? ((error: unknown, errPhase: 'initial' | 'interval') => {
        console.warn(`[ProviderDiscovery] ${errPhase} refresh failed:`, error);
      });
    if (!this.backoff.ready()) {
      this.schedulePoll(this.backoff.nextDelayMs());
      return;
    }
    void this.refreshNow()
      .catch((error: unknown) => {
        this.backoff.recordFailure();
        handleRefreshError(error, phase);
      })
      .finally(() => {
        if (!this.pollingActive) return;
        this.schedulePoll(this.backoff.nextDelayMs());
      });
  }

  private schedulePoll(delayMs: number): void {
    this.pollTimer = setTimeout(() => this.pollTick(), Math.max(0, delayMs));
    this.pollTimer.unref?.();
  }

  markOffline(globalMetaId: string): void {
    this.forceOffline(globalMetaId, 'manually_marked_offline');
  }

  forceOffline(globalMetaId: string, reason = 'locally_disabled'): void {
    const normalizedGlobalMetaId = normalizeComparableGlobalMetaId(globalMetaId);
    if (!normalizedGlobalMetaId) return;
    this.forcedOfflineGlobalMetaIds.add(normalizedGlobalMetaId);
    this.applyOfflineMutation(normalizedGlobalMetaId, reason);
  }

  clearForceOffline(globalMetaId: string): void {
    const normalizedGlobalMetaId = normalizeComparableGlobalMetaId(globalMetaId);
    if (!normalizedGlobalMetaId) return;
    this.forcedOfflineGlobalMetaIds.delete(normalizedGlobalMetaId);
  }

  getLastRefreshAtMs(): number | null {
    return this.lastRefreshAtMs;
  }

  /**
   * Refresh only when the last completed snapshot is older than `minAgeMs`.
   * Callers that page the same directory (list_online_services) reuse one
   * snapshot instead of forcing a network round-trip per page.
   */
  async refreshNowIfStale(
    minAgeMs = DISCOVERY_SNAPSHOT_MIN_AGE_MS,
    options?: RefreshOptions,
  ): Promise<boolean> {
    if (
      this.lastRefreshAtMs != null
      && this.nowMs() - this.lastRefreshAtMs < minAgeMs
    ) {
      return false;
    }
    await this.refreshNow(options);
    return true;
  }

  async refreshNow(options?: RefreshOptions): Promise<void> {
    const requested = normalizeRefreshOptions(options);
    if (this.refreshPromise) {
      this.pendingRefresh = true;
      this.pendingRefreshOptions = mergeRefreshOptions(this.pendingRefreshOptions, requested);
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      let currentOptions = requested;
      do {
        this.pendingRefresh = false;
        this.pendingRefreshOptions = normalizeRefreshOptions({ rebroadcast: false });
        await this.performRefresh(currentOptions);
        currentOptions = this.pendingRefreshOptions;
      } while (this.pendingRefresh);
    })().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  async waitForRefresh(): Promise<void> {
    await this.refreshPromise?.catch(() => undefined);
  }

  dispose(): void {
    this.stopPolling();
    this.listeners.clear();
  }

  private async performRefresh(options: ResolvedRefreshOptions): Promise<void> {
    const services = this.getServices ? this.getServices() : [];
    const groups = buildProviderGroups(services);
    const ids = uniqueGlobalMetaIds(groups);
    let statusByGlobalMetaId = new Map<string, IdchatOnlineStatusEntry>();

    if (ids.length > 0) {
      try {
        const status = await this.deps.presence.fetchOnlineStatus(ids);
        statusByGlobalMetaId = new Map(
          status.list.map((entry) => [normalizeComparableGlobalMetaId(entry.globalMetaId), entry]),
        );
        this.applySnapshot(
          this.buildIdchatSnapshot(groups, statusByGlobalMetaId),
          options.rebroadcast,
        );
        this.lastRefreshAtMs = this.nowMs();
        this.backoff.recordSuccess();
        return;
      } catch (error) {
        console.warn('[ProviderDiscovery] idchat online-status fetch failed:', error);
        this.backoff.recordFailure();
      }
    }

    this.applySnapshot(
      this.buildIdchatSnapshot(groups, statusByGlobalMetaId, ids.length > 0 ? 'online_status_failed' : null),
      options.rebroadcast,
    );
    this.lastRefreshAtMs = this.nowMs();
  }

  private buildIdchatSnapshot(
    groups: ProviderGroup[],
    statusByGlobalMetaId: Map<string, IdchatOnlineStatusEntry>,
    refreshError: string | null = null,
  ): DiscoverySnapshot {
    const onlineBots: Record<string, number> = {};
    const availableServices: any[] = [];
    const providers: Record<string, DiscoveryProviderState> = {};
    const lastCheckAt = this.nowSec();

    for (const group of groups) {
      const forcedOffline = Boolean(group.globalMetaId) && this.forcedOfflineGlobalMetaIds.has(group.globalMetaId);
      const status = group.globalMetaId ? statusByGlobalMetaId.get(group.globalMetaId) : undefined;
      const lastSeenSec = toLastSeenSec(status);
      const online = Boolean(group.globalMetaId && status?.isOnline && !forcedOffline && !refreshError);
      const lastError = !group.globalMetaId
        ? 'missing_global_metaid'
        : forcedOffline
          ? 'locally_disabled'
          : refreshError;

      providers[group.key] = {
        key: group.key,
        globalMetaId: group.globalMetaId,
        address: group.address,
        lastSeenSec,
        lastCheckAt,
        lastSource: 'idchat',
        lastError,
        online,
        optimisticLocal: false,
      };

      if (online) {
        onlineBots[group.globalMetaId] = lastSeenSec ?? lastCheckAt;
        availableServices.push(...group.services);
      }
    }

    return { onlineBots, availableServices, providers };
  }

  private nowMs(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private nowSec(): number {
    return Math.floor(this.nowMs() / 1000);
  }

  private applySnapshot(nextSnapshot: DiscoverySnapshot, forceEmit: boolean): void {
    const clonedSnapshot = cloneDiscoverySnapshot(nextSnapshot);
    const nextSignature = serializeSnapshot(clonedSnapshot);
    const changed = nextSignature !== this.snapshotSignature;
    this.snapshot = clonedSnapshot;
    this.snapshotSignature = nextSignature;
    if (!changed && !forceEmit) return;
    for (const listener of this.listeners) {
      try {
        listener(this.getDiscoverySnapshot());
      } catch (error) {
        console.warn('[ProviderDiscovery] change listener failed:', error);
      }
    }
  }

  private applyOfflineMutation(globalMetaId: string, reason: string): void {
    const nextSnapshot = this.getDiscoverySnapshot();
    delete nextSnapshot.onlineBots[globalMetaId];
    nextSnapshot.availableServices = nextSnapshot.availableServices.filter(
      (service) => resolveServiceGlobalMetaId(service) !== globalMetaId,
    );
    for (const state of Object.values(nextSnapshot.providers)) {
      if (state.globalMetaId !== globalMetaId) continue;
      state.online = false;
      state.lastError = reason;
      state.optimisticLocal = false;
    }
    this.applySnapshot(nextSnapshot, false);
  }
}
