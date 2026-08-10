/**
 * Traffic-ized gas fee settings (global, persisted in the SQLite kvStore).
 * Phase B wires read-only accessors with safe defaults into createPin: when
 * nothing is stored the mode is 'selfpay' and behavior is unchanged. Phase C
 * adds the renderer toggle, persistence helpers, and IPC surface following
 * the feeRateStore.ts pattern.
 *
 * - traffic.mode: 'traffic' (sponsor pays gas) | 'selfpay' (default).
 * - traffic.fallbackPolicy: 'selfpay' (fall back to a self-paid broadcast on
 *   sponsor-side insufficiency, default) | 'strict' (throw instead).
 * - traffic.apiBase: assist-service base URL override (integration testing);
 *   empty/unset means the production default baked into the clients.
 */

export const TRAFFIC_MODE_KEY = 'traffic.mode';
export const TRAFFIC_FALLBACK_POLICY_KEY = 'traffic.fallbackPolicy';
export const TRAFFIC_API_BASE_KEY = 'traffic.apiBase';

export type TrafficPinMode = 'traffic' | 'selfpay';
export type TrafficFallbackPolicy = 'selfpay' | 'strict';

export function normalizeTrafficPinMode(value: unknown): TrafficPinMode {
  return String(value ?? '').trim().toLowerCase() === 'traffic' ? 'traffic' : 'selfpay';
}

export function normalizeTrafficFallbackPolicy(value: unknown): TrafficFallbackPolicy {
  return String(value ?? '').trim().toLowerCase() === 'strict' ? 'strict' : 'selfpay';
}

/**
 * Normalize an apiBase override for persistence: trims, strips trailing
 * slashes, '' clears the override. Throws on anything that is not an
 * http(s) URL (callers surface the error and must not persist).
 */
export function normalizeTrafficApiBase(value: unknown): string {
  const text = String(value ?? '').trim().replace(/\/+$/, '');
  if (!text) return '';
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error('traffic.apiBase must be a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('traffic.apiBase must use http or https');
  }
  return text;
}

/** Configured apiBase override; never throws, '' when unset or invalid. */
export function readTrafficApiBase(reader: TrafficSettingsReader | null | undefined): string {
  try {
    return normalizeTrafficApiBase(readTrafficSetting(reader, TRAFFIC_API_BASE_KEY));
  } catch {
    return '';
  }
}

/** Minimal kv reader shape shared by SqliteStore and test doubles. */
export type TrafficSettingsReader = Pick<{ get<T = unknown>(key: string): T | undefined }, 'get'>;

function readTrafficSetting(reader: TrafficSettingsReader | null | undefined, key: string): unknown {
  if (!reader) return undefined;
  try {
    return reader.get(key);
  } catch {
    return undefined;
  }
}

export function getTrafficPinMode(reader: TrafficSettingsReader | null | undefined): TrafficPinMode {
  return normalizeTrafficPinMode(readTrafficSetting(reader, TRAFFIC_MODE_KEY));
}

export function getTrafficFallbackPolicy(
  reader: TrafficSettingsReader | null | undefined,
): TrafficFallbackPolicy {
  return normalizeTrafficFallbackPolicy(readTrafficSetting(reader, TRAFFIC_FALLBACK_POLICY_KEY));
}

/** Settings snapshot for the renderer toggle UI. */
export interface TrafficSettingsSnapshot {
  mode: TrafficPinMode;
  fallbackPolicy: TrafficFallbackPolicy;
  /** Configured assist-service base URL override; '' = production default. */
  apiBase: string;
}

export function getTrafficSettings(
  reader: TrafficSettingsReader | null | undefined,
): TrafficSettingsSnapshot {
  return {
    mode: getTrafficPinMode(reader),
    fallbackPolicy: getTrafficFallbackPolicy(reader),
    apiBase: readTrafficApiBase(reader),
  };
}

/** Minimal kv writer shape shared by SqliteStore and test doubles. */
export type TrafficSettingsStore = TrafficSettingsReader & { set(key: string, value: unknown): void };

/**
 * Persist traffic settings (partial update). Values are normalized on write;
 * omitted fields keep their current value. An invalid apiBase throws and is
 * never persisted. Returns the resulting snapshot.
 */
export function setTrafficSettings(
  store: TrafficSettingsStore | null | undefined,
  input: { mode?: unknown; fallbackPolicy?: unknown; apiBase?: unknown },
): TrafficSettingsSnapshot {
  const current = getTrafficSettings(store);
  const nextMode = input.mode === undefined ? current.mode : normalizeTrafficPinMode(input.mode);
  const nextFallbackPolicy = input.fallbackPolicy === undefined
    ? current.fallbackPolicy
    : normalizeTrafficFallbackPolicy(input.fallbackPolicy);
  // Validate before touching the store: invalid values must not be persisted.
  const nextApiBase = input.apiBase === undefined ? current.apiBase : normalizeTrafficApiBase(input.apiBase);
  if (store) {
    try {
      if (input.mode !== undefined) store.set(TRAFFIC_MODE_KEY, nextMode);
      if (input.fallbackPolicy !== undefined) store.set(TRAFFIC_FALLBACK_POLICY_KEY, nextFallbackPolicy);
      if (input.apiBase !== undefined) store.set(TRAFFIC_API_BASE_KEY, nextApiBase);
    } catch {
      // persistence loss is non-fatal; the returned snapshot still reflects intent
    }
  }
  return { mode: nextMode, fallbackPolicy: nextFallbackPolicy, apiBase: nextApiBase };
}
