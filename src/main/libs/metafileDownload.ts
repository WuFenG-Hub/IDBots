/**
 * Unified metafile:// → HTTP download helper.
 *
 * Agents must never invent download URLs. extract_metaapp / install_skill
 * both go through this module so a `metafile://<pinId>` reference always
 * expands to the same accelerate + indexer content candidates.
 */

import { fetchContentWithFallback } from '../services/localIndexerProxy';
import {
  buildMetaAppZipCandidateUrls,
  looksLikeZipArchive,
} from './metaAppZipDownload';

const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50; // PK\x03\x04
const MAX_REDIRECTS = 5;

export type DownloadedBytes = {
  buffer: Buffer;
  contentType: string;
  url: string;
};

export type DownloadBytesOptions = {
  fetchImpl?: typeof fetch;
  /** When true, a local P2P hit that is not a ZIP is treated as a miss. */
  requireZip?: boolean;
  /**
   * Hard byte cap for callers that only want bounded payloads (hashing,
   * sniffing). Enforced twice: a Content-Length pre-check aborts before any
   * body byte is read, and the streamed read cancels the body the moment the
   * cap is exceeded — a server that lies about (or omits) Content-Length
   * cannot make the caller buffer a multi-hundred-MB body.
   */
  maxBytes?: number;
};

/** Strip `metafile://` and an optional file-extension suffix; return the pin id. */
export function extractMetafilePinId(uri: string): string | null {
  const trimmed = String(uri || '').trim();
  const raw = /^metafile:\/\//iu.test(trimmed)
    ? trimmed.slice('metafile://'.length).trim()
    : trimmed;
  if (!raw) return null;
  const withoutQuery = raw.split('?')[0].split('#')[0].trim();
  const pinMatch = withoutQuery.match(/[A-Fa-f0-9]{64}i\d+/);
  if (pinMatch?.[0]) return pinMatch[0];
  const stripped = withoutQuery.replace(/\.[A-Za-z0-9]{1,16}$/u, '');
  if (!stripped || stripped.includes('/') || stripped.includes('\\')) return null;
  return stripped;
}

/**
 * ZIP detection for skill/MetaApp packages. Do NOT use a `.zip` suffix:
 * some on-chain content refs (e.g. HyperFrames) have no extension while
 * others (Remotion) do, but both advertise `contentType=application/zip`
 * and/or start with the PK magic.
 */
export function isZipPayload(buffer: Buffer, contentType?: string | null): boolean {
  if (!buffer || buffer.length < 2) return false;
  const type = String(contentType || '').toLowerCase();
  const typeSaysZip = type.includes('zip');
  const pkMagic = buffer.length >= 4
    ? buffer.readUInt32LE(0) === ZIP_LOCAL_FILE_HEADER_SIGNATURE
    : buffer[0] === 0x50 && buffer[1] === 0x4b;
  return typeSaysZip || pkMagic;
}

async function followRedirects(
  fetchImpl: typeof fetch,
  url: string,
): Promise<Response> {
  let currentUrl = url;
  for (let redirectCount = 0; ; redirectCount += 1) {
    const response = await fetchImpl(currentUrl, { redirect: 'follow' });
    if (response.status < 300 || response.status >= 400) {
      return response;
    }
    if (redirectCount >= MAX_REDIRECTS) {
      throw new Error(`Download exceeded ${MAX_REDIRECTS} redirects.`);
    }
    const location = response.headers.get('location');
    if (!location) {
      throw new Error(`Download redirect (HTTP ${response.status}) is missing a Location header.`);
    }
    currentUrl = new URL(location, currentUrl).toString();
  }
}

/**
 * Read a response body with an optional hard byte cap: Content-Length is
 * checked first (abort before reading), then the stream is cancelled the
 * instant the cap is exceeded. Without a cap this is equivalent to
 * response.arrayBuffer().
 */
async function readBodyCapped(response: Response, maxBytes?: number): Promise<Buffer> {
  if (maxBytes == null || !Number.isFinite(maxBytes) || maxBytes <= 0) {
    return Buffer.from(await response.arrayBuffer());
  }
  const contentLength = Number(response.headers.get('content-length') || '');
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    try { await response.body?.cancel(); } catch { /* best-effort cancel */ }
    throw new Error(`Download aborted: content-length ${contentLength} exceeds the ${maxBytes}-byte cap.`);
  }
  const body = response.body;
  if (!body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new Error(`Download aborted: body of ${buffer.length} bytes exceeds the ${maxBytes}-byte cap.`);
    }
    return buffer;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* best-effort cancel */ }
        throw new Error(`Download aborted: body exceeded the ${maxBytes}-byte cap.`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

/**
 * Download a metafile pin (or a plain http(s) URL) and return the raw bytes.
 * For metafile:// refs this always uses the accelerate + indexer content
 * endpoints — never `man.metaid.io/content/<pinId>` (that returns a JSON
 * chunk manifest, not the file).
 */
export async function downloadMetafileBytes(
  pinIdOrUri: string,
  options?: DownloadBytesOptions,
): Promise<DownloadedBytes> {
  const trimmed = String(pinIdOrUri || '').trim();
  if (!trimmed) {
    throw new Error('Empty download reference.');
  }

  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required to download metafiles.');
  }

  if (/^https?:\/\//iu.test(trimmed)) {
    const response = await followRedirects(fetchImpl, trimmed);
    if (!response.ok) {
      throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`.trim());
    }
    const buffer = await readBodyCapped(response, options?.maxBytes);
    return {
      buffer,
      contentType: response.headers.get('content-type') || '',
      url: trimmed,
    };
  }

  const pinId = extractMetafilePinId(trimmed);
  if (!pinId) {
    throw new Error(`Invalid metafile reference: ${trimmed}`);
  }

  const candidates = buildMetaAppZipCandidateUrls(pinId);
  let lastError = '';
  for (const candidate of candidates) {
    try {
      const response = await fetchContentWithFallback(
        candidate.pinId,
        candidate.url,
        { redirect: 'follow' },
        options?.requireZip ? looksLikeZipArchive : undefined,
      );
      if (!response.ok) {
        lastError = `HTTP ${response.status} ${response.statusText}`.trim();
        continue;
      }
      let buffer: Buffer;
      try {
        buffer = await readBodyCapped(response, options?.maxBytes);
      } catch (error) {
        // A cap abort is a miss for THIS candidate — keep trying the next
        // content source (which may serve the same bytes with a honest
        // Content-Length or not at all).
        lastError = error instanceof Error ? error.message : String(error);
        continue;
      }
      if (buffer.length === 0) {
        lastError = 'empty response body';
        continue;
      }
      return {
        buffer,
        contentType: response.headers.get('content-type') || '',
        url: candidate.url,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`Metafile download failed for ${pinId}: ${lastError || 'no usable content URL'}`);
}
