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
 */

export const TRAFFIC_MODE_KEY = 'traffic.mode';
export const TRAFFIC_FALLBACK_POLICY_KEY = 'traffic.fallbackPolicy';

export type TrafficPinMode = 'traffic' | 'selfpay';
export type TrafficFallbackPolicy = 'selfpay' | 'strict';

export function normalizeTrafficPinMode(value: unknown): TrafficPinMode {
  return String(value ?? '').trim().toLowerCase() === 'traffic' ? 'traffic' : 'selfpay';
}

export function normalizeTrafficFallbackPolicy(value: unknown): TrafficFallbackPolicy {
  return String(value ?? '').trim().toLowerCase() === 'strict' ? 'strict' : 'selfpay';
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
}

export function getTrafficSettings(
  reader: TrafficSettingsReader | null | undefined,
): TrafficSettingsSnapshot {
  return {
    mode: getTrafficPinMode(reader),
    fallbackPolicy: getTrafficFallbackPolicy(reader),
  };
}

/** Minimal kv writer shape shared by SqliteStore and test doubles. */
export type TrafficSettingsStore = TrafficSettingsReader & { set(key: string, value: unknown): void };

/**
 * Persist traffic settings (partial update). Values are normalized on write;
 * omitted fields keep their current value. Returns the resulting snapshot.
 */
export function setTrafficSettings(
  store: TrafficSettingsStore | null | undefined,
  input: { mode?: unknown; fallbackPolicy?: unknown },
): TrafficSettingsSnapshot {
  const current = getTrafficSettings(store);
  const nextMode = input.mode === undefined ? current.mode : normalizeTrafficPinMode(input.mode);
  const nextFallbackPolicy = input.fallbackPolicy === undefined
    ? current.fallbackPolicy
    : normalizeTrafficFallbackPolicy(input.fallbackPolicy);
  if (store) {
    try {
      if (input.mode !== undefined) store.set(TRAFFIC_MODE_KEY, nextMode);
      if (input.fallbackPolicy !== undefined) store.set(TRAFFIC_FALLBACK_POLICY_KEY, nextFallbackPolicy);
    } catch {
      // persistence loss is non-fatal; the returned snapshot still reflects intent
    }
  }
  return { mode: nextMode, fallbackPolicy: nextFallbackPolicy };
}
