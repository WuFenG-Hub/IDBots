/**
 * Legacy llm_id value migration (old-user upgrade safety).
 *
 * The `metabots.llm_id` / `fallback_llm_id` columns changed meaning from
 * PROVIDER id (e.g. 'opencode', 'deepseek') to MODEL id (e.g.
 * 'deepseek-v4-flash'); existing installations still hold provider ids. This
 * one-shot startup migration rewrites those legacy values to the provider's
 * first/default model id, going through the MetabotStore update path (never
 * raw SQL) so in-memory state and the debounced sqlite save() stay consistent.
 *
 * Trade-off: the migration deliberately does NOT re-publish /info/llm pins —
 * that would burst paid on-chain writes on every old user's first launch.
 * Local normalization is enough for the bot to run; the next intentional edit
 * re-publishes the brain pin.
 *
 * Deps are injected so the migration is unit-testable from compiled output
 * against an in-memory sql.js database.
 */

import type { Metabot, MetabotUpdate } from '../types/metabot';

export interface LlmBrainMigrationProvider {
  enabled?: boolean;
  models?: Array<{ id?: string }>;
}

export interface LlmBrainMigrationAppConfig {
  model?: { defaultModel?: string };
  providers?: Record<string, LlmBrainMigrationProvider | undefined>;
}

export interface LlmBrainMigrationStore {
  listMetabots(): Metabot[];
  updateMetabot(id: number, input: MetabotUpdate): Metabot | null;
}

export interface LlmBrainMigrationDeps {
  metabotStore: LlmBrainMigrationStore;
  /** Read app_config (providers + model.defaultModel); null when unavailable. */
  getAppConfig: () => LlmBrainMigrationAppConfig | null | undefined;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface LlmBrainMigrationResult {
  /** Brain fields rewritten from a legacy provider key to a model id. */
  migrated: number;
  /** Brain fields already holding a model id (nothing to do). */
  alreadyNew: number;
  /** Brain fields left as-is because no enabled provider could map them. */
  unresolvable: number;
}

type BrainField = 'llm_id' | 'fallback_llm_id';

const PROVIDER_FIELD: Record<BrainField, 'llm_provider' | 'fallback_llm_provider'> = {
  llm_id: 'llm_provider',
  fallback_llm_id: 'fallback_llm_provider',
};

/**
 * True when `value` is already a model id offered by some configured provider
 * (enabled or not — a model-shaped value is never legacy, even if its provider
 * is currently disabled; resolution handles that case).
 */
function isKnownModelId(value: string, providers: Record<string, LlmBrainMigrationProvider | undefined>): boolean {
  for (const provider of Object.values(providers)) {
    if (provider?.models?.some((model) => model?.id === value)) return true;
  }
  return false;
}

/**
 * Find the enabled provider whose KEY equals `value` (case-insensitive) — the
 * legacy provider-id shape. Returns null when no enabled provider matches.
 */
function matchEnabledProviderKey(
  value: string,
  providers: Record<string, LlmBrainMigrationProvider | undefined>,
): { key: string; provider: LlmBrainMigrationProvider } | null {
  const needle = value.toLowerCase();
  for (const [key, provider] of Object.entries(providers)) {
    if (key.toLowerCase() === needle && provider?.enabled) {
      return { key, provider };
    }
  }
  return null;
}

/**
 * The model a legacy provider key resolves to, mirroring the resolution
 * Fallback-1 rule in claudeSettings.resolveMatchedProvider: the global default
 * model when that provider offers it, otherwise the provider's first model.
 */
function defaultModelForProvider(
  provider: LlmBrainMigrationProvider,
  appConfig: LlmBrainMigrationAppConfig,
): string | null {
  const models = (provider.models ?? []).filter((model) => typeof model?.id === 'string' && model.id);
  if (models.length === 0) return null;
  const defaultModel = appConfig.model?.defaultModel;
  if (defaultModel && models.some((model) => model.id === defaultModel)) {
    return defaultModel;
  }
  return models[0].id as string;
}

/**
 * Rewrite legacy provider-key brain values in `metabots` to model ids.
 * Idempotent: migrated rows hold model ids, so a second run migrates 0.
 * Unmappable values (provider disabled/absent, or plain garbage) are left
 * untouched with a warning — the resolution last-resort fallback keeps those
 * bots runnable.
 */
export function migrateLegacyLlmBrainValues(deps: LlmBrainMigrationDeps): LlmBrainMigrationResult {
  const log = deps.log ?? ((message: string) => console.log(message));
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const result: LlmBrainMigrationResult = { migrated: 0, alreadyNew: 0, unresolvable: 0 };

  const appConfig = deps.getAppConfig();
  const providers = appConfig?.providers ?? {};
  if (!appConfig || Object.keys(providers).length === 0) {
    // No provider config yet (fresh install / onboarding not done): nothing
    // can be mapped, and there is nothing legacy to fix either — new installs
    // write model ids from the start.
    log('[llm-brain-migration] skipped: no provider config available');
    return result;
  }

  for (const bot of deps.metabotStore.listMetabots()) {
    const update: MetabotUpdate = {};
    const changes: Array<{ field: BrainField; oldValue: string; newValue: string; providerKey: string }> = [];

    for (const field of ['llm_id', 'fallback_llm_id'] as BrainField[]) {
      const raw = bot[field];
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (!value) continue;

      if (isKnownModelId(value, providers)) {
        result.alreadyNew += 1;
        continue;
      }

      const match = matchEnabledProviderKey(value, providers);
      const newModel = match ? defaultModelForProvider(match.provider, appConfig) : null;
      if (!match || !newModel) {
        // Legacy value we cannot map (provider disabled/renamed, or no
        // models). Leave it; resolution's default-route fallback keeps the
        // bot runnable.
        result.unresolvable += 1;
        warn(
          `[llm-brain-migration] bot ${bot.id} (${bot.name}): ${field} '${value}' left as-is (no enabled provider matched)`,
        );
        continue;
      }

      update[field] = newModel;
      const providerField = PROVIDER_FIELD[field];
      const existingProvider = typeof bot[providerField] === 'string' ? bot[providerField]!.trim() : '';
      if (!existingProvider) {
        // Only fill an empty provider hint; an existing hint names the
        // provider the model was picked from and wins at resolution time.
        update[providerField] = match.key;
      }
      changes.push({ field, oldValue: value, newValue: newModel, providerKey: match.key });
    }

    if (changes.length > 0) {
      deps.metabotStore.updateMetabot(bot.id, update);
      for (const change of changes) {
        log(
          `[llm-brain-migration] bot ${bot.id} (${bot.name}): ${change.field} '${change.oldValue}' -> '${change.newValue}' (provider ${change.providerKey})`,
        );
        result.migrated += 1;
      }
    }
  }

  log(
    `[llm-brain-migration] done: ${result.migrated} migrated, ${result.alreadyNew} already-new, ${result.unresolvable} left as-is`,
  );
  return result;
}
