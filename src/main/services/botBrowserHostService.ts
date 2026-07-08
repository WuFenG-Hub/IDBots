import {
  applyBrowserSettingsUpdate,
  browserCommandFailed,
  browserCommandSuccess,
  createBrowserSettingsSnapshot,
  createDefaultBrowserConfig,
  fetchBotProfileInfo,
  resolveBrowserConfig,
  resolveBrowserResource,
  type BrowserBaseConfig,
  type BrowserCommandResult as CoreBrowserCommandResult,
  type BrowserConfigContainer,
  type BrowserNameAliasProvider,
  type BrowserResolveResult,
  type MetaAppGalleryRecord,
} from '@openagentinternet/agent-browser-core';
import { createBrowserNameAliasProviders } from '@openagentinternet/agent-browser-name-resolvers';
import {
  browserFailure,
  browserSuccess,
  type BrowserCommandResult,
  type BrowserResolveInput,
  type BrowserSettingsInput,
  type BrowserSettingsSnapshot,
  type BrowserSettingsUpdateInput,
} from '@openagentinternet/agent-browser-host-contract';

import type { MetaAppRecord } from '../metaAppManager';
import type { CommunityMetaAppInstallResult } from './metaAppChainService';

export interface BotBrowserHostService {
  resolveResource(input: BrowserResolveInput): Promise<BrowserCommandResult<BrowserResolveResult>>;
  getProfile(input: BotBrowserProfileInput): Promise<BrowserCommandResult<BotBrowserProfileSnapshot>>;
  getSettings(input?: BrowserSettingsInput): Promise<BrowserCommandResult<BrowserSettingsSnapshot>>;
  updateSettings(input: BrowserSettingsUpdateInput): Promise<BrowserCommandResult<BrowserSettingsSnapshot>>;
}

export interface BotBrowserProfileInput {
  actorId?: string;
  globalMetaId: string;
}

export type BotBrowserProfileSnapshot = Record<string, unknown>;

export interface CreateBotBrowserHostServiceInput {
  listMetaApps: () => Promise<MetaAppRecord[]> | MetaAppRecord[];
  resolveMetaAppPin?: (pinId: string) => Promise<CoreBrowserCommandResult<MetaAppGalleryRecord>>;
  installCommunityMetaApp?: (sourcePinId: string) => Promise<CommunityMetaAppInstallResult>;
  resolveMetaAppUrl: (app: MetaAppRecord) => Promise<string>;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  nameAliasProviders?: BrowserNameAliasProvider[];
  ensNameAliasProviderFactory?: (config: {
    chainId: 1;
    rpcUrls: string[];
    textKey: string;
  }) => BrowserNameAliasProvider;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return null;
}

function normalizeUrl(value: unknown): string {
  return text(value).replace(/\/+$/u, '');
}

function normalizeUrlList(value: unknown): string[] {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  return rawItems
    .filter((item): item is string => typeof item === 'string')
    .map((item) => normalizeUrl(item))
    .filter(Boolean);
}

function normalizeMetaAppSourcePinId(sourcePinId: unknown): string {
  return typeof sourcePinId === 'string' ? sourcePinId.trim().toLowerCase() : '';
}

function canOpenMetaAppInBrowser(app: MetaAppRecord | null | undefined): boolean {
  return normalizeMetaAppSourcePinId(app?.sourcePinId) !== '';
}

function buildMetaAppBrowserUri(app: MetaAppRecord): string {
  const sourcePinId = normalizeMetaAppSourcePinId(app.sourcePinId);
  return sourcePinId ? `metaapp://${encodeURIComponent(sourcePinId)}` : '';
}

function browserRenderableUrl(value: unknown): string {
  const url = text(value);
  if (!url) return '';
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : '';
  } catch {
    return '';
  }
}

function codeContentReference(app: MetaAppRecord): string {
  const codePinId = text(app.codePinId);
  return codePinId ? `metafile://${codePinId}` : '';
}

function localMetaAppToBrowserRecord(
  app: MetaAppRecord,
  resolvedUrl: string,
): MetaAppGalleryRecord | null {
  if (!canOpenMetaAppInBrowser(app)) return null;
  const runUrl = browserRenderableUrl(resolvedUrl);
  if (!runUrl) return null;

  const sourcePinId = normalizeMetaAppSourcePinId(app.sourcePinId);
  const name = text(app.name) || sourcePinId;
  const ownerGlobalMetaId = text(app.creatorMetaId);
  const contentReference = codeContentReference(app);

  return {
    pinId: sourcePinId,
    firstPinId: sourcePinId,
    operation: 'local-installed',
    title: name,
    appName: name,
    prompt: text(app.prompt) || undefined,
    icon: text(app.icon) || undefined,
    coverImg: text(app.cover) || undefined,
    intro: text(app.description) || undefined,
    version: text(app.version) || '0.0.0',
    runtime: 'idbots-local',
    indexFile: text(app.entry) || 'index.html',
    code: contentReference,
    content: contentReference,
    contentType: 'text/html',
    codeType: contentReference ? 'application/zip' : 'text/html',
    tags: [],
    ownerGlobalMetaId,
    network: 'mvc',
    localUiUrl: runUrl,
    runUrl,
    updatedAt: Number.isFinite(app.updatedAt) ? app.updatedAt : Date.now(),
    source: text(app.sourceType) || 'idbots-local',
    raw: {
      app,
      browserUri: buildMetaAppBrowserUri(app),
    },
  };
}

function createInitialBrowserConfig(): BrowserConfigContainer {
  return {
    browser: {
      ...createDefaultBrowserConfig(),
      localMode: true,
    },
  };
}

function ensureLocalBrowserConfig(config: BrowserConfigContainer): BrowserConfigContainer {
  return {
    ...config,
    browser: {
      ...(config.browser ?? {}),
      localMode: true,
    },
  };
}

function toHostResult<T>(result: CoreBrowserCommandResult<T>): BrowserCommandResult<T> {
  if (result.ok) {
    return browserSuccess(result.data);
  }
  const failure = result as Exclude<CoreBrowserCommandResult<T>, { ok: true }>;
  return browserFailure(
    failure.code,
    failure.message,
    failure.data ? { data: failure.data } : undefined,
  );
}

function findMetaAppBySourcePinId(apps: MetaAppRecord[], sourcePinId: string): MetaAppRecord | undefined {
  return apps.find((candidate) => normalizeMetaAppSourcePinId(candidate.sourcePinId) === sourcePinId);
}

async function resolveLocalMetaAppRecord(
  input: CreateBotBrowserHostServiceInput,
  app: MetaAppRecord,
): Promise<CoreBrowserCommandResult<MetaAppGalleryRecord>> {
  try {
    const runUrl = await input.resolveMetaAppUrl(app);
    const record = localMetaAppToBrowserRecord(app, runUrl);
    if (!record) {
      return browserCommandFailed('browser_resolve_failed', 'MetaApp is not renderable in Bot Browser.');
    }
    return browserCommandSuccess(record);
  } catch (error) {
    return browserCommandFailed(
      'browser_resolve_failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function resolveMetaAppRecord(
  input: CreateBotBrowserHostServiceInput,
  pinId: string,
): Promise<CoreBrowserCommandResult<MetaAppGalleryRecord>> {
  const normalizedPinId = normalizeMetaAppSourcePinId(pinId);
  if (input.resolveMetaAppPin && normalizedPinId) {
    const cachedResult = await input.resolveMetaAppPin(normalizedPinId);
    if (cachedResult.ok) {
      return cachedResult;
    }
  }

  const apps = await input.listMetaApps();
  const localApp = findMetaAppBySourcePinId(apps, normalizedPinId);
  if (localApp) {
    return resolveLocalMetaAppRecord(input, localApp);
  }

  if (!input.installCommunityMetaApp || !normalizedPinId) {
    return browserCommandFailed('browser_resource_not_found', 'Resource not found.');
  }

  const installResult = await input.installCommunityMetaApp(normalizedPinId);
  if (!installResult?.success) {
    return browserCommandFailed(
      'browser_resource_not_found',
      installResult?.error || `MetaApp not found: ${normalizedPinId}`,
    );
  }

  const refreshedApps = await input.listMetaApps();
  const installedApp =
    findMetaAppBySourcePinId(refreshedApps, normalizedPinId) ||
    refreshedApps.find((candidate) => text(candidate.id) === text(installResult.appId));
  if (!installedApp) {
    return browserCommandFailed(
      'browser_resource_not_found',
      `MetaApp installed but local record was not found: ${normalizedPinId}`,
    );
  }

  return resolveLocalMetaAppRecord(input, installedApp);
}

function resolveHostBrowserConfig(
  config: BrowserConfigContainer,
  env: Record<string, string | undefined>,
): BrowserBaseConfig {
  const resolved = resolveBrowserConfig(config, env);
  const rawBrowser = objectRecord(config.browser);
  const rawNameResolution = objectRecord(rawBrowser?.nameResolution);
  const rawEns = objectRecord(rawNameResolution?.ens);

  const envNameResolutionEnabled = normalizeBoolean(env.METABOT_BROWSER_NAME_RESOLUTION_ENABLED);
  const envEnsEnabled = normalizeBoolean(env.METABOT_BROWSER_ENS_ENABLED);
  const envRpcUrls = normalizeUrlList(env.METABOT_BROWSER_ENS_RPC_URLS);

  const browserNameResolutionEnabled = typeof rawNameResolution?.enabled === 'boolean'
    ? rawNameResolution.enabled
    : null;
  const browserEnsEnabled = typeof rawEns?.enabled === 'boolean'
    ? rawEns.enabled
    : null;
  const explicitBrowserRpcUrls = rawEns && hasOwn(rawEns, 'rpcUrls')
    ? normalizeUrlList(rawEns.rpcUrls)
    : null;

  const explicitEmptyRpcUrls = env.METABOT_BROWSER_ENS_RPC_URLS !== undefined
    ? envRpcUrls.length === 0
    : Array.isArray(explicitBrowserRpcUrls) && explicitBrowserRpcUrls.length === 0;

  const nameResolutionEnabled = envNameResolutionEnabled
    ?? browserNameResolutionEnabled
    ?? resolved.nameResolution.enabled;
  const ensEnabledInput = envEnsEnabled
    ?? browserEnsEnabled
    ?? resolved.nameResolution.ens.enabled;
  const rpcUrls = explicitEmptyRpcUrls
    ? []
    : [...resolved.nameResolution.ens.rpcUrls];

  return {
    ...resolved,
    nameResolution: {
      enabled: nameResolutionEnabled,
      ens: {
        ...resolved.nameResolution.ens,
        enabled: nameResolutionEnabled && ensEnabledInput && rpcUrls.length > 0,
        rpcUrls,
      },
    },
  };
}

function createHostSettingsSnapshot(
  config: BrowserConfigContainer,
  env: Record<string, string | undefined>,
): BrowserSettingsSnapshot {
  const snapshot = createBrowserSettingsSnapshot({ config, env });
  const effective = resolveHostBrowserConfig(config, env);
  return {
    browser: { ...snapshot.browser },
    effectiveBrowser: {
      ...snapshot.effectiveBrowser,
      ...effective,
      nameResolution: {
        ...effective.nameResolution,
        ens: {
          ...effective.nameResolution.ens,
          rpcUrls: [...effective.nameResolution.ens.rpcUrls],
        },
      },
    },
    defaults: { ...snapshot.defaults },
    ...(snapshot.configPath ? { configPath: snapshot.configPath } : {}),
  };
}

function resolveFetch(fetchImpl: typeof fetch | undefined): typeof fetch | undefined {
  if (fetchImpl) return fetchImpl;
  return typeof globalThis.fetch === 'function'
    ? globalThis.fetch.bind(globalThis)
    : undefined;
}

function createNameAliasProviders(input: {
  configured: BrowserNameAliasProvider[] | undefined;
  ensNameAliasProviderFactory: CreateBotBrowserHostServiceInput['ensNameAliasProviderFactory'];
  config: BrowserBaseConfig;
}): BrowserNameAliasProvider[] {
  return createBrowserNameAliasProviders({
    configured: input.configured,
    config: input.config,
    ...(input.ensNameAliasProviderFactory
      ? { ensNameAliasProviderFactory: input.ensNameAliasProviderFactory }
      : {}),
  });
}

export function createBotBrowserHostService(
  input: CreateBotBrowserHostServiceInput,
): BotBrowserHostService {
  const env = input.env ?? process.env;
  const fetchImpl = resolveFetch(input.fetch);
  let browserConfig = createInitialBrowserConfig();

  return {
    async resolveResource(resolveInput) {
      const resolvedConfig = resolveHostBrowserConfig(browserConfig, env);
      const nameAliasProviders = createNameAliasProviders({
        configured: input.nameAliasProviders,
        ensNameAliasProviderFactory: input.ensNameAliasProviderFactory,
        config: resolvedConfig,
      });
      const result = await resolveBrowserResource({
        uri: resolveInput.uri,
        config: resolvedConfig,
        fetch: fetchImpl,
        nameAliasProviders,
        metaAppResolve: (pinId) => resolveMetaAppRecord(input, pinId),
      });
      return toHostResult(result);
    },

    async getProfile(profileInput) {
      const globalMetaId = text(profileInput.globalMetaId);
      if (!globalMetaId) {
        return browserFailure('missing_global_metaid', 'Browser info lookup requires a globalMetaId query parameter.');
      }
      if (!fetchImpl) {
        return browserFailure('browser_resolve_failed', 'A fetch implementation is required to resolve Browser profile info.');
      }

      const resolvedConfig = resolveHostBrowserConfig(browserConfig, env);
      const profile = await fetchBotProfileInfo({
        baseUrl: resolvedConfig.metasoP2PBaseUrl,
        globalMetaId,
        fetch: fetchImpl,
        metafileContentBaseUrl: resolvedConfig.metafileContentBaseUrl,
      });
      if (!profile) {
        return browserFailure('browser_resource_not_found', 'Browser profile info was not found.');
      }
      return browserSuccess(profile);
    },

    async getSettings(_settingsInput) {
      return browserSuccess(createHostSettingsSnapshot(browserConfig, env));
    },

    async updateSettings(settingsInput) {
      try {
        browserConfig = ensureLocalBrowserConfig(
          applyBrowserSettingsUpdate(browserConfig, settingsInput.browser),
        );
        return browserSuccess(createHostSettingsSnapshot(browserConfig, env));
      } catch (error) {
        return browserFailure(
          'invalid_browser_settings',
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
}
