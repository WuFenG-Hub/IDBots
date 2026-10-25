/**
 * Thin client for the metaso-p2p MetaApp aggregation API
 * (docs/metaapp-api-downstream-guide.md): GET /api/metaapp/list and
 * GET /api/metaapp/forks/:pinId, plus the open-preference extensions
 * (docs/design/motion-video-preference/metaso-requirements.md):
 * preference sorting/filtering params, motionVideo/preference item
 * projections, and GET /api/preference/comparisons. Keeps hosts decoupled
 * from the envelope shape ({code, data, message}, HTTP always 200) and item
 * normalization. Missing evidence values normalize to null — never 0 or false.
 */

export const DEFAULT_METAAPP_SEARCH_BASE_URL = 'https://so.metaid.io';
const DEFAULT_TIMEOUT_MS = 10_000;

export type MetaAppSearchItem = {
  pinId: string;
  sourcePinId: string;
  /**
   * Exact latest folded package version pin; the shared-contract ArtifactRef
   * `version` is `metaapp://<currentPinId>`. Empty when the API omits it.
   */
  currentPinId: string;
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
  /** Root manifest creation/reproduction prompt; empty string when absent. */
  prompt: string;
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
  /** Motion Video playback projection; null when the item carries none. */
  motionVideo: MetaAppMotionVideo | null;
  /** Preference evidence summaries; null when the API returns no preference block. */
  preference: MetaAppPreference | null;
};

/**
 * Publisher-declared Motion Video playback metadata (MetaSo R1 projection).
 * `hasAudio: null` means unknown, not false; unmeasured counts stay null.
 * `learning.status` is manifest completeness only — it is NOT a MetaSo
 * package verification claim.
 */
export type MetaAppMotionVideo = {
  videoFile: string;
  videoUrl: string | null;
  videoSha256: string | null;
  durationSec: number | null;
  fps: number | null;
  frames: number | null;
  resolution: string | null;
  hasAudio: boolean | null;
  loudnessLufs: number | null;
  engine: string | null;
  style: string | null;
  learning: {
    sourceIncluded: boolean | null;
    hasPrompt: boolean | null;
    status: 'declared' | 'incomplete' | null;
  } | null;
};

/** Open-evidence summary per (chainName, videoSha256); null score = unjudged, never zero-quality. */
export type MetaAppPreferenceOpen = {
  score: number | null;
  scoreVersion: string | null;
  state: string | null;
  comparisons: number | null;
  judges: number | null;
  lastComparedAt: number | null;
};

/**
 * Validated evidence is unavailable before MetaSo R7: exactly
 * { score: null, state: 'unavailable' } and nothing else.
 */
export type MetaAppPreferenceValidated = {
  score: number | null;
  state: string | null;
};

export type MetaAppPreference = {
  open: MetaAppPreferenceOpen | null;
  validated: MetaAppPreferenceValidated | null;
};

/** Exact ArtifactRef from the shared contract (§3). */
export type PreferenceComparisonArtifact = {
  chainName: string;
  app: string;
  version: string;
  video: string;
  videoSha256: string;
};

/** One comparison-evidence item from GET /api/preference/comparisons. */
export type PreferenceComparisonItem = {
  feedbackPinId: string;
  chainName: string;
  basis: string;
  isMempool: boolean;
  confirmedAt: number | null;
  relayedAt: number | null;
  a: PreferenceComparisonArtifact | null;
  b: PreferenceComparisonArtifact | null;
  pick: string;
  reason: string | null;
  dims: Record<string, string> | null;
  signerGlobalMetaId: string;
  clientArtifact: string;
  clientMode: string;
  subject: string | null;
  outcome: string | null;
  excluded: boolean;
  excludedReason: string | null;
};

export type PreferenceComparisonsPage = {
  items: PreferenceComparisonItem[];
  nextCursor: string | null;
  hasMore: boolean;
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
  /** MetaSo R4: sort by the selected preference basis instead of feed order. */
  sort?: 'preference';
  /** Score direction; ascending is meaningful only for already-judged items. */
  order?: 'asc' | 'desc';
  /** Evidence projection; never blends bases silently. */
  basis?: 'open' | 'validated';
  /** Filter by distinct judges in the selected basis; 0 imposes no filter. */
  minJudges?: number;
  /** Filter by publisher-declared learning completeness (not a verification claim). */
  learning?: 'declared' | 'incomplete';
};

export type PreferenceComparisonsParams = {
  /** Required; scores and evidence never blend across chains. */
  chainName: string;
  /** Required in v1; the motion-video open projection. */
  category?: string;
  /** Only 'open' in this milestone; 'validated' maps to the unavailable error. */
  basis?: 'open' | 'validated';
  /** videoSha256 filter; required when outcome is not 'all'. */
  subject?: string;
  outcome?: 'preferred' | 'rejected' | 'all';
  includeMempool?: boolean;
  includeTest?: boolean;
  includeExcluded?: boolean;
  size?: number;
  cursor?: string;
};

export class MetaAppSearchNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetaAppSearchNotFoundError';
  }
}

/**
 * MetaSo reports basis=validated as business code 40000 with the stable
 * message `preference_validated_basis_unavailable` (before aggregator R7).
 * Callers map this to a readable "validated preference aggregation is not
 * yet available" state — never an open-basis fallback or a bare transport
 * error.
 */
export class MetaAppValidatedBasisUnavailableError extends Error {
  constructor(message: string) {
    super(message || 'preference_validated_basis_unavailable');
    this.name = 'MetaAppValidatedBasisUnavailableError';
  }
}

const VALIDATED_BASIS_UNAVAILABLE_MESSAGE = 'preference_validated_basis_unavailable';

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter(Boolean);
}

function nullableText(value: unknown): string | null {
  const normalized = text(value);
  return normalized ? normalized : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function normalizeLearning(value: unknown): MetaAppMotionVideo['learning'] {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!record) return null;
  const status = text(record.status);
  return {
    sourceIncluded: nullableBoolean(record.sourceIncluded),
    hasPrompt: nullableBoolean(record.hasPrompt),
    status: status === 'declared' || status === 'incomplete' ? status : null,
  };
}

function normalizeMotionVideo(value: unknown): MetaAppMotionVideo | null {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!record) return null;
  const videoFile = text(record.videoFile);
  if (!videoFile) return null;
  return {
    videoFile,
    videoUrl: nullableText(record.videoUrl),
    videoSha256: nullableText(record.videoSha256),
    durationSec: nullableNumber(record.durationSec),
    fps: nullableNumber(record.fps),
    frames: nullableNumber(record.frames),
    resolution: nullableText(record.resolution),
    hasAudio: nullableBoolean(record.hasAudio),
    loudnessLufs: nullableNumber(record.loudnessLufs),
    engine: nullableText(record.engine),
    style: nullableText(record.style),
    learning: normalizeLearning(record.learning),
  };
}

function normalizePreferenceOpen(value: unknown): MetaAppPreferenceOpen | null {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!record) return null;
  return {
    score: nullableNumber(record.score),
    scoreVersion: nullableText(record.scoreVersion),
    state: nullableText(record.state),
    comparisons: nullableNumber(record.comparisons),
    judges: nullableNumber(record.judges),
    lastComparedAt: nullableNumber(record.lastComparedAt),
  };
}

function normalizePreferenceValidated(value: unknown): MetaAppPreferenceValidated | null {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!record) return null;
  return {
    score: nullableNumber(record.score),
    state: nullableText(record.state),
  };
}

function normalizePreference(value: unknown): MetaAppPreference | null {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!record) return null;
  return {
    open: normalizePreferenceOpen(record.open),
    validated: normalizePreferenceValidated(record.validated),
  };
}

function normalizeItem(raw: unknown): MetaAppSearchItem {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    pinId: text(record.pinId),
    sourcePinId: text(record.sourcePinId),
    currentPinId: text(record.currentPinId),
    chainName: text(record.chainName),
    title: text(record.title),
    appName: text(record.appName),
    intro: text(record.intro),
    icon: text(record.icon),
    coverImg: text(record.coverImg),
    tags: textList(record.tags),
    runtime: text(record.runtime),
    version: text(record.version),
    prompt: text(record.prompt),
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
    motionVideo: normalizeMotionVideo(record.motionVideo),
    preference: normalizePreference(record.preference),
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

function normalizeComparisonArtifact(value: unknown): PreferenceComparisonArtifact | null {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!record) return null;
  const chainName = text(record.chainName);
  const app = text(record.app);
  const version = text(record.version);
  const video = text(record.video);
  const videoSha256 = text(record.videoSha256);
  if (!chainName || !app || !version || !video || !videoSha256) return null;
  return { chainName, app, version, video, videoSha256 };
}

function normalizeComparisonItem(raw: unknown): PreferenceComparisonItem {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const dimsRecord = record.dims && typeof record.dims === 'object' && !Array.isArray(record.dims)
    ? record.dims as Record<string, unknown>
    : null;
  const dims: Record<string, string> | null = dimsRecord
    ? Object.fromEntries(
        Object.entries(dimsRecord)
          .map(([key, value]) => [key, text(value)] as const)
          .filter(([, value]) => Boolean(value)),
      )
    : null;
  const client = record.client && typeof record.client === 'object'
    ? record.client as Record<string, unknown>
    : {};
  return {
    feedbackPinId: text(record.feedbackPinId),
    chainName: text(record.chainName),
    basis: text(record.basis),
    isMempool: record.isMempool === true,
    confirmedAt: nullableNumber(record.confirmedAt),
    relayedAt: nullableNumber(record.relayedAt),
    a: normalizeComparisonArtifact(record.a),
    b: normalizeComparisonArtifact(record.b),
    pick: text(record.pick),
    reason: nullableText(record.reason),
    dims: dims && Object.keys(dims).length > 0 ? dims : null,
    signerGlobalMetaId: text(record.signerGlobalMetaId),
    clientArtifact: text(client.artifact),
    clientMode: text(client.mode),
    subject: nullableText(record.subject),
    outcome: nullableText(record.outcome),
    excluded: record.excluded === true,
    excludedReason: nullableText(record.excludedReason),
  };
}

function normalizeComparisonsPage(raw: unknown): PreferenceComparisonsPage {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const items = Array.isArray(record.items) ? record.items.map(normalizeComparisonItem) : [];
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
    if (
      code === 40000
      && (message === VALIDATED_BASIS_UNAVAILABLE_MESSAGE || body.data === VALIDATED_BASIS_UNAVAILABLE_MESSAGE)
    ) {
      throw new MetaAppValidatedBasisUnavailableError(message);
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

/** GET /api/metaapp/list — global feed & intent search, with optional preference sorting. */
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
  if (params.sort === 'preference') {
    query.set('sort', 'preference');
    if (params.order === 'asc' || params.order === 'desc') query.set('order', params.order);
    if (params.basis === 'open' || params.basis === 'validated') query.set('basis', params.basis);
    if (typeof params.minJudges === 'number' && params.minJudges >= 0) {
      query.set('minJudges', String(Math.floor(params.minJudges)));
    }
    if (params.learning === 'declared' || params.learning === 'incomplete') {
      query.set('learning', params.learning);
    }
  }
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

/**
 * GET /api/preference/comparisons — open comparison evidence with concrete
 * reasons for learning (preferred/rejected contrasts). basis=validated maps
 * to MetaAppValidatedBasisUnavailableError before MetaSo R7.
 */
export async function listPreferenceComparisons(
  params: PreferenceComparisonsParams,
  options?: MetaAppSearchServiceOptions,
): Promise<PreferenceComparisonsPage> {
  const { baseUrl, fetchImpl, timeoutMs } = resolveOptions(options);
  const chainName = params.chainName?.trim();
  if (!chainName) {
    throw new Error('chainName is required to list preference comparisons.');
  }
  const outcome = params.outcome ?? 'all';
  const subject = params.subject?.trim() ?? '';
  if (outcome !== 'all' && !subject) {
    throw new Error('subject (videoSha256) is required when outcome is preferred or rejected.');
  }
  const query = new URLSearchParams();
  query.set('chainName', chainName);
  query.set('category', params.category?.trim() || 'motion-video');
  query.set('basis', params.basis ?? 'open');
  if (subject) query.set('subject', subject);
  if (outcome !== 'all') query.set('outcome', outcome);
  if (params.includeMempool) query.set('includeMempool', '1');
  if (params.includeTest) query.set('includeTest', '1');
  if (params.includeExcluded) query.set('includeExcluded', '1');
  if (typeof params.size === 'number' && params.size > 0) query.set('size', String(Math.min(100, Math.floor(params.size))));
  if (params.cursor?.trim()) query.set('cursor', params.cursor.trim());
  const qs = query.toString();
  const data = await fetchApiData(`${baseUrl}/api/preference/comparisons?${qs}`, fetchImpl, timeoutMs);
  return normalizeComparisonsPage(data);
}
