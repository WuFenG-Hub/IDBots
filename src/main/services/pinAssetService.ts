import { Buffer } from 'buffer';
import { fetchContentWithFallback } from './localIndexerProxy';

const METAID_CONTENT_BASE = 'https://file.metaid.io/metafile-indexer/content';
const METAID_FILE_CONTENT_BASE = 'https://file.metaid.io/metafile-indexer/api/v1/files/content';
const METAID_FILE_ACCELERATE_CONTENT_BASE = 'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content';
const METAID_USER_AVATAR_ACCELERATE_BASE = 'https://file.metaid.io/metafile-indexer/api/v1/users/avatar/accelerate';
const PIN_CONTENT_PATTERNS = [
  /^\/content\/([^/?#]+)/i,
  /^\/metafile-indexer\/content\/([^/?#]+)/i,
  /^\/metafile-indexer\/thumbnail\/([^/?#]+)/i,
  /^\/metafile-indexer\/api\/v1\/files\/content\/([^/?#]+)/i,
  /^\/metafile-indexer\/api\/v1\/files\/accelerate\/content\/([^/?#]+)/i,
  /^\/metafile-indexer\/api\/v1\/users\/avatar\/accelerate\/([^/?#]+)/i,
];

const resolvedPinAssetCache = new Map<string, Promise<string | null>>();

const normalizeReference = (reference: string | null | undefined): string => (
  typeof reference === 'string' ? reference.trim() : ''
);

const isJsonMime = (mime: string): boolean => /(?:^application\/json$|[+/]json$)/i.test(mime);

const isTextMime = (mime: string): boolean => /^text\//i.test(mime);

function stripQueryAndFragment(value: string): string {
  return value.split(/[?#]/)[0] ?? '';
}

function normalizeEmbeddedImageDataUrl(buffer: Buffer): string | null {
  const text = buffer.toString('utf8').trim();
  if (/^data:image\/[a-z0-9.+-]+(?:;[a-z0-9_.=+-]+)*,/i.test(text)) {
    return text;
  }
  return null;
}

function normalizeDataUrlReference(reference: string): string | null {
  if (/^data:image\/[a-z0-9.+-]+(?:;[a-z0-9_.=+-]+)*,/i.test(reference)) {
    return reference;
  }

  const commaIndex = reference.indexOf(',');
  if (commaIndex < 0) {
    return null;
  }
  const metadata = reference.slice(5, commaIndex).toLowerCase();
  const payload = reference.slice(commaIndex + 1);
  if (!metadata.startsWith('text/')) {
    return null;
  }

  try {
    const decoded = metadata.includes(';base64')
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8');
    return normalizeEmbeddedImageDataUrl(decoded);
  } catch {
    return null;
  }
}

function isEmptyAvatarReference(reference: string): boolean {
  const normalized = stripQueryAndFragment(reference).replace(/\/+$/, '').toLowerCase();
  return normalized === '/content'
    || normalized === '/metafile-indexer/content'
    || normalized === '/metafile-indexer/thumbnail'
    || normalized === '/metafile-indexer/api/v1/files/content'
    || normalized === '/metafile-indexer/api/v1/files/accelerate/content'
    || normalized === '/metafile-indexer/api/v1/users/avatar/accelerate';
}

async function responseToDataUrl(response: Response): Promise<string | null> {
  if (!response.ok) {
    return null;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) {
    return null;
  }

  const embeddedDataUrl = normalizeEmbeddedImageDataUrl(buffer);
  if (embeddedDataUrl) {
    return embeddedDataUrl;
  }

  const mime = (response.headers.get('content-type') || 'application/octet-stream')
    .split(';')[0]
    .trim();
  if (isJsonMime(mime) || isTextMime(mime)) {
    return null;
  }

  return `data:${mime};base64,${buffer.toString('base64')}`;
}

export function clearResolvedPinAssetCache(): void {
  resolvedPinAssetCache.clear();
}

export function extractPinIdFromReference(reference: string | null | undefined): string | null {
  const normalized = normalizeReference(reference);
  if (!normalized || normalized.startsWith('data:')) {
    return null;
  }

  if (normalized.toLowerCase().startsWith('metafile://')) {
    const pinId = stripQueryAndFragment(normalized.slice('metafile://'.length).trim());
    return pinId || null;
  }

  for (const pattern of PIN_CONTENT_PATTERNS) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      return decodeURIComponent(match[1]);
    }
  }

  if (/^https?:\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized);
      for (const pattern of PIN_CONTENT_PATTERNS) {
        const match = url.pathname.match(pattern);
        if (match?.[1]) {
          return decodeURIComponent(match[1]);
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  const bare = stripQueryAndFragment(normalized);
  if (!bare.includes('/') && !bare.includes(':')) {
    return bare;
  }

  return null;
}

export function resolveMetaidAvatarReference(data: Record<string, unknown> | null | undefined): string | null {
  if (!data) {
    return null;
  }

  const fields = [
    data.avatar,
    data.avatarUrl,
    data.avatarId,
    data.avatarPinId,
    data.avatarImage,
    data.avatarUri,
    data.avatar_uri,
    data.contentId,
  ];
  for (const field of fields) {
    const reference = normalizeReference(typeof field === 'string' ? field : null);
    if (reference && !isEmptyAvatarReference(reference)) {
      return reference;
    }
  }

  return null;
}

async function fetchPinAssetSource(pinId: string): Promise<string | null> {
  const encodedPinId = encodeURIComponent(pinId);
  const fetchers = [
    () => fetchContentWithFallback(pinId, `${METAID_CONTENT_BASE}/${encodedPinId}`),
    () => fetch(`${METAID_USER_AVATAR_ACCELERATE_BASE}/${encodedPinId}?process=thumbnail`),
    () => fetch(`${METAID_FILE_ACCELERATE_CONTENT_BASE}/${encodedPinId}?process=thumbnail`),
    () => fetch(`${METAID_FILE_CONTENT_BASE}/${encodedPinId}`),
  ];

  for (const fetcher of fetchers) {
    try {
      const result = await responseToDataUrl(await fetcher());
      if (result) {
        return result;
      }
    } catch {
      // Try the next known MetaID content endpoint.
    }
  }

  return null;
}

async function resolvePinAssetSourceUncached(reference: string): Promise<string | null> {
  if (reference.startsWith('data:')) {
    return normalizeDataUrlReference(reference);
  }

  if (/^https?:\/\//i.test(reference) && !extractPinIdFromReference(reference)) {
    return reference;
  }

  const pinId = extractPinIdFromReference(reference);
  if (!pinId) {
    return null;
  }

  return fetchPinAssetSource(pinId);
}

export async function resolvePinAssetSource(reference: string | null | undefined): Promise<string | null> {
  const normalized = normalizeReference(reference);
  if (!normalized) {
    return null;
  }

  const cached = resolvedPinAssetCache.get(normalized);
  if (cached) {
    return cached;
  }

  const pending = resolvePinAssetSourceUncached(normalized)
    .then((result) => {
      if (!result) {
        resolvedPinAssetCache.delete(normalized);
      }
      return result;
    })
    .catch((error) => {
      resolvedPinAssetCache.delete(normalized);
      console.warn('[pin-asset] resolve failed', normalized, error instanceof Error ? error.message : String(error));
      return null;
    });

  resolvedPinAssetCache.set(normalized, pending);
  return pending;
}

export async function resolveMetaidAvatarSource(data: Record<string, unknown> | null | undefined): Promise<string | null> {
  return resolvePinAssetSource(resolveMetaidAvatarReference(data));
}
