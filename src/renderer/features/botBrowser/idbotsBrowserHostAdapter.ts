import {
  applyBrowserSettingsUpdate,
  browserCommandFailed,
  browserCommandSuccess,
  createBrowserSettingsSnapshot,
  createDefaultBrowserConfig,
  resolveBrowserConfig,
  resolveBrowserResource,
  type BrowserCommandResult as CoreBrowserCommandResult,
  type BrowserConfigContainer,
  type MetaAppGalleryRecord,
} from '@openagentinternet/agent-browser-core';
import {
  browserFailure,
  browserSuccess,
  type BrowserCacheClearInput,
  type BrowserCacheClearResult,
  type BrowserCacheInput,
  type BrowserCacheSnapshot,
  type BrowserCommandResult,
  type BrowserHostAdapter,
  type BrowserResolveAction,
  type BrowserResolveInput,
  type BrowserResolveResult,
  type BrowserRuntimeInput,
  type BrowserRuntimeSnapshot,
  type BrowserSettingsInput,
  type BrowserSettingsSnapshot,
  type BrowserSettingsUpdateInput,
  type BrowserTrustedActionInput,
  type BrowserTrustedActionKind,
  type BrowserTrustedActionResult,
} from '@openagentinternet/agent-browser-host-contract';
import type {
  CommunityMetaAppInstallResult,
  MetaAppRecord,
} from '../../types/metaApp';
import type { Metabot } from '../../types/metabot';
import {
  normalizeBrowserGlobalMetaId,
  parseLocalMetabotActorId,
} from './botBrowserIntent.js';
import {
  metabotsToBrowserActors,
  selectDefaultBrowserActor,
} from './idbotsBrowserActorModel.js';
import {
  localMetaAppToBrowserRecord,
  normalizeMetaAppSourcePinId,
} from './metaAppBrowserModel.js';
import type { BotBrowserConversationRequest } from './types';

export interface IdBotsBrowserHostAdapterInput {
  listMetabots: () => Promise<Metabot[]>;
  listMetaApps: () => Promise<MetaAppRecord[]>;
  resolveMetaAppPin?: (pinId: string) => Promise<CoreBrowserCommandResult<MetaAppGalleryRecord>>;
  installCommunityMetaApp?: (sourcePinId: string) => Promise<CommunityMetaAppInstallResult>;
  resolveMetaAppUrl: (app: MetaAppRecord) => Promise<string>;
  getMetaAppCache?: () => Promise<BrowserCommandResult<BrowserCacheSnapshot>>;
  clearMetaAppCache?: (input: BrowserCacheClearInput) => Promise<BrowserCommandResult<BrowserCacheClearResult>>;
  writeMetaIdPin?: (input: BotBrowserBridgeTrustedActionRequest) => Promise<BrowserCommandResult<unknown>>;
  uploadMetaFile?: (input: BotBrowserBridgeTrustedActionRequest) => Promise<BrowserCommandResult<unknown>>;
  openConversation: (request: BotBrowserConversationRequest) => Promise<void>;
  fetch?: typeof fetch;
}

export interface BotBrowserBridgeTrustedActionRequest {
  actorId?: string;
  resourceUri: string;
  payload?: unknown;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingIpcHandlerError(error: unknown, channel: string): boolean {
  const message = errorMessage(error);
  return message.includes('No handler registered') && message.includes(channel);
}

function safeBridgeMessage(value: unknown, fallback: string): string {
  const message = text(value);
  if (!message) return fallback;
  if (/ipc|handler|channel|route|stack|file:|\/Users\/|\\Users\\/iu.test(message)) {
    return fallback;
  }
  return message;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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

function normalizeResolveAction(
  action: BrowserResolveAction,
  result: BrowserResolveResult,
): BrowserResolveAction | null {
  if (action.kind === 'service-call' || action.kind === 'service-list') {
    return null;
  }
  if (action.kind !== 'private-chat') {
    return action;
  }

  const payload = action.payload ?? {};
  const peerGlobalMetaId =
    text(payload.peerGlobalMetaId) ||
    text(payload.targetGlobalMetaId) ||
    text(payload.to) ||
    text(result.owner.globalMetaId);
  const conversationUri = conversationUriFromPayload(payload, peerGlobalMetaId);

  return {
    ...action,
    kind: 'open-conversation',
    payload: {
      ...payload,
      peerGlobalMetaId,
      conversationUri,
    },
  };
}

function normalizeResolveResultActions(result: BrowserResolveResult): BrowserResolveResult {
  return {
    ...result,
    actions: result.actions
      .map((action) => normalizeResolveAction(action, result))
      .filter((action): action is BrowserResolveAction => Boolean(action)),
  };
}

function isServiceSection(section: unknown): boolean {
  const record = objectRecord(section);
  return text(record?.id) === 'services' || text(record?.kind) === 'services';
}

function removeUnsupportedServiceRendererData(result: BrowserResolveResult): BrowserResolveResult {
  const rendererData = objectRecord(result.renderer.data);
  if (!rendererData) {
    return result;
  }

  const nextData: Record<string, unknown> = { ...rendererData };
  delete nextData.services;
  if (Array.isArray(nextData.sections)) {
    nextData.sections = nextData.sections.filter((section) => !isServiceSection(section));
  }

  return {
    ...result,
    renderer: {
      ...result.renderer,
      data: nextData,
    },
  };
}

function peerGlobalMetaIdFromPayload(payload: Record<string, unknown> | undefined): string {
  return (
    text(payload?.peerGlobalMetaId) ||
    text(payload?.targetGlobalMetaId) ||
    text(payload?.to)
  );
}

function buildConversationUri(peerGlobalMetaId: string): string {
  return `map://simplemsg/conversation?peer=${encodeURIComponent(peerGlobalMetaId)}`;
}

function conversationUriFromPayload(
  payload: Record<string, unknown> | undefined,
  peerGlobalMetaId: string,
): string {
  return text(payload?.conversationUri) || buildConversationUri(peerGlobalMetaId);
}

function hasUsableLocalMetabot(metabots: Metabot[], localMetabotId: number): boolean {
  return metabots.some((metabot) => {
    return metabot.id === localMetabotId && normalizeBrowserGlobalMetaId(metabot.globalmetaid) !== '';
  });
}

function normalizeMetaAppUri(value: string): string {
  const match = value.match(/^metaapp:\/\/(.+)$/iu);
  if (!match) return value;
  const pinId = normalizeMetaAppSourcePinId(match[1]);
  return pinId ? `metaapp://${pinId}` : value;
}

function findMetaAppBySourcePinId(apps: MetaAppRecord[], sourcePinId: string): MetaAppRecord | undefined {
  return apps.find((candidate) => {
    return normalizeMetaAppSourcePinId(candidate.sourcePinId) === sourcePinId;
  });
}

function trustedActionSuccess(
  kind: BrowserTrustedActionKind,
  data: unknown,
): BrowserCommandResult<BrowserTrustedActionResult> {
  return browserSuccess({
    kind,
    handled: true,
    data,
  } as BrowserTrustedActionResult);
}

function trustedActionFailureFromResult(
  result: BrowserCommandResult<unknown>,
  fallbackCode: string,
  fallbackMessage: string,
): BrowserCommandResult<BrowserTrustedActionResult> {
  return browserFailure(
    text((result as { code?: unknown }).code) || fallbackCode,
    safeBridgeMessage((result as { message?: unknown }).message, fallbackMessage),
  );
}

async function runBridgeTrustedAction(
  invoke: (input: BotBrowserBridgeTrustedActionRequest) => Promise<BrowserCommandResult<unknown>>,
  input: BotBrowserBridgeTrustedActionRequest,
  kind: BrowserTrustedActionKind,
  ipcChannel: string,
  fallbackCode: string,
  fallbackMessage: string,
): Promise<BrowserCommandResult<BrowserTrustedActionResult>> {
  try {
    const result = await invoke(input);
    if (!result.ok) {
      return trustedActionFailureFromResult(result, fallbackCode, fallbackMessage);
    }
    return trustedActionSuccess(kind, result.data);
  } catch (error) {
    if (isMissingIpcHandlerError(error, ipcChannel)) {
      return browserFailure(
        'unsupported_method',
        kind === ('metaid-pin-write' as BrowserTrustedActionKind)
          ? 'MetaID PIN write is not supported in this IDBots build.'
          : 'MetaFile upload is not supported in this IDBots build.',
      );
    }
    return browserFailure(fallbackCode, fallbackMessage);
  }
}

async function resolveLocalMetaAppRecord(
  input: IdBotsBrowserHostAdapterInput,
  app: MetaAppRecord,
): Promise<CoreBrowserCommandResult<MetaAppGalleryRecord>> {
  try {
    const runUrl = await input.resolveMetaAppUrl(app);
    const record = localMetaAppToBrowserRecord(app, runUrl) as MetaAppGalleryRecord | null;
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
  input: IdBotsBrowserHostAdapterInput,
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

function normalizeMetaAppResolveResult(result: BrowserResolveResult): BrowserResolveResult {
  if (result.resourceType !== 'metaapp') {
    return result;
  }

  return {
    ...result,
    normalizedUri: normalizeMetaAppUri(result.normalizedUri),
    actions: result.actions.map((action) => ({
      ...action,
      uri: action.uri ? normalizeMetaAppUri(action.uri) : action.uri,
    })),
  };
}

function createContractSettingsSnapshot(config: BrowserConfigContainer): BrowserSettingsSnapshot {
  const snapshot = createBrowserSettingsSnapshot({ config });
  return {
    browser: { ...snapshot.browser },
    effectiveBrowser: { ...snapshot.effectiveBrowser },
    defaults: { ...snapshot.defaults },
  };
}

export function createIdbotsBrowserHostAdapter(
  input: IdBotsBrowserHostAdapterInput,
): BrowserHostAdapter {
  let browserConfig = createInitialBrowserConfig();

  return {
    async getRuntime(_runtimeInput?: BrowserRuntimeInput): Promise<BrowserCommandResult<BrowserRuntimeSnapshot>> {
      const metabots = await input.listMetabots();
      return browserSuccess({
        host: { kind: 'idbots', name: 'IDBots', localMode: true },
        actors: metabotsToBrowserActors(metabots),
        defaultActor: selectDefaultBrowserActor(metabots),
        defaultUri: null,
        features: {
          privateChat: true,
          serviceCall: false,
          cacheManagement: true,
          templateSettings: true,
          walletLogin: false,
        },
        labels: {
          actorChip: 'Bot',
          noActorTitle: 'No Bot available',
          noActorBody: 'Create or restore a local Bot before using IDBots Browser actions.',
          noActorAction: {
            label: 'Create Bot',
            actionKind: 'open-settings',
          },
        },
      });
    },

    async resolveResource(
      resolveInput: BrowserResolveInput,
    ): Promise<BrowserCommandResult<BrowserResolveResult>> {
      const result = await resolveBrowserResource({
        uri: resolveInput.uri,
        config: resolveBrowserConfig(browserConfig),
        fetch: input.fetch,
        metaAppResolve: (pinId) => resolveMetaAppRecord(input, pinId),
      });

      if (!result.ok) {
        return result;
      }

      return {
        ...result,
        data: removeUnsupportedServiceRendererData(
          normalizeResolveResultActions(normalizeMetaAppResolveResult(result.data)),
        ),
      };
    },

    async getSettings(_settingsInput?: BrowserSettingsInput): Promise<BrowserCommandResult<BrowserSettingsSnapshot>> {
      return browserSuccess(createContractSettingsSnapshot(browserConfig));
    },

    async updateSettings(
      settingsInput: BrowserSettingsUpdateInput,
    ): Promise<BrowserCommandResult<BrowserSettingsSnapshot>> {
      try {
        browserConfig = ensureLocalBrowserConfig(
          applyBrowserSettingsUpdate(browserConfig, settingsInput.browser),
        );
        return browserSuccess(createContractSettingsSnapshot(browserConfig));
      } catch (error) {
        return browserFailure(
          'invalid_browser_settings',
          error instanceof Error ? error.message : String(error),
        );
      }
    },

    async getCache(_cacheInput?: BrowserCacheInput): Promise<BrowserCommandResult<BrowserCacheSnapshot>> {
      if (input.getMetaAppCache) {
        try {
          return await input.getMetaAppCache();
        } catch (error) {
          const message = errorMessage(error);
          if (isMissingIpcHandlerError(error, 'botBrowser:getMetaAppCache')) {
            return browserSuccess({
              cacheRoot: null,
              unavailable: true,
              error: message,
            });
          }
          return browserFailure('browser_cache_unavailable', message);
        }
      }
      return browserSuccess({});
    },

    async clearCache(
      cacheInput: BrowserCacheClearInput,
    ): Promise<BrowserCommandResult<BrowserCacheClearResult>> {
      if (input.clearMetaAppCache) {
        try {
          return await input.clearMetaAppCache(cacheInput);
        } catch (error) {
          return browserFailure('browser_cache_unavailable', errorMessage(error));
        }
      }
      return browserSuccess({});
    },

    async runTrustedAction(
      actionInput: BrowserTrustedActionInput,
    ): Promise<BrowserCommandResult<BrowserTrustedActionResult>> {
      const actionKind = text(actionInput.kind);
      if (actionKind === 'metaid-pin-write') {
        if (!input.writeMetaIdPin) {
          return browserFailure(
            'unsupported_method',
            'MetaID PIN write is not supported in this IDBots build.',
          );
        }
        return runBridgeTrustedAction(
          input.writeMetaIdPin,
          {
            actorId: text(actionInput.actorId) || undefined,
            resourceUri: actionInput.resourceUri,
            payload: actionInput.payload,
          },
          actionInput.kind,
          'botBrowser:writeMetaIdPin',
          'pin_write_failed',
          'MetaID PIN write failed.',
        );
      }

      if (actionKind === 'metafile-upload') {
        if (!input.uploadMetaFile) {
          return browserFailure(
            'unsupported_method',
            'MetaFile upload is not supported in this IDBots build.',
          );
        }
        return runBridgeTrustedAction(
          input.uploadMetaFile,
          {
            actorId: text(actionInput.actorId) || undefined,
            resourceUri: actionInput.resourceUri,
            payload: actionInput.payload,
          },
          actionInput.kind,
          'botBrowser:uploadMetaFile',
          'upload_failed',
          'MetaFile upload failed.',
        );
      }

      if (actionInput.kind === 'copy-uri') {
        return browserSuccess({
          kind: actionInput.kind,
          handled: true,
          data: {
            copiedText:
              text(actionInput.payload?.uri) ||
              text(actionInput.payload?.currentUri) ||
              actionInput.resourceUri,
          },
        });
      }

      if (actionInput.kind === 'open-conversation' || actionInput.kind === 'private-chat') {
        const actorId = text(actionInput.actorId);
        if (!actorId) {
          return browserFailure('browser_action_missing_actor', 'A local Bot actor is required.');
        }
        const localMetabotId = parseLocalMetabotActorId(actorId);
        if (localMetabotId === null) {
          return browserFailure('browser_action_invalid_actor', 'The selected actor is not an available local Bot.');
        }
        const metabots = await input.listMetabots();
        if (!hasUsableLocalMetabot(metabots, localMetabotId)) {
          return browserFailure('browser_action_invalid_actor', 'The selected actor is not an available local Bot.');
        }

        const peerGlobalMetaId = normalizeBrowserGlobalMetaId(
          peerGlobalMetaIdFromPayload(actionInput.payload),
        );
        if (!peerGlobalMetaId) {
          return browserFailure('browser_action_missing_peer', 'A peer GlobalMetaID is required.');
        }
        const conversationUri = conversationUriFromPayload(actionInput.payload, peerGlobalMetaId);

        await input.openConversation({
          actionKind: actionInput.kind,
          actorId,
          resourceUri: actionInput.resourceUri,
          peerGlobalMetaId,
          conversationUri,
          peerName: text(actionInput.payload?.peerName) || undefined,
          peerAvatar: text(actionInput.payload?.peerAvatar) || undefined,
        });

        return browserSuccess({
          kind: actionInput.kind,
          handled: true,
          data: { message: 'Conversation opened in IDBots.' },
        });
      }

      return browserFailure(
        'browser_action_not_supported',
        `IDBots Browser does not support ${actionInput.kind}.`,
      );
    },
  };
}
