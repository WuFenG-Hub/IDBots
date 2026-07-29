/**
 * Thin client for the metaso-p2p MetaID aggregated search API
 * (docs/specs/2026-07-28-metaid-search-api.md): GET /api/metaid/list and
 * GET /api/metaid/detail/:identity. Same conventions as the MetaApp
 * aggregation API: {code, data, message} envelope, HTTP always 200,
 * business error codes 40000/40400/50000.
 *
 * "MetaID" here means an on-chain identity (bot or user); hosts should use
 * `globalMetaId` to open bot pages (metaid://<globalMetaId>), never the
 * legacy `metaId` string.
 */

export const DEFAULT_METAID_SEARCH_BASE_URL = 'https://so.metaid.io';
const DEFAULT_TIMEOUT_MS = 10_000;

export type MetaIdSearchItem = {
  globalMetaId: string;
  /** Legacy MetaID string — kept for reference only; do not build URIs from it. */
  metaId: string;
  address: string;
  chainName: string;
  name: string;
  /** Avatar pin id (metafile reference), when indexed. */
  avatarId: string;
  bio: string;
  chatSkills: string[];
  hasChatPubkey: boolean;
  hasHomepage: boolean;
  createdAt: number;
  updatedAt: number;
};

export type MetaIdLlmInfo = {
  provider: string;
  model: string;
  name: string;
};

export type MetaIdDetail = MetaIdSearchItem & {
  avatarContentType: string;
  role: string;
  soul: string;
  goal: string;
  /** Raw /info/persona JSON (null when unset or invalid JSON on-chain). */
  persona: unknown;
  llm: MetaIdLlmInfo | null;
  /** Raw /info/homepage JSON (null when unset or invalid JSON on-chain). */
  homepage: unknown;
  background: string;
  chatPubkey: string;
  /** Current version pinId of each /info field. */
  fieldPins: Record<string, string>;
};

export type MetaIdSearchPage = {
  items: MetaIdSearchItem[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type MetaIdSearchParams = {
  keyword?: string;
  skill?: string;
  chainName?: string;
  hasChatPubkey?: boolean;
  hasHomepage?: boolean;
  since?: number;
  until?: number;
  size?: number;
  cursor?: string;
};

export class MetaIdSearchNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetaIdSearchNotFoundError';
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter(Boolean);
}

function normalizeItem(raw: unknown): MetaIdSearchItem {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    globalMetaId: text(record.globalMetaId),
    metaId: text(record.metaId),
    address: text(record.address),
    chainName: text(record.chainName),
    name: text(record.name),
    avatarId: text(record.avatarId),
    bio: text(record.bio),
    chatSkills: textList(record.chatSkills),
    hasChatPubkey: record.hasChatPubkey === true,
    hasHomepage: record.hasHomepage === true,
    createdAt: Number(record.createdAt) || 0,
    updatedAt: Number(record.updatedAt) || 0,
  };
}

function normalizeLlm(raw: unknown): MetaIdLlmInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const llm = {
    provider: text(record.provider),
    model: text(record.model),
    name: text(record.name),
  };
  return llm.provider || llm.model || llm.name ? llm : null;
}

function normalizeFieldPins(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const pins: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const pin = text(value);
    if (key.trim() && pin) pins[key] = pin;
  }
  return pins;
}

function normalizeDetail(raw: unknown): MetaIdDetail {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    ...normalizeItem(record),
    avatarContentType: text(record.avatarContentType),
    role: text(record.role),
    soul: text(record.soul),
    goal: text(record.goal),
    persona: record.persona && typeof record.persona === 'object' ? record.persona : null,
    llm: normalizeLlm(record.llm),
    homepage: record.homepage && typeof record.homepage === 'object' ? record.homepage : null,
    background: text(record.background),
    chatPubkey: text(record.chatPubkey),
    fieldPins: normalizeFieldPins(record.fieldPins),
  };
}

function normalizePage(raw: unknown): MetaIdSearchPage {
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
      throw new Error(`MetaID search API returned an invalid response (HTTP ${response.status}).`);
    }
    const code = Number(body.code);
    if (code === 0) {
      return (body.data && typeof body.data === 'object' ? body.data : {}) as Record<string, unknown>;
    }
    const message = text(body.message) || 'unknown error';
    if (code === 40400) {
      throw new MetaIdSearchNotFoundError(message);
    }
    throw new Error(`MetaID search API error ${code}: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

export type MetaIdSearchServiceOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

function resolveOptions(options: MetaIdSearchServiceOptions | undefined): Required<MetaIdSearchServiceOptions> {
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required for MetaID search.');
  }
  return {
    baseUrl: (options?.baseUrl ?? DEFAULT_METAID_SEARCH_BASE_URL).replace(/\/+$/, ''),
    fetchImpl,
    timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

/** GET /api/metaid/list — global identity feed & intent search. */
export async function searchMetaIds(
  params: MetaIdSearchParams,
  options?: MetaIdSearchServiceOptions,
): Promise<MetaIdSearchPage> {
  const { baseUrl, fetchImpl, timeoutMs } = resolveOptions(options);
  const query = new URLSearchParams();
  if (params.keyword?.trim()) query.set('keyword', params.keyword.trim());
  if (params.skill?.trim()) query.set('skill', params.skill.trim());
  if (params.chainName?.trim()) query.set('chainName', params.chainName.trim());
  if (params.hasChatPubkey) query.set('hasChatPubkey', '1');
  if (params.hasHomepage) query.set('hasHomepage', '1');
  if (typeof params.since === 'number' && params.since > 0) query.set('since', String(Math.floor(params.since)));
  if (typeof params.until === 'number' && params.until > 0) query.set('until', String(Math.floor(params.until)));
  if (typeof params.size === 'number' && params.size > 0) query.set('size', String(Math.min(100, Math.floor(params.size))));
  if (params.cursor?.trim()) query.set('cursor', params.cursor.trim());
  const qs = query.toString();
  const data = await fetchApiData(`${baseUrl}/api/metaid/list${qs ? `?${qs}` : ''}`, fetchImpl, timeoutMs);
  return normalizePage(data);
}

/** GET /api/metaid/detail/:identity — full profile; identity may be a globalMetaId, metaId, or address. */
export async function getMetaIdDetail(
  identity: string,
  options?: MetaIdSearchServiceOptions,
): Promise<MetaIdDetail> {
  const { baseUrl, fetchImpl, timeoutMs } = resolveOptions(options);
  const trimmed = identity.trim();
  if (!trimmed) throw new Error('identity is required to fetch a MetaID profile.');
  const data = await fetchApiData(`${baseUrl}/api/metaid/detail/${encodeURIComponent(trimmed)}`, fetchImpl, timeoutMs);
  return normalizeDetail(data);
}
