const RAW_GLOBAL_META_ID_VERSION_CHARS = new Set(['q', 'p', 'z', 'r', 'y', 't']);

/**
 * The immutable ecosystem identity used by MetaID-aware features.
 *
 * The body of a GlobalMetaID is opaque to IDBots. We only normalize the
 * protocol envelope that the runtime already accepts (trim, lowercase, `id`
 * prefix, supported version marker, and the `1` separator). Decoding or
 * deriving an identity belongs to the MetaID wallet/protocol layer.
 */
export type GlobalMetaID = string;

export function normalizeGlobalMetaID(value: unknown): GlobalMetaID | null {
  if (typeof value !== 'string') return null;

  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith('metaid:')) return null;
  if (!normalized.startsWith('id')) return null;
  if (!RAW_GLOBAL_META_ID_VERSION_CHARS.has(normalized[2] ?? '')) return null;
  if (normalized[3] !== '1') return null;

  return normalized;
}

/** Backward-compatible name used by existing MetaWeb adapters. */
export function normalizeRawGlobalMetaId(value: unknown): GlobalMetaID | null {
  return normalizeGlobalMetaID(value);
}

export function isGlobalMetaID(value: unknown): value is GlobalMetaID {
  return normalizeGlobalMetaID(value) !== null;
}

export function requireGlobalMetaID(value: unknown, label = 'GlobalMetaID'): GlobalMetaID {
  const normalized = normalizeGlobalMetaID(value);
  if (!normalized) {
    throw new Error(`${label} is missing or invalid`);
  }
  return normalized;
}
