import { normalizeRawGlobalMetaId } from '../shared/globalMetaId';

const DEFAULT_ENDPOINTS = [
  'https://api.idchat.io',
];

const ONLINE_STATUS_PATH = '/group-chat/socket/online-status';
const ONLINE_USERS_PATH = '/group-chat/socket/online-users';
const ONLINE_STATUS_BATCH_SIZE = 200;
const ONLINE_USERS_PAGE_SIZE = 100;
const ONLINE_USERS_MAX_PAGES = 10;
const REQUEST_TIMEOUT_MS = 5000;

export interface IdchatOnlineStatusEntry {
  globalMetaId: string;
  isOnline: boolean;
  lastSeenAt: number;
  lastSeenAgoSeconds: number;
  deviceCount: number;
}

export interface IdchatOnlineStatusResult {
  total: number;
  onlineCount: number;
  list: IdchatOnlineStatusEntry[];
}

export interface IdchatOnlineUserEntry {
  globalMetaId: string;
  lastSeenAt: number;
  lastSeenAgoSeconds: number;
  deviceCount: number;
  userInfo?: Record<string, unknown> | null;
}

export interface IdchatOnlineUsersResult {
  total: number;
  cursor: number;
  size: number;
  onlineWindowSeconds: number;
  list: IdchatOnlineUserEntry[];
}

export interface IdchatPresenceServiceOptions {
  endpoints?: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type ApiEnvelope<T> = {
  code?: unknown;
  data?: T;
  message?: unknown;
};

const normalizeEndpoint = (endpoint: string): string => endpoint.replace(/\/+$/, '');

const toFiniteNumber = (value: unknown, fallback = 0): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeGlobalMetaIds = (globalMetaIds: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of globalMetaIds) {
    const normalized = normalizeRawGlobalMetaId(raw) ?? String(raw ?? '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
};

export class IdchatPresenceService {
  private readonly endpoints: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: IdchatPresenceServiceOptions = {}) {
    this.endpoints = (options.endpoints && options.endpoints.length > 0 ? options.endpoints : DEFAULT_ENDPOINTS)
      .map(normalizeEndpoint);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async fetchOnlineStatus(globalMetaIds: string[]): Promise<IdchatOnlineStatusResult> {
    const normalizedIds = normalizeGlobalMetaIds(globalMetaIds);
    if (normalizedIds.length === 0) {
      return { total: 0, onlineCount: 0, list: [] };
    }

    const list: IdchatOnlineStatusEntry[] = [];
    for (let index = 0; index < normalizedIds.length; index += ONLINE_STATUS_BATCH_SIZE) {
      const batch = normalizedIds.slice(index, index + ONLINE_STATUS_BATCH_SIZE);
      const result = await this.postOnlineStatusBatch(batch);
      list.push(...result.list);
    }

    await this.repairNeverSeenOfflineVerdicts(normalizedIds, list);

    return {
      total: list.length,
      onlineCount: list.filter((entry) => entry.isOnline).length,
      list,
    };
  }

  async fetchOnlineUsers(input: { cursor?: number; size?: number; withUserInfo?: boolean } = {}): Promise<IdchatOnlineUsersResult> {
    const params = new URLSearchParams();
    params.set('cursor', String(Math.max(0, Math.trunc(input.cursor ?? 0))));
    params.set('size', String(Math.max(1, Math.min(100, Math.trunc(input.size ?? 20)))));
    if (input.withUserInfo) {
      params.set('withUserInfo', 'true');
    }
    const data = await this.requestWithFallback<IdchatOnlineUsersResult>(`${ONLINE_USERS_PATH}?${params.toString()}`);
    return {
      total: toFiniteNumber((data as any)?.total),
      cursor: toFiniteNumber((data as any)?.cursor),
      size: toFiniteNumber((data as any)?.size),
      onlineWindowSeconds: toFiniteNumber((data as any)?.onlineWindowSeconds),
      list: Array.isArray((data as any)?.list)
        ? (data as any).list.map((entry: any) => ({
          globalMetaId: String(entry?.globalMetaId ?? '').trim(),
          lastSeenAt: toFiniteNumber(entry?.lastSeenAt),
          lastSeenAgoSeconds: toFiniteNumber(entry?.lastSeenAgoSeconds),
          deviceCount: toFiniteNumber(entry?.deviceCount),
          userInfo: entry?.userInfo ?? null,
        })).filter((entry: IdchatOnlineUserEntry) => entry.globalMetaId)
        : [],
    };
  }

  private async postOnlineStatusBatch(globalMetaIds: string[]): Promise<IdchatOnlineStatusResult> {
    const data = await this.requestWithFallback<IdchatOnlineStatusResult>(ONLINE_STATUS_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ globalMetaIds }),
    });
    const list = Array.isArray((data as any)?.list)
      ? (data as any).list.map((entry: any) => ({
        globalMetaId: String(entry?.globalMetaId ?? '').trim(),
        isOnline: Boolean(entry?.isOnline),
        lastSeenAt: toFiniteNumber(entry?.lastSeenAt),
        lastSeenAgoSeconds: toFiniteNumber(entry?.lastSeenAgoSeconds),
        deviceCount: toFiniteNumber(entry?.deviceCount),
      })).filter((entry: IdchatOnlineStatusEntry) => entry.globalMetaId)
      : [];
    return {
      total: toFiniteNumber((data as any)?.total, list.length),
      onlineCount: toFiniteNumber((data as any)?.onlineCount, list.filter((entry) => entry.isOnline).length),
      list,
    };
  }

  /**
   * The online-status endpoint can report `isOnline:false` with
   * `lastSeenAt:0` ("never seen") for identities that ARE online in the
   * shared online-users registry — observed live: online-status returned
   * lastSeenAt:0 for bots that online-users listed with a heartbeat seconds
   * old at the same moment, which made searchRemoteCandidates show a
   * near-empty online list and hard-blocked legitimate OpenTeam invites
   * ("invitee ... is offline"). A never-seen verdict is untrustworthy, so
   * cross-check those ids against the registry before returning. Genuine
   * disconnects come back with a real lastSeenAt and keep their offline
   * verdict untouched; an unreachable registry keeps the original verdicts.
   */
  private async repairNeverSeenOfflineVerdicts(
    queriedIds: string[],
    list: IdchatOnlineStatusEntry[],
  ): Promise<void> {
    const byId = new Map(list.map((entry) => [entry.globalMetaId.toLowerCase(), entry]));
    const suspects = new Set<string>();
    for (const id of queriedIds) {
      const entry = byId.get(id.toLowerCase());
      if (!entry || (!entry.isOnline && !(entry.lastSeenAt > 0))) {
        suspects.add(id.toLowerCase());
      }
    }
    if (suspects.size === 0) return;

    try {
      let cursor = 0;
      for (let page = 0; page < ONLINE_USERS_MAX_PAGES && suspects.size > 0; page += 1) {
        const result = await this.fetchOnlineUsers({ cursor, size: ONLINE_USERS_PAGE_SIZE });
        if (result.list.length === 0) break;
        for (const user of result.list) {
          const key = user.globalMetaId.toLowerCase();
          if (!suspects.delete(key)) continue;
          const existing = byId.get(key);
          if (existing) {
            existing.isOnline = true;
            existing.lastSeenAt = user.lastSeenAt;
            existing.lastSeenAgoSeconds = user.lastSeenAgoSeconds;
            existing.deviceCount = user.deviceCount;
          } else {
            // The online-status response omitted this id entirely: same
            // never-seen pattern, so append the registry entry.
            const repaired: IdchatOnlineStatusEntry = {
              globalMetaId: user.globalMetaId,
              isOnline: true,
              lastSeenAt: user.lastSeenAt,
              lastSeenAgoSeconds: user.lastSeenAgoSeconds,
              deviceCount: user.deviceCount,
            };
            list.push(repaired);
            byId.set(key, repaired);
          }
        }
        cursor += result.list.length;
        if (result.total > 0 && cursor >= result.total) break;
      }
    } catch {
      // Best-effort repair: keep the original verdicts when the registry
      // cannot be reached (same outcome as before this repair existed).
    }
  }

  private async requestWithFallback<T>(pathWithQuery: string, init?: RequestInit): Promise<T> {
    let lastError: unknown;
    for (const endpoint of this.endpoints) {
      try {
        const response = await this.fetchImpl(`${endpoint}${pathWithQuery}`, {
          ...init,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const envelope = await response.json() as ApiEnvelope<T>;
        if (envelope.code !== 0) {
          throw new Error(String(envelope.message || `API code ${String(envelope.code)}`));
        }
        if (envelope.data == null) {
          throw new Error('Missing response data');
        }
        return envelope.data;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('idchat presence request failed');
  }
}
