import { getConfiguredP2PLocalBase } from './p2pLocalEndpoint';
import { selectProtocolPinContent } from './protocolPinContent';

export interface ProtocolPinRecord {
  pinId: string;
  content: unknown;
  timestampMs?: number | null;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FetchProtocolPinsOptions {
  pageSize?: number;
  maxPages?: number;
  /**
   * Per-page fetch timeout. Defaults to DEFAULT_TIMEOUT_MS. Callers may pass
   * a tighter budget, but a per-page threshold below real-world cold-start
   * latency (~2.1-2.2s on proxied/TUN paths, measured 2026-10-22 against the
   * same endpoint family) aborts every cold page into a whole-walk
   * fetch-error, so the default deliberately keeps multiple seconds of
   * headroom.
   */
  timeoutMs?: number;
  localBaseUrl?: string;
  remoteBaseUrl?: string;
  fetchImpl?: FetchLike;
  selectContent?: (item: Record<string, unknown>) => unknown;
  /**
   * Invoked when a page walk ends short of the empty cursor page:
   *  - reason 'max-pages': the walk stopped at `maxPages` with a live cursor
   *    (the indexer caps each page by response bytes, so giant payloads can
   *    shrink a page to a handful of rows);
   *  - reason 'fetch-error': a page fetch failed mid-walk (timeout, non-2xx,
   *    transport error) — the rows fetched so far are a partial prefix.
   * Callers that must reach the empty page (metaTask sweeps) need to know the
   * walk fell short instead of silently losing deep events.
   */
  onTruncated?: (info: {
    baseUrl: string;
    protocolPath: string;
    pages: number;
    rows: number;
    reason: 'max-pages' | 'fetch-error';
  }) => void;
}

interface ProtocolPinRecordWithOrder extends ProtocolPinRecord {
  sourceOrder: number;
}

const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_MAX_PAGES = 10;
// 2026-10-24: the previous 2s default aborted every cold page fetch on
// proxied/TUN paths (dual-machine measurement: cold pages 2.06-2.18s vs warm
// 0.4s on the same endpoint), turning one slow page into a whole-walk
// fetch-error (rows:0) for any user whose RTT crosses the threshold — a
// 100% false-failure rate for those users, plus a full-walk retry on top.
// 10s keeps a 10-page worst-case walk bounded (~100s) while leaving ~4x
// headroom over the observed worst cold page, matching the JSON-fetch budget
// other indexer calls in this codebase already use (8-15s). Exported for the
// default-value regression test.
export const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_REMOTE_BASE_URL = 'https://manapi.metaid.io';

const normalizeBaseUrl = (value: string): string => String(value || '').replace(/\/+$/, '');

const normalizeTimestampMs = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed >= 10_000_000_000 ? Math.floor(parsed) : Math.floor(parsed * 1000);
};

// Select the decoded pin body, skipping MAN content-download URLs so they never
// poison downstream parsing. See protocolPinContent.ts for the full rationale.
const defaultSelectContent = (item: Record<string, unknown>): unknown => (
  selectProtocolPinContent(item)
);

const buildPathListUrl = (
  baseUrl: string,
  pathname: string,
  protocolPath: string,
  pageSize: number,
  cursor?: string
): string => {
  const url = new URL(pathname, `${normalizeBaseUrl(baseUrl)}/`);
  url.searchParams.set('path', protocolPath);
  url.searchParams.set('size', String(pageSize));
  if (cursor) {
    url.searchParams.set('cursor', cursor);
  }
  return url.toString();
};

async function fetchJson(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<unknown> {
  const init: RequestInit = {};
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    init.signal = AbortSignal.timeout(timeoutMs);
  }
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    return null;
  }
  return response.json();
}

async function fetchProtocolPinPages(input: {
  baseUrl: string;
  pathname: string;
  protocolPath: string;
  pageSize: number;
  maxPages: number;
  timeoutMs: number;
  fetchImpl: FetchLike;
  selectContent: (item: Record<string, unknown>) => unknown;
  requireEnvelopeHit: boolean;
  sourceOrderStart: number;
}): Promise<{ pins: ProtocolPinRecordWithOrder[]; hasMore: boolean; failed: boolean }> {
  const pins: ProtocolPinRecordWithOrder[] = [];
  let cursor: string | undefined;
  let sourceOrder = input.sourceOrderStart;
  let stoppedAtMaxPages = false;
  let failed = false;

  for (let page = 0; page < input.maxPages; page += 1) {
    const url = buildPathListUrl(
      input.baseUrl,
      input.pathname,
      input.protocolPath,
      input.pageSize,
      cursor
    );

    let payload: unknown;
    try {
      payload = await fetchJson(input.fetchImpl, url, input.timeoutMs);
    } catch {
      // A mid-walk transport failure is NOT completion: the walk aborts with
      // a partial prefix and the caller must be able to tell (2026-10-13:
      // one slow page silently zeroed an entire pool for the refresher).
      failed = true;
      break;
    }
    if (!payload || typeof payload !== 'object') {
      failed = true;
      break;
    }

    if (
      input.requireEnvelopeHit
      && (payload as { code?: unknown }).code !== 1
    ) {
      break;
    }

    const data = (payload as { data?: unknown }).data;
    if (!data || typeof data !== 'object') {
      break;
    }

    const list = (data as { list?: unknown }).list;
    if (!Array.isArray(list)) {
      break;
    }

    for (const rawItem of list) {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
        continue;
      }
      const item = rawItem as Record<string, unknown>;
      const pinId = typeof item.id === 'string' ? item.id.trim() : String(item.id || '').trim();
      if (!pinId) {
        continue;
      }
      pins.push({
        pinId,
        content: input.selectContent(item),
        timestampMs: normalizeTimestampMs(item.timestamp),
        sourceOrder,
      });
      sourceOrder += 1;
    }

    const nextCursor = (data as { nextCursor?: unknown }).nextCursor;
    cursor = typeof nextCursor === 'string' && nextCursor.trim() ? nextCursor : undefined;
    if (!cursor) {
      break;
    }
    if (page + 1 >= input.maxPages) {
      // Stop only via the natural loop bound; remember that the cursor was
      // still live so the caller can tell truncation from completion.
      stoppedAtMaxPages = true;
    }
  }

  return { pins, hasMore: stoppedAtMaxPages && Boolean(cursor), failed };
}

export async function fetchProtocolPinsFromIndexer(
  protocolPath: string,
  options: FetchProtocolPinsOptions = {}
): Promise<ProtocolPinRecord[]> {
  const normalizedProtocolPath = String(protocolPath || '').trim();
  if (!normalizedProtocolPath) {
    return [];
  }

  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const selectContent = options.selectContent ?? defaultSelectContent;

  const localBase = options.localBaseUrl ?? getConfiguredP2PLocalBase();
  const walkSeen = (baseUrl: string, walk: { hasMore: boolean; failed: boolean; pins: ProtocolPinRecordWithOrder[] }) => {
    if (!walk.hasMore && !walk.failed) return;
    const info = {
      baseUrl,
      protocolPath: normalizedProtocolPath,
      pages: maxPages,
      rows: walk.pins.length,
      reason: (walk.failed ? 'fetch-error' : 'max-pages') as 'fetch-error' | 'max-pages',
    };
    console.warn('[protocolPinFetch] page walk ended short of the empty page:', info);
    options.onTruncated?.(info);
  };
  const localWalk = localBase
    ? await fetchProtocolPinPages({
        baseUrl: localBase,
        pathname: '/api/pin/path/list',
        protocolPath: normalizedProtocolPath,
        pageSize,
        maxPages,
        timeoutMs,
        fetchImpl,
        selectContent,
        requireEnvelopeHit: true,
        sourceOrderStart: 0,
      })
    : { pins: [], hasMore: false, failed: false };
  const remoteWalk = await fetchProtocolPinPages({
    baseUrl: options.remoteBaseUrl ?? DEFAULT_REMOTE_BASE_URL,
    pathname: '/pin/path/list',
    protocolPath: normalizedProtocolPath,
    pageSize,
    maxPages,
    timeoutMs,
    fetchImpl,
    selectContent,
    requireEnvelopeHit: false,
    sourceOrderStart: 1_000_000,
  });
  const localPins = localWalk.pins;
  const remotePins = remoteWalk.pins;
  walkSeen(localBase ?? '', localWalk);
  walkSeen(options.remoteBaseUrl ?? DEFAULT_REMOTE_BASE_URL, remoteWalk);

  const mergedByPinId = new Map<string, ProtocolPinRecordWithOrder>();
  for (const pin of [...localPins, ...remotePins]) {
    if (!mergedByPinId.has(pin.pinId)) {
      mergedByPinId.set(pin.pinId, pin);
    }
  }

  return Array.from(mergedByPinId.values())
    .sort((left, right) => {
      const timeDelta = (right.timestampMs ?? 0) - (left.timestampMs ?? 0);
      if (timeDelta !== 0) return timeDelta;
      return left.sourceOrder - right.sourceOrder;
    })
    .map((pin) => ({
      pinId: pin.pinId,
      content: pin.content,
      timestampMs: pin.timestampMs,
    }));
}
