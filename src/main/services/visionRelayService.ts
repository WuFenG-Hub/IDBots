/**
 * Vision relay client (describe_image backend).
 *
 * Calls the assist-base-service vision relay so bots can read images no matter
 * which model backs the session. Reuses the free-quota relay credentials: the
 * same `metaid-free` relay key that serves chat also authorizes
 * POST /v2/assist/llm/vision/recognize. Credentials resolve lazily
 * (kv cache -> metaid-free provider config -> identity-signed bootstrap) and
 * one automatic re-bootstrap covers a revoked/lost key.
 *
 * Backend contract (assist-base-service "LLM 视觉识别中继接口"):
 * - POST {chatBaseUrl without trailing /v1}/vision/recognize
 *   Authorization: Bearer <relay key>
 *   {imageBase64 | imageUrl, mimeType?, prompt?}
 *   -> {code:0, data:{content, model, usage, remainingToday}} or
 *      {code:1, message:<stable machine-readable error>}.
 * - Vision calls are metered by a per-identity daily image count and do NOT
 *   consume the chat token quota.
 *
 * The service is Electron-free (store/fetch/bootstrap/image-codec injected)
 * so plain node:test coverage works, mirroring llmRelayService.
 */

import type { SqliteStore } from '../sqliteStore';

const VISION_RECOGNIZE_TIMEOUT_MS = 60_000;
/** Cap for the post-codec JPEG payload handed to the relay (base64 excluded). */
const VISION_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** kv keys for the cached vision relay credentials. */
export const VISION_RELAY_API_KEY_KV = 'visionRelay.apiKey';
export const VISION_RELAY_BASE_URL_KV = 'visionRelay.baseUrl';

export class VisionRelayError extends Error {
  /** Stable server-side message (backend error contract) when available. */
  readonly relayMessage: string | null;

  constructor(message: string, relayMessage: string | null = null) {
    super(message);
    this.name = 'VisionRelayError';
    this.relayMessage = relayMessage;
  }
}

export interface VisionRelayRecognizeResult {
  content: string;
  model: string;
  remainingToday: number;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    imageTokens: number;
    estimated: boolean;
  };
}

export interface VisionRelayRecognizeInput {
  /** Absolute local path of the image to describe. */
  imagePath?: string;
  /** Pre-encoded base64 image (no data: prefix); used when no path is given. */
  imageBase64?: string;
  mimeType?: string;
  /** Optional question; the server default describes + OCRs when omitted. */
  prompt?: string;
}

export interface VisionRelayServiceDeps {
  getStore: () => SqliteStore | null;
  fetchImpl?: typeof fetch;
  /** Identity-signed relay bootstrap (default: llmRelayService.bootstrapLlmRelay). */
  bootstrapImpl?: () => Promise<{ apiKey: string; baseUrl: string }>;
  /**
   * Reads one local image file and returns downscaled JPEG base64 + size.
   * Default implementation uses Electron nativeImage; tests inject a stub.
   */
  loadImageBase64Impl?: (imagePath: string) => Promise<{ base64: string; bytes: number } | null>;
}

let depsRef: VisionRelayServiceDeps | null = null;
let cachedCredentials: { apiKey: string; baseUrl: string } | null = null;

export function initVisionRelayService(deps: VisionRelayServiceDeps): void {
  depsRef = deps;
}

export function resetVisionRelayServiceForTests(): void {
  depsRef = null;
  cachedCredentials = null;
}

function getDeps(): VisionRelayServiceDeps {
  if (!depsRef) {
    throw new VisionRelayError('vision relay service not initialized');
  }
  return depsRef;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// URL + credential resolution
// ---------------------------------------------------------------------------

/**
 * Derive the recognize endpoint from the chat baseUrl the relay hands out
 * (`.../v2/assist/llm/v1` -> `.../v2/assist/llm/vision/recognize`). Exported
 * for tests; tolerant of a missing /v1 tail so custom gateways keep working.
 */
export function deriveVisionRecognizeUrl(chatBaseUrl: string): string {
  const base = (chatBaseUrl || '').trim().replace(/\/+$/, '');
  if (!base) {
    throw new VisionRelayError('vision relay baseUrl is empty');
  }
  const stem = base.endsWith('/v1') ? base.slice(0, -'/v1'.length) : base;
  return `${stem}/vision/recognize`;
}

function readPersistedCredentials(): { apiKey: string; baseUrl: string } | null {
  try {
    const store = depsRef?.getStore?.() ?? null;
    const apiKey = typeof store?.get(VISION_RELAY_API_KEY_KV) === 'string'
      ? (store.get(VISION_RELAY_API_KEY_KV) as string).trim()
      : '';
    const baseUrl = typeof store?.get(VISION_RELAY_BASE_URL_KV) === 'string'
      ? (store.get(VISION_RELAY_BASE_URL_KV) as string).trim()
      : '';
    if (apiKey && baseUrl) return { apiKey, baseUrl };
  } catch {
    // unreadable kv falls through to the next source
  }
  return null;
}

function readMetaIdFreeProviderCredentials(): { apiKey: string; baseUrl: string } | null {
  try {
    const store = depsRef?.getStore?.() ?? null;
    const appConfig = store?.get('app_config') as
      | { providers?: Record<string, { apiKey?: unknown; baseUrl?: unknown } | undefined> }
      | null;
    const provider = appConfig?.providers?.['metaid-free'];
    const apiKey = typeof provider?.apiKey === 'string' ? provider.apiKey.trim() : '';
    const baseUrl = typeof provider?.baseUrl === 'string' ? provider.baseUrl.trim() : '';
    if (apiKey && baseUrl) return { apiKey, baseUrl };
  } catch {
    // unreadable config falls through to bootstrap
  }
  return null;
}

function persistCredentials(credentials: { apiKey: string; baseUrl: string }): void {
  try {
    const store = depsRef?.getStore?.() ?? null;
    if (store && typeof (store as { set?: unknown }).set === 'function') {
      (store as Pick<SqliteStore, 'set'>).set(VISION_RELAY_API_KEY_KV, credentials.apiKey);
      (store as Pick<SqliteStore, 'set'>).set(VISION_RELAY_BASE_URL_KV, credentials.baseUrl);
    }
  } catch {
    // persistence loss is non-fatal: the in-memory cache still serves this run
  }
}

/**
 * Resolve the relay key + chat baseUrl for vision calls. Order: in-memory
 * cache, persisted vision kv, the provisioned metaid-free provider, then a
 * fresh identity-signed bootstrap (persisted for later runs).
 */
export async function resolveVisionRelayCredentials(): Promise<{ apiKey: string; baseUrl: string }> {
  if (cachedCredentials) return cachedCredentials;
  const persisted = readPersistedCredentials();
  if (persisted) {
    cachedCredentials = persisted;
    return persisted;
  }
  const fromProvider = readMetaIdFreeProviderCredentials();
  if (fromProvider) {
    cachedCredentials = fromProvider;
    persistCredentials(fromProvider);
    return fromProvider;
  }
  const bootstrap = getDeps().bootstrapImpl
    ? getDeps().bootstrapImpl!()
    : import('./llmRelayService').then((m) => m.bootstrapLlmRelay());
  const info = await bootstrap;
  const credentials = { apiKey: info.apiKey.trim(), baseUrl: info.baseUrl.trim() };
  if (!credentials.apiKey || !credentials.baseUrl) {
    throw new VisionRelayError('vision relay bootstrap returned no apiKey/baseUrl');
  }
  cachedCredentials = credentials;
  persistCredentials(credentials);
  return credentials;
}

function invalidateCredentials(): void {
  cachedCredentials = null;
  try {
    const store = depsRef?.getStore?.() ?? null;
    if (store && typeof (store as { delete?: unknown }).delete === 'function') {
      (store as { delete?: (key: string) => unknown }).delete(VISION_RELAY_API_KEY_KV);
      (store as { delete?: (key: string) => unknown }).delete(VISION_RELAY_BASE_URL_KV);
    }
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Image loading (downscale via Electron nativeImage by default)
// ---------------------------------------------------------------------------

async function defaultLoadImageBase64(imagePath: string): Promise<{ base64: string; bytes: number } | null> {
  const { nativeImage } = await import('electron');
  const image = nativeImage.createFromPath(imagePath);
  if (image.isEmpty()) return null;
  const size = image.getSize();
  const longest = Math.max(size.width, size.height);
  const resized = longest > 1280 ? image.resize({ width: size.width >= size.height ? 1280 : 0, height: size.height > size.width ? 1280 : 0 }) : image;
  const buffer = resized.toJPEG(80);
  return { base64: buffer.toString('base64'), bytes: buffer.length };
}

async function loadImageBase64(imagePath: string): Promise<{ base64: string; bytes: number } | null> {
  const impl = depsRef?.loadImageBase64Impl ?? defaultLoadImageBase64;
  try {
    return await impl(imagePath);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Recognize call
// ---------------------------------------------------------------------------

async function postRecognize(
  credentials: { apiKey: string; baseUrl: string },
  body: Record<string, unknown>,
): Promise<VisionRelayRecognizeResult> {
  const fetchImpl = getDeps().fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_RECOGNIZE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(deriveVisionRecognizeUrl(credentials.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credentials.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw new VisionRelayError(`vision relay request failed: ${getErrorMessage(error)}`);
  } finally {
    clearTimeout(timer);
  }

  let payload: Record<string, unknown> | null = null;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    payload = null;
  }
  if (!payload || typeof payload !== 'object') {
    throw new VisionRelayError(`vision relay returned an unreadable response (HTTP ${response.status})`);
  }
  if (payload.code !== 0) {
    const message = typeof payload.message === 'string' ? payload.message : `HTTP ${response.status}`;
    throw new VisionRelayError(`vision relay error: ${message}`, message);
  }
  const data = payload.data as Record<string, unknown> | null;
  const content = typeof data?.content === 'string' ? data.content : '';
  if (!content) {
    throw new VisionRelayError('vision relay returned no image description');
  }
  const usageRaw = data?.usage as Record<string, unknown> | null;
  const toCount = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return {
    content,
    model: typeof data?.model === 'string' ? data.model : '',
    remainingToday: typeof data?.remainingToday === 'number' ? data.remainingToday : -1,
    usage: {
      promptTokens: toCount(usageRaw?.promptTokens),
      completionTokens: toCount(usageRaw?.completionTokens),
      totalTokens: toCount(usageRaw?.totalTokens),
      imageTokens: toCount(usageRaw?.imageTokens),
      estimated: usageRaw?.estimated === true,
    },
  };
}

/**
 * Describe one image through the vision relay. Accepts a local file path
 * (downscaled to a ≤1280px JPEG before upload) or pre-encoded base64. A
 * rejected relay key triggers exactly one re-bootstrap + retry.
 */
export async function recognizeImageViaRelay(input: VisionRelayRecognizeInput): Promise<VisionRelayRecognizeResult> {
  const body: Record<string, unknown> = {};
  if (input.imagePath) {
    const loaded = await loadImageBase64(input.imagePath);
    if (!loaded) {
      throw new VisionRelayError(`could not read image file: ${input.imagePath}`);
    }
    if (loaded.bytes > VISION_MAX_IMAGE_BYTES) {
      throw new VisionRelayError('image too large after compression; keep images under 8 MiB');
    }
    body.imageBase64 = loaded.base64;
    body.mimeType = 'image/jpeg';
  } else if (input.imageBase64) {
    body.imageBase64 = input.imageBase64;
    if (input.mimeType) body.mimeType = input.mimeType;
  } else {
    throw new VisionRelayError('imagePath or imageBase64 is required');
  }
  const prompt = (input.prompt || '').trim();
  if (prompt) body.prompt = prompt;

  let credentials = await resolveVisionRelayCredentials();
  try {
    return await postRecognize(credentials, body);
  } catch (error) {
    const relayMessage = error instanceof VisionRelayError ? error.relayMessage : null;
    const keyRejected = relayMessage === 'relay key invalid or revoked';
    if (!keyRejected) throw error;
    invalidateCredentials();
    credentials = await resolveVisionRelayCredentials();
    return postRecognize(credentials, body);
  }
}
