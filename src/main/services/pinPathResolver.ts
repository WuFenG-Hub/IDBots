/**
 * Bounded, rate-limited pin-id → protocol-path resolver backing the
 * create-only guard for `/protocols/preference/feedback` modify/revoke
 * writes (shared contract §4.1: hosts reject them before signing).
 *
 * Policy (fail-closed): a modify/revoke whose target path cannot be
 * determined is REJECTED, not waved through. The shared contract has no
 * best-effort carve-out, and this repository cannot amend it unilaterally;
 * fail-closed keeps the guard sound while the coordinator decides whether to
 * relax it.
 *
 * Untrusted MetaApps must not be able to amplify network lookups or grow the
 * cache without bound, so the resolver enforces:
 * - a bounded FIFO cache (resolved paths persist until evicted; a pin's path
 *   is immutable once confirmed);
 * - negative entries (indexer has not seen the pin yet) cached only for a
 *   short TTL so indexer lag heals instead of locking the pin out forever;
 * - 'unknown' outcomes (network/transport errors, rate-limit rejections) are
 *   never cached — the next attempt retries;
 * - a per-caller sliding-window rate limit; over the limit the lookup
 *   resolves 'unknown' (fail-closed for the caller) instead of hitting the
 *   network.
 */

export type PinPathResolution =
  /** The indexer knows the pin and its protocol path (may be an empty path). */
  | { status: 'resolved'; path: string }
  /** The indexer definitively reports the pin as absent (may be indexer lag). */
  | { status: 'not-found' }
  /** Could not determine: transport error, timeout, or rate limited. */
  | { status: 'unknown' };

export interface PinPathLookupFn {
  (pinId: string): Promise<
    | { found: true; path?: unknown }
    | { found: false }
    | null
    | undefined
  >;
}

export interface PinPathResolverOptions {
  /** Hard cap on cached pin ids (both resolved and negative). Default 512. */
  maxCacheEntries?: number;
  /** TTL in ms for negative (not-found) entries. Default 5 minutes. */
  negativeTtlMs?: number;
  /** Max lookups per rate-limit key per window. Default 30/min. */
  maxLookupsPerMinute?: number;
  now?: () => number;
}

interface CacheEntry {
  resolution: Extract<PinPathResolution, { status: 'resolved' | 'not-found' }>;
  storedAt: number;
}

const DEFAULT_MAX_CACHE_ENTRIES = 512;
const DEFAULT_NEGATIVE_TTL_MS = 5 * 60_000;
const WINDOW_MS = 60_000;
const DEFAULT_MAX_LOOKUPS_PER_MINUTE = 30;

export function createBoundedPinPathResolver(
  lookup: PinPathLookupFn,
  options?: PinPathResolverOptions,
): (pinId: string, rateLimitKey?: string) => Promise<PinPathResolution> {
  const maxCacheEntries = Math.max(1, Math.floor(options?.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES));
  const negativeTtlMs = Math.max(0, options?.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS);
  const maxLookupsPerMinute = Math.max(1, Math.floor(options?.maxLookupsPerMinute ?? DEFAULT_MAX_LOOKUPS_PER_MINUTE));
  const now = options?.now ?? Date.now;

  const cache = new Map<string, CacheEntry>();
  const windows = new Map<string, number[]>();

  const pruneWindow = (key: string, nowValue: number): number[] => {
    const active = (windows.get(key) ?? []).filter((stamp) => nowValue - stamp < WINDOW_MS);
    if (active.length) {
      windows.set(key, active);
    } else {
      windows.delete(key);
    }
    return active;
  };

  const store = (pinId: string, resolution: CacheEntry['resolution']): void => {
    if (cache.size >= maxCacheEntries) {
      // FIFO eviction: the oldest insertion is the first Map key.
      const oldest = cache.keys().next().value;
      if (typeof oldest === 'string') {
        cache.delete(oldest);
      }
    }
    cache.set(pinId, { resolution, storedAt: now() });
  };

  return async (pinId, rateLimitKey) => {
    const key = pinId.trim().toLowerCase();
    if (!key) return { status: 'unknown' };

    const cached = cache.get(key);
    if (cached) {
      if (cached.resolution.status === 'resolved') {
        return cached.resolution;
      }
      if (now() - cached.storedAt < negativeTtlMs) {
        return cached.resolution;
      }
      // Negative entry expired: forget it so indexer lag can heal.
      cache.delete(key);
    }

    if (rateLimitKey) {
      const nowValue = now();
      const active = pruneWindow(rateLimitKey, nowValue);
      if (active.length >= maxLookupsPerMinute) {
        return { status: 'unknown' };
      }
      active.push(nowValue);
      windows.set(rateLimitKey, active);
    }

    let resolution: CacheEntry['resolution'];
    try {
      const result = await lookup(key);
      if (result && result.found === true) {
        const path = typeof result.path === 'string' && result.path.trim() ? result.path.trim() : '';
        resolution = { status: 'resolved', path };
      } else {
        resolution = { status: 'not-found' };
      }
    } catch {
      // Transport/indexer failure: unknown, never cached.
      return { status: 'unknown' };
    }
    store(key, resolution);
    return resolution;
  };
}
