import type { SqliteStore } from '../sqliteStore';
import type { LlmRelayModelInfo, LlmRelayQuotaInfo } from './llmRelayService';
import {
  isFreeProviderConfigured,
  LLM_FREE_PROVIDER_KEY,
  planFreeProviderCatalogSync,
} from '../../renderer/services/llmFreeQuotaGate.js';

export const RELAY_CATALOG_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

type AppConfig = Record<string, any>;

export type RelayCatalogRefreshResult =
  | { status: 'updated'; modelCount: number }
  | { status: 'unchanged'; modelCount: number }
  | { status: 'skipped'; reason: 'store-unavailable' | 'provider-unconfigured' | 'credential-changed' };

export interface RelayCatalogFreshnessDeps {
  getStore: () => SqliteStore | null;
  getQuota: (input: { apiKey: string; forceRefresh: boolean }) => Promise<LlmRelayQuotaInfo>;
  onChanged: () => void;
}

export function createRelayCatalogRefresh(deps: RelayCatalogFreshnessDeps): () => Promise<RelayCatalogRefreshResult> {
  let queue: Promise<void> = Promise.resolve();

  return () => {
    const run = queue.then(async (): Promise<RelayCatalogRefreshResult> => {
      const store = deps.getStore();
      if (!store) return { status: 'skipped', reason: 'store-unavailable' };
      const initial = (store.get<AppConfig>('app_config') ?? {}) as AppConfig;
      const initialProvider = initial.providers?.[LLM_FREE_PROVIDER_KEY];
      if (!isFreeProviderConfigured(initialProvider)) {
        return { status: 'skipped', reason: 'provider-unconfigured' };
      }
      const credential = initialProvider.apiKey as string;
      const quota = await deps.getQuota({ apiKey: credential, forceRefresh: true });

      const current = (store.get<AppConfig>('app_config') ?? {}) as AppConfig;
      const provider = current.providers?.[LLM_FREE_PROVIDER_KEY];
      if (!isFreeProviderConfigured(provider) || provider.apiKey !== credential) {
        return { status: 'skipped', reason: 'credential-changed' };
      }
      const models = planFreeProviderCatalogSync(provider, quota.models as LlmRelayModelInfo[]);
      const nextModels = models ?? provider.models;
      const defaultNeedsRepair = current.model?.defaultProvider === LLM_FREE_PROVIDER_KEY
        && !nextModels.some((model: { id?: string }) => model.id === current.model?.defaultModel)
        && typeof nextModels[0]?.id === 'string';
      if (!models && !defaultNeedsRepair) {
        return { status: 'unchanged', modelCount: nextModels.length };
      }

      store.set('app_config', {
        ...current,
        providers: {
          ...(current.providers ?? {}),
          [LLM_FREE_PROVIDER_KEY]: {
            ...provider,
            models: nextModels,
          },
        },
        model: {
          ...(current.model ?? {}),
          ...(defaultNeedsRepair ? { defaultModel: nextModels[0].id } : {}),
        },
      });
      deps.onChanged();
      return { status: 'updated', modelCount: nextModels.length };
    });
    queue = run.then(
      () => {},
      () => {},
    );
    return run;
  };
}
