/**
 * Identity-change closeout for the free-relay credential caches.
 *
 * Root cause of the 2026-10 identity-split incident: a reinstall silently
 * provisioned identity B (ensureUserIdentity inside the first-run bootstrap),
 * the user then logged out and imported identity A's mnemonic, and every relay
 * credential cache kept serving B's key while the UI showed A. The key stays
 * valid server-side, so the 401 re-bootstrap path never fired and the renderer
 * provisioning gate saw a "configured" provider — A's chat/JEV/vision traffic
 * burned B's quota indefinitely, with both keys alternating server-side.
 *
 * This module is the single chokepoint every user_identity replacement goes
 * through (userIdentity:import and userIdentity:create today; add new paths
 * here, never inline in a handler). It
 * 1. drops the llmRelay quota snapshot,
 * 2. drops the JEV relay credentials (kv + memory),
 * 3. drops the vision relay credentials (kv + memory),
 * 4. blanks apiKey/baseUrl on the metaid-free provider config, so the renderer
 *    gate and every main-side reader see "unprovisioned" instead of a stale key,
 * then re-bootstraps with the CURRENT identity, writes the fresh key back into
 * the provider config and lets the JEV/vision resolvers re-persist it from
 * there (the same startup-prewarm path, so nothing bootstraps twice).
 *
 * Steps 1-4 are synchronous and never throw; the re-bootstrap is best-effort
 * (an offline import still succeeds — caches simply stay empty and the next
 * on-demand resolution bootstraps as the new identity). Electron-free
 * (store/bootstrap/log injected) so plain node:test coverage works.
 *
 * userIdentity:logout deliberately does NOT run this closeout: with no local
 * identity left, empty caches would make the startup JEV prewarm mint a brand
 * new identity through ensureUserIdentity — the very silent provisioning that
 * caused the split. The stale key is replaced at the next import/create.
 */

import type { SqliteStore } from '../sqliteStore';
import {
  bootstrapLlmRelay,
  clearLlmRelayQuotaCache,
  setLlmRelayIdentityMismatchHandler,
} from './llmRelayService';
import {
  invalidateJevRelayCredentials,
  resolveJevRelayCredentials,
  type JevRelayLogSink,
} from './jevRelayService';
import { invalidateVisionRelayCredentials, resolveVisionRelayCredentials } from './visionRelayService';

/** Provider key of the built-in free relay provider (renderer: LLM_FREE_PROVIDER_KEY). */
export const METAID_FREE_PROVIDER_KEY = 'metaid-free';

export type RelayIdentityChangeReason = 'import' | 'create' | 'quota-identity-mismatch';

export interface RelayIdentityCloseoutDeps {
  getStore: () => SqliteStore | null;
  /** Identity-signed relay bootstrap (default: llmRelayService.bootstrapLlmRelay). */
  bootstrapImpl?: () => Promise<{ apiKey: string; baseUrl: string }>;
  /**
   * Notified after this module rewrote app_config. main.ts broadcasts
   * store:changed from here so the renderer configService reloads instead of
   * writing its stale in-memory snapshot (old key included) back over the row.
   */
  onAppConfigChanged?: () => void;
  /** Log sink (the app passes coworkLog so the key-prefix switch shows in cowork.log). */
  log?: JevRelayLogSink;
}

export interface RelayIdentityCloseoutResult {
  /** True once the three caches + provider credentials were cleared. */
  cleared: boolean;
  /**
   * ok: a fresh key was issued for the current identity and landed in the
   * caches; skipped: no metaid-free provider entry exists, so nothing to
   * refresh (the on-demand resolvers bootstrap once when first needed);
   * failed: bootstrap errored — caches stay empty, see error.
   */
  rebootstrap: 'ok' | 'skipped' | 'failed';
  /** Public prefix of the re-issued key (never the key itself). */
  keyPrefix?: string;
  error?: string;
}

let depsRef: RelayIdentityCloseoutDeps | null = null;
let inFlight: Promise<RelayIdentityCloseoutResult> | null = null;

export function initRelayIdentityCloseoutService(deps: RelayIdentityCloseoutDeps): void {
  depsRef = deps;
  // A quota response naming another identity's key is the same situation as
  // an identity change the caches missed: route it through the closeout.
  setLlmRelayIdentityMismatchHandler(async ({ localMvcAddress }) => {
    await applyRelayIdentityChange({ reason: 'quota-identity-mismatch', detail: localMvcAddress });
  });
}

export function resetRelayIdentityCloseoutServiceForTests(): void {
  depsRef = null;
  inFlight = null;
  setLlmRelayIdentityMismatchHandler(null);
}

type ProviderRecord = Record<string, unknown>;
type AppConfigRecord = { providers?: Record<string, ProviderRecord | undefined> } & Record<string, unknown>;

function readAppConfig(): AppConfigRecord | null {
  try {
    const store = depsRef?.getStore?.() ?? null;
    const appConfig = store?.get('app_config') as AppConfigRecord | null | undefined;
    return appConfig && typeof appConfig === 'object' && !Array.isArray(appConfig) ? appConfig : null;
  } catch {
    return null;
  }
}

function readMetaIdFreeProviderEntry(appConfig: AppConfigRecord | null): ProviderRecord | null {
  const provider = appConfig?.providers?.[METAID_FREE_PROVIDER_KEY];
  return provider && typeof provider === 'object' && !Array.isArray(provider) ? provider : null;
}

/**
 * Rewrite only apiKey/baseUrl on the metaid-free provider entry, preserving
 * every other field (enabled, models, name, apiFormat — the model catalog is
 * the renderer's to manage). Returns false when there is no store or no
 * provider entry: a never-provisioned install has nothing to clear here.
 */
function writeMetaIdFreeProviderCredentials(apiKey: string, baseUrl: string): boolean {
  try {
    const store = depsRef?.getStore?.() ?? null;
    if (!store || typeof (store as { set?: unknown }).set !== 'function') return false;
    const appConfig = readAppConfig();
    const provider = readMetaIdFreeProviderEntry(appConfig);
    if (!appConfig || !provider) return false;
    const currentKey = typeof provider.apiKey === 'string' ? provider.apiKey : '';
    const currentBase = typeof provider.baseUrl === 'string' ? provider.baseUrl : '';
    if (currentKey === apiKey && currentBase === baseUrl) return false;
    (store as Pick<SqliteStore, 'set'>).set('app_config', {
      ...appConfig,
      providers: {
        ...appConfig.providers,
        [METAID_FREE_PROVIDER_KEY]: { ...provider, apiKey, baseUrl },
      },
    });
    depsRef?.onAppConfigChanged?.();
    return true;
  } catch {
    return false;
  }
}

/**
 * Synchronously drop every cached relay credential: llmRelay quota snapshot,
 * JEV kv + memory, vision kv + memory, and the metaid-free provider's
 * apiKey/baseUrl. Never throws. Exported for the closeout and for tests; the
 * identity handlers call applyRelayIdentityChange, which runs this first.
 */
export function clearRelayCredentialCaches(): void {
  clearLlmRelayQuotaCache();
  invalidateJevRelayCredentials();
  invalidateVisionRelayCredentials();
  writeMetaIdFreeProviderCredentials('', '');
}

/**
 * Full closeout after the user_identity row changed: clear, re-bootstrap as
 * the current identity, land the fresh key in the provider config and the
 * JEV/vision kv tiers. Concurrent callers share one flight. Never rejects —
 * identity import/create must succeed even when the relay is unreachable.
 */
export function applyRelayIdentityChange(input: {
  reason: RelayIdentityChangeReason;
  detail?: string;
}): Promise<RelayIdentityCloseoutResult> {
  if (inFlight) return inFlight;
  inFlight = runCloseout(input).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runCloseout(input: {
  reason: RelayIdentityChangeReason;
  detail?: string;
}): Promise<RelayIdentityCloseoutResult> {
  const log = depsRef?.log ?? null;
  clearRelayCredentialCaches();
  log?.('INFO', 'relayIdentity:closeout', 'relay credential caches cleared after identity change', {
    reason: input.reason,
    detail: input.detail ?? null,
  });

  if (!readMetaIdFreeProviderEntry(readAppConfig())) {
    log?.('INFO', 'relayIdentity:closeout', 'no metaid-free provider entry; relay re-bootstrap deferred to first use', {
      reason: input.reason,
    });
    return { cleared: true, rebootstrap: 'skipped' };
  }

  let credentials: { apiKey: string; baseUrl: string };
  try {
    const bootstrap = depsRef?.bootstrapImpl ? depsRef.bootstrapImpl() : bootstrapLlmRelay();
    const info = await bootstrap;
    credentials = {
      apiKey: typeof info?.apiKey === 'string' ? info.apiKey.trim() : '',
      baseUrl: typeof info?.baseUrl === 'string' ? info.baseUrl.trim() : '',
    };
    if (!credentials.apiKey || !credentials.baseUrl) {
      throw new Error('relay bootstrap returned no apiKey/baseUrl');
    }
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : String(error);
    log?.('WARN', 'relayIdentity:closeout', 'relay re-bootstrap after identity change failed; caches stay empty until the next on-demand resolution', {
      reason: input.reason,
      error: message,
    });
    return { cleared: true, rebootstrap: 'failed', error: message };
  }

  const keyPrefix = credentials.apiKey.slice(0, 10);
  writeMetaIdFreeProviderCredentials(credentials.apiKey, credentials.baseUrl);
  // With memory + kv cleared and the provider entry just rewritten, each
  // resolver reads the provider credentials and persists them to its own kv
  // tier — the startup-prewarm path, without a second bootstrap. Neither
  // failure may surface to the identity handler.
  await Promise.all([
    resolveJevRelayCredentials().catch(() => null),
    resolveVisionRelayCredentials().catch(() => null),
  ]);
  log?.('INFO', 'relayIdentity:closeout', 'relay key re-issued for the current identity', {
    reason: input.reason,
    keyPrefix,
  });
  return { cleared: true, rebootstrap: 'ok', keyPrefix };
}
