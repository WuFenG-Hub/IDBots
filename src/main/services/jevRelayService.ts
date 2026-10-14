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

export function initJevRelayService(deps: JevRelayServiceDeps): void {
  depsRef = deps;
}

export function resetJevRelayServiceForTests(): void {
  depsRef = null;
  cachedCredentials = null;
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
 */
export function createJevRelayFetchWithKeyRetry<R extends { ok: boolean; status: number }>(
  fetchImpl: (url: string, init: Record<string, unknown>) => Promise<R>,
): (url: string, init: Record<string, unknown>) => Promise<R> {
  return async (url, init) => {
    const first = await fetchImpl(url, init);
    if (first.status !== 401) {
      return first;
    }
    try {
      invalidateCredentials();
      const { apiKey } = await resolveJevRelayCredentials();
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
