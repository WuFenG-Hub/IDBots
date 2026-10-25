/**
 * Local file URLs (REQ-E-7).
 *
 * Desktop keeps `file://`: `buildLocalFileUrl` /
 * `buildLocalFileDirBaseHref` reproduce, byte for byte, what the renderer
 * components used to construct inline (see MarkdownContent.toFileHref and
 * MarkdownViewerPanel.injectHtmlBaseHref before the REQ-E-7 refactor), and
 * `resolveLocalFileUrl` returns those same strings synchronously-resolved on
 * desktop, so desktop behavior does not change.
 *
 * Mobile has no local disk: `resolveLocalFileUrl` asks the gateway for a
 * signed download URL (`gateway:file:sign`, C2 File Download) and caches it
 * keyed by `path + disposition`, refreshing one minute before `expiresAt`.
 * A `{ success: false }` result or a rejected invoke throws an `Error` that
 * `useLocalFileUrl` surfaces. Signed URLs are `/files/{token}` relative to
 * the control-plane origin and are returned as-is; the shell joins the
 * origin when opening.
 */

export type LocalFileUrlDisposition = 'inline' | 'attachment';

/**
 * Tenant route prefix the gateway's `gateway:file:sign` puts on signed URLs
 * (src/main/gateway/fileSign.ts FILE_ROUTE_PATH_PREFIX). Browsers never reach
 * it: the control plane exposes the same download at `/files/{token}` with
 * cookie auth (cloud/control-plane/src/services/httpProxy.ts), and the dev
 * proxy rewrites `/files/…` to it (vite.mobile.config.ts REQ-E-9).
 */
const TENANT_FILES_ROUTE_PREFIX = '/gateway/v1/files/';

/** Browser route (same origin) for signed file downloads. */
const BROWSER_FILES_ROUTE_PREFIX = '/files/';

/**
 * Normalize a signed URL from `gateway:file:sign` into the form a browser can
 * actually fetch: the tenant-scoped route prefix is rewritten to the
 * same-origin `/files/{token}` route; absolute http(s) URLs pass through
 * unchanged. Without this rewrite the PWA would open `/gateway/v1/files/…`
 * on the control-plane origin, which has no such route (404) — F-11.
 */
export function toBrowserFileUrl(signedUrl: string): string {
  if (signedUrl.startsWith(TENANT_FILES_ROUTE_PREFIX)) {
    return BROWSER_FILES_ROUTE_PREFIX + signedUrl.slice(TENANT_FILES_ROUTE_PREFIX.length);
  }
  return signedUrl;
}

export interface ResolveLocalFileUrlOptions {
  disposition?: LocalFileUrlDisposition;
}

/** Signed URLs refresh this long before the token expires. */
export const LOCAL_FILE_URL_REFRESH_LEEWAY_MS = 60_000;

/**
 * Sync desktop-only URL builder. Reproduces the former component-local
 * `toFileHref` helpers exactly (MarkdownContent's three branches collapsed to
 * the same tail string; InlineHtmlReportBlock's ternary is the same rule):
 * Windows drive paths get a `file:///` prefix, everything else `file://`,
 * backslashes normalized to forward slashes first. On mobile it still builds
 * the desktop string — mobile callers route through `resolveLocalFileUrl` /
 * `useLocalFileUrl` instead.
 */
export function buildLocalFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(filePath)) {
    return `file:///${normalized}`;
  }
  if (normalized.startsWith('/')) {
    return `file://${normalized}`;
  }
  return `file://${normalized}`;
}

/**
 * Sync desktop-only directory-base builder: the dir-based `<base href>`
 * form MarkdownViewerPanel injects into exported HTML reports
 * (`file://` + optional `/` for drive letters + `encodeURI(dir)` + trailing
 * slash).
 */
export function buildLocalFileDirBaseHref(dirPath: string): string {
  const normalized = dirPath.replace(/\\/g, '/');
  return `file://${/^[A-Za-z]:/.test(normalized) ? '/' : ''}${encodeURI(normalized)}/`;
}

/** True in the WS-E mobile shell, where `window.idbotsMobile` is installed. */
export function isMobileBridgeRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window as { idbotsMobile?: { isMobile?: boolean } }).idbotsMobile?.isMobile === true
  );
}

type FileSignResult =
  | { url: string; expiresAt: number; size: number; mime: string }
  | { success: false; error: string; code?: string; retryable?: boolean };

interface SignedUrlEntry {
  url: string;
  expiresAt: number;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  listeners: Set<(url: string) => void>;
}

const signedUrlCache = new Map<string, SignedUrlEntry>();

const cacheKey = (path: string, disposition?: LocalFileUrlDisposition): string =>
  JSON.stringify([path, disposition ?? '']);

/** Drop every cached URL and pending refresh (tests). */
export function clearLocalFileUrlCache(): void {
  for (const entry of signedUrlCache.values()) {
    if (entry.refreshTimer) clearTimeout(entry.refreshTimer);
  }
  signedUrlCache.clear();
}

async function signWithGateway(
  path: string,
  disposition?: LocalFileUrlDisposition,
): Promise<FileSignResult> {
  const electron = (window as { electron?: { gateway?: { fileSign?: unknown } } }).electron;
  const fileSign = electron?.gateway?.fileSign;
  if (typeof fileSign !== 'function') {
    throw new Error('gateway fileSign is not available in this runtime');
  }
  return (fileSign as (input: { path: string; disposition?: LocalFileUrlDisposition }) => Promise<FileSignResult>)(
    { path, disposition },
  );
}

function toError(raw: unknown, path: string): Error {
  if (raw instanceof Error) return raw;
  const result = raw as { error?: string } | null | undefined;
  return new Error(result?.error || `gateway fileSign failed for ${path}`);
}

async function signAndCache(
  path: string,
  disposition: LocalFileUrlDisposition | undefined,
  key: string,
): Promise<string> {
  let result: FileSignResult;
  try {
    result = await signWithGateway(path, disposition);
  } catch (error) {
    throw toError(error, path);
  }
  if (!result || typeof (result as { url?: unknown }).url !== 'string') {
    throw toError(result, path);
  }
  const signed = result as { url: string; expiresAt: number };
  const expiresAt = typeof signed.expiresAt === 'number' ? signed.expiresAt : 0;

  const existing = signedUrlCache.get(key);
  if (existing?.refreshTimer) clearTimeout(existing.refreshTimer);
  const entry: SignedUrlEntry = {
    url: toBrowserFileUrl(signed.url),
    expiresAt,
    refreshTimer: null,
    listeners: existing?.listeners ?? new Set(),
  };
  entry.refreshTimer = scheduleRefresh(path, disposition, key, entry);
  signedUrlCache.set(key, entry);
  // Background-refresh subscribers get the rotated token; first-callers get
  // the URL through the return value.
  entry.listeners.forEach((listener) => listener(entry.url));
  return entry.url;
}

function scheduleRefresh(
  path: string,
  disposition: LocalFileUrlDisposition | undefined,
  key: string,
  entry: SignedUrlEntry,
): ReturnType<typeof setTimeout> | null {
  // No/invalid expiry: never a cache hit, so every resolve re-signs — do not
  // schedule a refresh (delay 0 would restart-sign in a tight loop).
  if (!entry.expiresAt) return null;
  const delay = Math.max(entry.expiresAt - LOCAL_FILE_URL_REFRESH_LEEWAY_MS - Date.now(), 0);
  const timer = setTimeout(() => {
    entry.refreshTimer = null;
    if (signedUrlCache.get(key) !== entry) return;
    signAndCache(path, disposition, key).catch((error: unknown) => {
      // Keep serving the current URL to existing subscribers, but drop the
      // entry so the next resolve re-signs from scratch.
      if (signedUrlCache.get(key) === entry) signedUrlCache.delete(key);
      console.error('[localFileUrl] background refresh failed:', path, error);
    });
  }, delay);
  // Tests run under node:test — never hold the process open on a refresh.
  (timer as unknown as { unref?: () => void }).unref?.();
  return timer;
}

/**
 * Resolve a `/data` path to a usable URL.
 *
 * Desktop: the same `file://` string the components have always built.
 * Mobile: a signed `/files/{token}` URL from `gateway:file:sign`, cached by
 * `path + disposition` and refreshed one minute before expiry; rejects with
 * an Error on `{ success: false }` or an invoke failure.
 */
export async function resolveLocalFileUrl(
  path: string,
  options?: ResolveLocalFileUrlOptions,
): Promise<string> {
  if (!isMobileBridgeRuntime()) {
    return buildLocalFileUrl(path);
  }
  const disposition = options?.disposition;
  const key = cacheKey(path, disposition);
  const cached = signedUrlCache.get(key);
  if (cached && cached.expiresAt - LOCAL_FILE_URL_REFRESH_LEEWAY_MS > Date.now()) {
    return cached.url;
  }
  return signAndCache(path, disposition, key);
}

/**
 * Subscribe to background token rotation for one `path + disposition`
 * (used by `useLocalFileUrl` so long-lived views pick up the refreshed URL).
 * Desktop is a no-op. Returns an unsubscribe function.
 */
export function subscribeLocalFileUrl(
  path: string,
  disposition: LocalFileUrlDisposition | undefined,
  listener: (url: string) => void,
): () => void {
  if (!isMobileBridgeRuntime()) {
    return () => {};
  }
  const key = cacheKey(path, disposition);
  let entry = signedUrlCache.get(key);
  if (!entry) {
    entry = { url: '', expiresAt: 0, refreshTimer: null, listeners: new Set() };
    signedUrlCache.set(key, entry);
  }
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0 && signedUrlCache.get(key) === entry) {
      if (entry.refreshTimer) clearTimeout(entry.refreshTimer);
      signedUrlCache.delete(key);
    }
  };
}
