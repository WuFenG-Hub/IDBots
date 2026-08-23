/**
 * Thin client for the metaso-p2p bot staffing search API
 * (docs/group-task-bot-search-api.md): POST /api/bots/search.
 *
 * Same envelope as the other aggregation endpoints: HTTP always 200,
 * {code, data, message}. Business codes 1001 / 1002 / 1003.
 */

export const DEFAULT_BOT_SEARCH_BASE_URL = 'https://so.metaid.io';
export const BOT_SEARCH_PATH = '/api/bots/search';
const DEFAULT_TIMEOUT_MS = 10_000;

export const BOT_SEARCH_CODE_OK = 0;
export const BOT_SEARCH_CODE_INVALID = 1001;
export const BOT_SEARCH_CODE_PRESENCE_UNAVAILABLE = 1002;
export const BOT_SEARCH_CODE_INTERNAL = 1003;

export type BotSearchMatchReason = {
  field: string;
  token: string;
  weight: number;
};

export type BotSearchGroupTask = {
  groupId: string;
  title: string;
  goal: string;
  joinedAs: string;
  joinedAt: number;
  joinPinId: string;
  stillMember: boolean;
  messageCount: number;
  kind: string;
};

export type BotSearchCandidate = {
  globalMetaId: string;
  metaId: string;
  name: string;
  avatarId: string;
  bio: string;
  role: string;
  goal: string;
  chatSkills: string[];
  publishedSkills: string[];
  chainName: string;
  hasChatPubkey: boolean;
  hasHomepage: boolean;
  homepage: string;
  isOnline: boolean;
  lastSeenAgoSeconds: number | null;
  groupTaskCount: number;
  recentGroupTasks: BotSearchGroupTask[];
  score: number;
  matchReasons: BotSearchMatchReason[];
};

export type BotSearchPage = {
  candidates: BotSearchCandidate[];
  nextCursor: string | null;
  queriedAt: number;
};

export type BotSearchParams = {
  query?: string;
  roleHint?: string;
  skills?: string[];
  language?: 'zh' | 'en';
  onlineOnly?: boolean;
  hasChatPubkey?: boolean;
  excludeGlobalMetaIds?: string[];
  limit?: number;
  cursor?: string;
};

export class BotSearchError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'BotSearchError';
    this.code = code;
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter(Boolean);
}

function optionalInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeReason(raw: unknown): BotSearchMatchReason | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const field = text(record.field);
  const token = text(record.token);
  const weight = Number(record.weight);
  if (!field || !token || !Number.isFinite(weight)) return null;
  return { field, token, weight };
}

function normalizeGroupTask(raw: unknown): BotSearchGroupTask | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const groupId = text(record.groupId);
  if (!groupId) return null;
  return {
    groupId,
    title: text(record.title),
    goal: text(record.goal),
    joinedAs: text(record.joinedAs) || 'member',
    joinedAt: Number(record.joinedAt) || 0,
    joinPinId: text(record.joinPinId),
    stillMember: record.stillMember === true,
    messageCount: Number(record.messageCount) || 0,
    kind: text(record.kind) || 'group',
  };
}

function normalizeCandidate(raw: unknown): BotSearchCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const globalMetaId = text(record.globalMetaId);
  if (!globalMetaId) return null;
  return {
    globalMetaId,
    metaId: text(record.metaId),
    name: text(record.name),
    avatarId: text(record.avatarId),
    bio: text(record.bio),
    role: text(record.role),
    goal: text(record.goal),
    chatSkills: textList(record.chatSkills),
    publishedSkills: textList(record.publishedSkills),
    chainName: text(record.chainName),
    hasChatPubkey: record.hasChatPubkey === true,
    hasHomepage: record.hasHomepage === true,
    homepage: text(record.homepage),
    isOnline: record.isOnline === true,
    lastSeenAgoSeconds: optionalInt(record.lastSeenAgoSeconds),
    groupTaskCount: Math.max(0, Math.trunc(Number(record.groupTaskCount) || 0)),
    recentGroupTasks: Array.isArray(record.recentGroupTasks)
      ? record.recentGroupTasks.map(normalizeGroupTask).filter((row): row is BotSearchGroupTask => Boolean(row))
      : [],
    score: Number(record.score) || 0,
    matchReasons: Array.isArray(record.matchReasons)
      ? record.matchReasons.map(normalizeReason).filter((row): row is BotSearchMatchReason => Boolean(row))
      : [],
  };
}

function normalizePage(raw: unknown): BotSearchPage {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const candidates = Array.isArray(record.candidates)
    ? record.candidates.map(normalizeCandidate).filter((row): row is BotSearchCandidate => Boolean(row))
    : [];
  return {
    candidates,
    nextCursor: text(record.nextCursor) || null,
    queriedAt: Number(record.queriedAt) || 0,
  };
}

export type BotSearchServiceOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

function resolveOptions(options: BotSearchServiceOptions | undefined): Required<BotSearchServiceOptions> {
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required for bot search.');
  }
  return {
    baseUrl: (options?.baseUrl ?? DEFAULT_BOT_SEARCH_BASE_URL).replace(/\/+$/, ''),
    fetchImpl,
    timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

function buildRequestBody(params: BotSearchParams): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const query = text(params.query);
  if (query) body.query = query;
  const roleHint = text(params.roleHint);
  if (roleHint) body.roleHint = roleHint;
  const skills = (params.skills ?? []).map((item) => text(item)).filter(Boolean);
  if (skills.length) body.skills = skills;
  if (params.language === 'zh' || params.language === 'en') body.language = params.language;
  if (params.onlineOnly !== undefined) body.onlineOnly = params.onlineOnly;
  if (params.hasChatPubkey !== undefined) body.hasChatPubkey = params.hasChatPubkey;
  const exclude = (params.excludeGlobalMetaIds ?? []).map((item) => text(item)).filter(Boolean);
  if (exclude.length) body.excludeGlobalMetaIds = exclude;
  if (typeof params.limit === 'number' && Number.isInteger(params.limit) && params.limit > 0) {
    body.limit = params.limit;
  }
  const cursor = text(params.cursor);
  if (cursor) body.cursor = cursor;
  return body;
}

/** POST /api/bots/search — ranked, online-aware staffing page. */
export async function searchBots(
  params: BotSearchParams,
  options?: BotSearchServiceOptions,
): Promise<BotSearchPage> {
  const { baseUrl, fetchImpl, timeoutMs } = resolveOptions(options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}${BOT_SEARCH_PATH}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(buildRequestBody(params)),
    });
    const envelope = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!envelope || typeof envelope !== 'object') {
      throw new Error(`Bot search API returned an invalid response (HTTP ${response.status}).`);
    }
    const code = Number(envelope.code);
    const message = text(envelope.message) || 'unknown error';
    if (code === BOT_SEARCH_CODE_OK) {
      return normalizePage(envelope.data);
    }
    throw new BotSearchError(
      Number.isInteger(code) ? code : BOT_SEARCH_CODE_INTERNAL,
      message,
    );
  } finally {
    clearTimeout(timer);
  }
}
