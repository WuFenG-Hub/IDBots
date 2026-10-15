/**
 * JEV relay client for the official free cerebellum provider (idbots-jev-free).
 *
 * assist-base-service proxies the TypeSafe JEV upstream and holds the real
 * upstream key server-side; the client authorizes with the SAME free-quota
 * relay key (mrk_...) that serves chat. Backend contract (assist-base-service
 * 《JEV 小脑模型中转接口.md》):
 * - cerebellum baseUrl = https://www.metaso.network/assist-open-api/v2/assist/llm/jev
 *   (POST {baseUrl}/v1/systemone and GET {baseUrl}/v1/models are verbatim
 *   TypeSafe-shaped relays of the client payload/catalog)
 * - 401 invalid_api_key -> re-bootstrap once and retry (bounded here to one
 *   re-bootstrap so a revoked key can never loop)
 * - quota is shared with chat (GET /v2/assist/llm/quota, llmRelayService)
 *
 * Credential resolution mirrors visionRelayService's proven chain: in-memory
 * cache -> jevRelay kv -> the provisioned metaid-free provider -> a fresh
 * identity-signed bootstrap (persisted for later runs). The service is
 * Electron-free (store/bootstrap injected) so plain node:test coverage works.
 */

import {
  CEREBELLUM_FREE_PROVIDER,
  resolveCerebellumConfig,
  type ResolvedCerebellumConfig,
} from '../libs/cerebellumConfig';
import type { SqliteStore } from '../sqliteStore';

/** kv keys for the cached JEV relay credentials (visionRelay-style). */
export const JEV_RELAY_API_KEY_KV = 'jevRelay.apiKey';
export const JEV_RELAY_BASE_URL_KV = 'jevRelay.baseUrl';

export interface JevRelayCredentials {
  apiKey: string;
  baseUrl: string;
}

export interface JevRelayServiceDeps {
  getStore: () => SqliteStore | null;
  /** Identity-signed relay bootstrap (default: llmRelayService.bootstrapLlmRelay). */
  bootstrapImpl?: () => Promise<{ apiKey: string; baseUrl: string }>;
}

let depsRef: JevRelayServiceDeps | null = null;
let cachedCredentials: JevRelayCredentials | null = null;
/**
 * Shared in-flight bootstrap. A revoked relay key surfaces as 401 on EVERY
 * decision call site of one turn (memory rank, skill shortlist, block gate,
 * …) at once; without sharing, each site fired its OWN identity-signed
 * bootstrap (2026-10-15 first-sentence latency report: five parallel
 * bootstraps, each 15s+). One flight, everyone awaits it.
 */
let bootstrapInFlight: Promise<JevRelayCredentials> | null = null;

export function initJevRelayService(deps: JevRelayServiceDeps): void {
  depsRef = deps;
}

export function resetJevRelayServiceForTests(): void {
  depsRef = null;
  cachedCredentials = null;
  bootstrapInFlight = null;
}

function getDeps(): JevRelayServiceDeps {
  if (!depsRef) {
    throw new Error('JEV relay service not initialized');
  }
  return depsRef;
}

function readPersistedCredentials(): JevRelayCredentials | null {
  try {
    const store = depsRef?.getStore?.() ?? null;
    const apiKey = typeof store?.get(JEV_RELAY_API_KEY_KV) === 'string'
      ? (store.get(JEV_RELAY_API_KEY_KV) as string).trim()
      : '';
    const baseUrl = typeof store?.get(JEV_RELAY_BASE_URL_KV) === 'string'
      ? (store.get(JEV_RELAY_BASE_URL_KV) as string).trim()
      : '';
    if (apiKey && baseUrl) return { apiKey, baseUrl };
  } catch {
    // unreadable kv falls through to the next source
  }
  return null;
}

function readMetaIdFreeProviderCredentials(): JevRelayCredentials | null {
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

function persistCredentials(credentials: JevRelayCredentials): void {
  try {
    const store = depsRef?.getStore?.() ?? null;
    if (store && typeof (store as { set?: unknown }).set === 'function') {
      (store as Pick<SqliteStore, 'set'>).set(JEV_RELAY_API_KEY_KV, credentials.apiKey);
      (store as Pick<SqliteStore, 'set'>).set(JEV_RELAY_BASE_URL_KV, credentials.baseUrl);
    }
  } catch {
    // persistence loss is non-fatal: the in-memory cache still serves this run
  }
}

function invalidateCredentials(): void {
  cachedCredentials = null;
  try {
    const store = depsRef?.getStore?.() ?? null;
    if (store && typeof (store as { delete?: unknown }).delete === 'function') {
      (store as { delete: (key: string) => unknown }).delete(JEV_RELAY_API_KEY_KV);
      (store as { delete: (key: string) => unknown }).delete(JEV_RELAY_BASE_URL_KV);
    }
  } catch {
    // best-effort
  }
}

/**
 * Resolve the relay key (+ chat baseUrl) for JEV calls. Order: in-memory
 * cache, persisted jevRelay kv, the provisioned metaid-free provider, then a
 * fresh identity-signed bootstrap (persisted for later runs).
 */
export async function resolveJevRelayCredentials(): Promise<JevRelayCredentials> {
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
  // One shared flight for concurrent resolvers (see bootstrapInFlight);
  // losers await the winner's result. A failed flight unshares in the
  // finally below so the next caller retries instead of latching the
  // rejection; a resolver that lost to an invalidated cache still returns
  // the freshest credentials any flight produced.
  if (!bootstrapInFlight) {
    bootstrapInFlight = (async () => {
      const bootstrap = getDeps().bootstrapImpl
        ? getDeps().bootstrapImpl!()
        : import('./llmRelayService').then((m) => m.bootstrapLlmRelay());
      const info = await bootstrap;
      const credentials = { apiKey: info.apiKey.trim(), baseUrl: info.baseUrl.trim() };
      if (!credentials.apiKey || !credentials.baseUrl) {
        throw new Error('JEV relay bootstrap returned no apiKey/baseUrl');
      }
      cachedCredentials = credentials;
      persistCredentials(credentials);
      return credentials;
    })().finally(() => {
      bootstrapInFlight = null;
    });
  }
  try {
    return await bootstrapInFlight;
  } catch (error) {
    if (cachedCredentials) return cachedCredentials;
    throw error;
  }
}

/**
 * Runtime cerebellum config for the main-process decision call sites. Wraps
 * the pure resolver: direct TypeSafe configs pass through untouched; the free
 * provider gets its relay key injected from the credential chain (baseUrl and
 * model are already pinned by the resolver). Never throws — a free provider
 * with no obtainable key maps to null so the cerebellum silently stays off,
 * exactly like enabled=false.
 */
export async function resolveCerebellumRuntimeConfig(appConfig: unknown): Promise<ResolvedCerebellumConfig | null> {
  const config = resolveCerebellumConfig(appConfig);
  if (!config || config.provider !== CEREBELLUM_FREE_PROVIDER) {
    return config;
  }
  try {
    const { apiKey } = await resolveJevRelayCredentials();
    if (!apiKey) {
      return null;
    }
    return { ...config, apiKey };
  } catch {
    // bootstrap failure (offline, relay down): feature off for this call
    return null;
  }
}

/**
 * fetch wrapper for free-provider cerebellum calls: on a 401 (revoked relay
 * key) it re-bootstraps ONCE and retries the same request with the fresh key.
 * Any failure (including a second 401) returns the last response unchanged —
 * the decision call sites keep their fail-to-null semantics, so no retry
 * storm is possible: at most 2 requests and 1 bootstrap per call.
 *
 * The caller's AbortSignal bounds the WHOLE wrapper, bootstrap included. The
 * decision call sites run 1.5s budgets; the identity-signed bootstrap has
 * been observed taking 15s+ and used to blow straight through that budget
 * (2026-10-15 first-sentence latency report: first chat turns stalled 15-25s
 * on volatile-block JEV calls whose deadline had already fired). On abort the
 * stale 401 returns immediately and the shared bootstrap keeps running in the
 * background — the next turn finds the fresh key cached.
 */
export function createJevRelayFetchWithKeyRetry<R extends { ok: boolean; status: number }>(
  fetchImpl: (url: string, init: Record<string, unknown>) => Promise<R>,
): (url: string, init: Record<string, unknown>) => Promise<R> {
  return async (url, init) => {
    const first = await fetchImpl(url, init);
    if (first.status !== 401) {
      return first;
    }
    const signal = (init as { signal?: AbortSignal | null }).signal ?? null;
    if (signal?.aborted) {
      return first;
    }
    try {
      invalidateCredentials();
      const { apiKey } = await raceAbortSignal(resolveJevRelayCredentials(), signal);
      const headers = {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${apiKey}`,
      };
      return await fetchImpl(url, { ...init, headers });
    } catch {
      return first;
    }
  };
}

/** Resolve with `promise`, or reject with an AbortError the moment `signal`
 *  fires. The underlying promise is left running (callers use this to stop
 *  WAITING, not to cancel the work — shared bootstraps must complete so later
 *  callers find the cached result). Listener-safe on both paths. */
function raceAbortSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | null,
  abortMessage = 'The JEV relay re-bootstrap was aborted',
): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException(abortMessage, 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    const settle = (fn: () => void) => {
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    promise.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
}

/**
 * fetch wrapper that enforces the caller's AbortSignal IN OUR CODE instead of
 * trusting the underlying fetch to honor it. Empirically (2026-10-16
 * follow-up on session 70fa10aa): Electron's session.fetch rejects on abort
 * on a healthy network within ~1s, but when the connection stalls behind a
 * proxy/upstream (the free relay hung five cerebellum calls for 17s) the
 * abort never surfaced — every 1s/1.5s call budget blew past its deadline and
 * the turn's first sentence waited out the upstream recovery. This wrapper
 * rejects the CALLER at the abort edge regardless; the abandoned socket is
 * left to settle on its own (the decision call sites are fail-to-null, so a
 * late response is simply dropped).
 *
 * Applies to the response HEADERS arriving; body reading stays with the
 * caller's own signal handling (the observed stall was pre-headers).
 */
export function createSignalBoundedFetch<R>(
  fetchImpl: (url: string, init: Record<string, unknown>) => Promise<R>,
): (url: string, init: Record<string, unknown>) => Promise<R> {
  return (url, init) => {
    const signal = (init as { signal?: AbortSignal | null }).signal ?? null;
    if (!signal) return fetchImpl(url, init);
    if (signal.aborted) {
      return Promise.reject(new DOMException('The cerebellum call was aborted before dispatch', 'AbortError'));
    }
    return raceAbortSignal(
      fetchImpl(url, init),
      signal,
      'The cerebellum call was aborted while awaiting the upstream response',
    ) as Promise<R>;
  };
}

// ---------------------------------------------------------------------------
// IPC surface (renderer: cerebellum free-provider connection test / key fill)
// ---------------------------------------------------------------------------

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export function registerJevRelayIpcHandlers(deps: { ipcMain: IpcMainLike }): void {
  const { ipcMain } = deps;
  ipcMain.handle('jevRelay:resolveCredentials', async () => {
    try {
      return { success: true, credentials: await resolveJevRelayCredentials() };
    } catch (error) {
      return { success: false, error: error instanceof Error && error.message ? error.message : String(error) };
    }
  });
}
