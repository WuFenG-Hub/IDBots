import {
  applyBrowserSettingsUpdate,
  createBrowserSettingsSnapshot,
  createDefaultBrowserConfig,
  resolveBrowserConfig,
  resolveBrowserResource,
  type BrowserConfigContainer,
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
  type BrowserTrustedActionResult,
} from '@openagentinternet/agent-browser-host-contract';
import type { MetaAppRecord } from '../../types/metaApp';
import type { Metabot } from '../../types/metabot';
import { parseLocalMetabotActorId } from './botBrowserIntent.js';
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
  resolveMetaAppUrl: (app: MetaAppRecord) => Promise<string>;
  openConversation: (request: BotBrowserConversationRequest) => Promise<void>;
  fetch?: typeof fetch;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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

  return {
    ...action,
    kind: 'open-conversation',
    payload: {
      ...payload,
      peerGlobalMetaId,
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

function peerGlobalMetaIdFromPayload(payload: Record<string, unknown> | undefined): string {
  return (
    text(payload?.peerGlobalMetaId) ||
    text(payload?.targetGlobalMetaId) ||
    text(payload?.to)
  );
}

function normalizeMetaAppUri(value: string): string {
  const match = value.match(/^metaapp:\/\/(.+)$/iu);
  if (!match) return value;
  const pinId = normalizeMetaAppSourcePinId(match[1]);
  return pinId ? `metaapp://${pinId}` : value;
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
          cacheManagement: false,
          templateSettings: true,
          walletLogin: false,
        },
        labels: {
          actorChip: 'MetaBot',
          noActorTitle: 'No local MetaBot available',
          noActorBody: 'Create or restore a local MetaBot before using IDBots Browser actions.',
          noActorAction: {
            label: 'Create MetaBot',
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
        metaAppLookup: async (pinId) => {
          const normalizedPinId = normalizeMetaAppSourcePinId(pinId);
          const apps = await input.listMetaApps();
          const app = apps.find((candidate) => {
            return normalizeMetaAppSourcePinId(candidate.sourcePinId) === normalizedPinId;
          });
          if (!app) return null;

          const runUrl = await input.resolveMetaAppUrl(app);
          return localMetaAppToBrowserRecord(app, runUrl);
        },
      });

      if (!result.ok) {
        return result;
      }

      return {
        ...result,
        data: normalizeResolveResultActions(normalizeMetaAppResolveResult(result.data)),
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
      return browserSuccess({});
    },

    async clearCache(
      _cacheInput: BrowserCacheClearInput,
    ): Promise<BrowserCommandResult<BrowserCacheClearResult>> {
      return browserSuccess({});
    },

    async runTrustedAction(
      actionInput: BrowserTrustedActionInput,
    ): Promise<BrowserCommandResult<BrowserTrustedActionResult>> {
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
          return browserFailure('browser_action_missing_actor', 'A local MetaBot actor is required.');
        }
        if (parseLocalMetabotActorId(actorId) === null) {
          return browserFailure('browser_action_invalid_actor', 'The selected actor is not a local IDBots MetaBot.');
        }

        const peerGlobalMetaId = peerGlobalMetaIdFromPayload(actionInput.payload);
        if (!peerGlobalMetaId) {
          return browserFailure('browser_action_missing_peer', 'A peer GlobalMetaID is required.');
        }

        await input.openConversation({
          actionKind: actionInput.kind,
          actorId,
          resourceUri: actionInput.resourceUri,
          peerGlobalMetaId,
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
