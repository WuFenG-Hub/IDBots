/**
 * Shared model catalog for model+effort pickers.
 *
 * Lists every usable provider from app_config — built-in AND custom-*
 * providers added on the Settings > Models page — together with that
 * provider's models. This replaces the static ALL_PROVIDER_KEYS iteration the
 * MetaBot brain selectors used, which silently hid custom providers.
 *
 * The effort vocabulary mirrors src/main/libs/llmEffort.ts (off/low/high/max,
 * null = model default). Keep the two in sync.
 */

import type { AppConfig } from '../config';
import { providerRequiresApiKey } from './llmConnection';

export type LlmEffortLevel = 'off' | 'low' | 'high' | 'max';

export const LLM_EFFORT_LEVELS: readonly LlmEffortLevel[] = ['off', 'low', 'high', 'max'];

export function isLlmEffortLevel(value: unknown): value is LlmEffortLevel {
  return typeof value === 'string' && (LLM_EFFORT_LEVELS as readonly string[]).includes(value);
}

export interface CatalogModelEntry {
  /** Model id (wire value). */
  id: string;
  /** Display name. */
  name: string;
}

export interface CatalogProviderGroup {
  /** Provider key (e.g. 'deepseek', 'custom-my-relay'). */
  id: string;
  /** Display label. */
  name: string;
  models: CatalogModelEntry[];
}

interface ProviderModelLike {
  id?: string;
  name?: string;
}

interface ProviderLikeConfig {
  enabled?: boolean;
  apiKey?: string;
  name?: string;
  models?: ProviderModelLike[];
}

const capitalizeKey = (key: string) => key.charAt(0).toUpperCase() + key.slice(1);

/**
 * Build the picker catalog from an app config: providers that are enabled,
 * have a usable credential, and expose at least one model. Pure so it can be
 * unit-tested without the config service.
 */
export function buildModelGroupsFromConfig(config: Pick<AppConfig, 'providers'>): CatalogProviderGroup[] {
  const providers = (config.providers ?? {}) as Record<string, ProviderLikeConfig>;
  const groups: CatalogProviderGroup[] = [];
  for (const [key, provider] of Object.entries(providers)) {
    if (!provider?.enabled) continue;
    if (providerRequiresApiKey(key) && !(provider.apiKey ?? '').trim()) continue;
    const models = (provider.models ?? [])
      .filter((model) => typeof model?.id === 'string' && model.id.trim())
      .map((model) => ({ id: model.id, name: (model.name ?? '').trim() || model.id }));
    if (models.length === 0) continue;
    groups.push({
      id: key,
      name: (provider.name ?? '').trim() || capitalizeKey(key),
      models,
    });
  }
  return groups;
}

/**
 * Resolve the concrete provider+model backing a stored MetaBot brain value.
 *
 * A brain may hold a model id (new semantic) or a legacy provider key. For a
 * legacy provider key the provider's current default model (global default
 * when that provider serves it, else its first model) is reported so the edit
 * UI can display what the bot actually runs. Returns null when the value
 * matches nothing in the catalog (e.g. provider removed).
 */
export function resolveBrainModelInGroups(
  groups: CatalogProviderGroup[],
  modelId: string | null | undefined,
  providerHint?: string | null,
  globalDefaultModel?: string | null,
): { providerKey: string; model: CatalogModelEntry } | null {
  const requested = modelId?.trim();
  if (!requested) return null;

  // Exact model-id match, preferring the stored provider hint.
  const findExact = (groupFilter?: string) => {
    for (const group of groups) {
      if (groupFilter && group.id !== groupFilter) continue;
      const model = group.models.find((m) => m.id === requested);
      if (model) return { providerKey: group.id, model };
    }
    return null;
  };
  const exact = findExact(providerHint?.trim() || undefined) ?? findExact();
  if (exact) return exact;

  // Legacy provider-key value: that provider's default model.
  const key = requested.toLowerCase();
  const byProviderKey = groups.find((group) => group.id.toLowerCase() === key);
  if (byProviderKey) {
    const model = globalDefaultModel && byProviderKey.models.some((m) => m.id === globalDefaultModel)
      ? byProviderKey.models.find((m) => m.id === globalDefaultModel)!
      : byProviderKey.models[0];
    return { providerKey: byProviderKey.id, model };
  }
  return null;
}

/** Map a legacy five-step effort value onto the current four-step ladder. */
export function convertLegacyEffortLevel(value: unknown): LlmEffortLevel | null {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'off' || normalized === 'high' || normalized === 'max') return normalized;
  if (normalized === 'low' || normalized === 'minimal') return 'off';
  if (normalized === 'medium') return 'low';
  if (normalized === 'xhigh') return 'max';
  return null;
}
