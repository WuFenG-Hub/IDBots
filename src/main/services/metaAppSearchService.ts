/**
 * Thin client for the metaso-p2p MetaApp aggregation API
 * (docs/metaapp-api-downstream-guide.md): GET /api/metaapp/list and
 * GET /api/metaapp/forks/:pinId. Keeps hosts decoupled from the envelope
 * shape ({code, data, message}, HTTP always 200) and item normalization.
 */

export const DEFAULT_METAAPP_SEARCH_BASE_URL = 'https://so.metaid.io';
const DEFAULT_TIMEOUT_MS = 10_000;

export type MetaAppSearchItem = {
  pinId: string;
  sourcePinId: string;
  chainName: string;
  title: string;
  appName: string;
  intro: string;
  /** MetaApp icon reference (aggregation API; not in the written contract but present in production). */
  icon: string;
  /** MetaApp cover image reference (aggregation API; not in the written contract but present in production). */
  coverImg: string;
  tags: string[];
  runtime: string;
  version: string;
  content: string;
  indexFile: string;
  forkedFrom: string;
  disabled: boolean;
  publisherGlobalMetaId: string;
  publisherMetaId: string;
  publisherAddress: string;
  /** Publisher display name (aggregation API; not in the written contract but present in production). */
  publisherName: string;
  /** Publisher avatar pin id (metafile reference), when indexed. */
  publisherAvatarId: string;
  createdAt: number;
  updatedAt: number;
};

export type MetaAppSearchPage = {
  items: MetaAppSearchItem[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type MetaAppSearchParams = {
  keyword?: string;
  tag?: string;
  chainName?: string;
  runtime?: string;
  publisher?: string;
  since?: number;
  until?: number;
  includeDisabled?: boolean;
  size?: number;
  cursor?: string;
};

export class MetaAppSearchNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetaAppSearchNotFoundError';
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter(Boolean);
}

function normalizeItem(raw: unknown): MetaAppSearchItem {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    pinId: text(record.pinId),
    sourcePinId: text(record.sourcePinId),
    chainName: text(record.chainName),
    title: text(record.title),
    appName: text(record.appName),
    intro: text(record.intro),
    icon: text(record.icon),
    coverImg: text(record.coverImg),
    tags: textList(record.tags),
    runtime: text(record.runtime),
    version: text(record.version),
    content: text(record.content),
    indexFile: text(record.indexFile) || 'index.html',
    forkedFrom: text(record.forkedFrom),
    disabled: record.disabled === true || record.disabled === 'true',
    publisherGlobalMetaId: text(record.publisherGlobalMetaId),
    publisherMetaId: text(record.publisherMetaId),
    publisherAddress: text(record.publisherAddress),
    publisherName: text(record.publisherName),
    publisherAvatarId: text(record.publisherAvatarId),
    createdAt: Number(record.createdAt) || 0,
    updatedAt: Number(record.updatedAt) || 0,
  };
}

function normalizePage(raw: unknown): MetaAppSearchPage {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const items = Array.isArray(record.items) ? record.items.map(normalizeItem) : [];
  return {
    items,
    nextCursor: text(record.nextCursor) || null,
    hasMore: record.hasMore === true,
  };
}

async function fetchApiData(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      throw new Error(`MetaApp search API returned an invalid response (HTTP ${response.status}).`);
    }
    const code = Number(body.code);
    if (code === 0) {
      return (body.data && typeof body.data === 'object' ? body.data : {}) as Record<string, unknown>;
    }
    const message = text(body.message) || 'unknown error';
    if (code === 40400) {
      throw new MetaAppSearchNotFoundError(message);
    }
    throw new Error(`MetaApp search API error ${code}: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

export type MetaAppSearchServiceOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

function resolveOptions(options: MetaAppSearchServiceOptions | undefined): Required<MetaAppSearchServiceOptions> {
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required for MetaApp search.');
  }
  return {
    baseUrl: (options?.baseUrl ?? DEFAULT_METAAPP_SEARCH_BASE_URL).replace(/\/+$/, ''),
    fetchImpl,
    timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

/** GET /api/metaapp/list — global feed & intent search. */
export async function searchMetaApps(
  params: MetaAppSearchParams,
  options?: MetaAppSearchServiceOptions,
): Promise<MetaAppSearchPage> {
  const { baseUrl, fetchImpl, timeoutMs } = resolveOptions(options);
  const query = new URLSearchParams();
  if (params.keyword?.trim()) query.set('keyword', params.keyword.trim());
  if (params.tag?.trim()) query.set('tag', params.tag.trim());
  if (params.chainName?.trim()) query.set('chainName', params.chainName.trim());
  if (params.runtime?.trim()) query.set('runtime', params.runtime.trim());
  if (params.publisher?.trim()) query.set('publisher', params.publisher.trim());
  if (typeof params.since === 'number' && params.since > 0) query.set('since', String(Math.floor(params.since)));
  if (typeof params.until === 'number' && params.until > 0) query.set('until', String(Math.floor(params.until)));
  if (params.includeDisabled) query.set('includeDisabled', '1');
  if (typeof params.size === 'number' && params.size > 0) query.set('size', String(Math.min(100, Math.floor(params.size))));
  if (params.cursor?.trim()) query.set('cursor', params.cursor.trim());
  const qs = query.toString();
  const data = await fetchApiData(`${baseUrl}/api/metaapp/list${qs ? `?${qs}` : ''}`, fetchImpl, timeoutMs);
  return normalizePage(data);
}

/** GET /api/metaapp/forks/:pinId — direct remix children of an app. */
export async function listMetaAppForks(
  input: { pinId: string; size?: number; cursor?: string },
  options?: MetaAppSearchServiceOptions,
): Promise<MetaAppSearchPage> {
  const { baseUrl, fetchImpl, timeoutMs } = resolveOptions(options);
  const pinId = input.pinId.trim().toLowerCase();
  if (!pinId) throw new Error('pinId is required to list MetaApp forks.');
  const query = new URLSearchParams();
  if (typeof input.size === 'number' && input.size > 0) query.set('size', String(Math.min(100, Math.floor(input.size))));
  if (input.cursor?.trim()) query.set('cursor', input.cursor.trim());
  const qs = query.toString();
  const data = await fetchApiData(`${baseUrl}/api/metaapp/forks/${encodeURIComponent(pinId)}${qs ? `?${qs}` : ''}`, fetchImpl, timeoutMs);
  return normalizePage(data);
}
