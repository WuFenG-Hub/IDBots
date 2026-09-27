/**
 * Output-ceiling startup migration (old-user upgrade safety).
 *
 * Two waves, both rewriting provider model rows that still pin the legacy
 * 32_768 default (provider-model values take precedence over the
 * known-model catalog, so upgraded installs would keep the old ceiling
 * forever without this):
 *
 *  - DeepSeek V4 family rows: 32_768 -> 256_000 (parity with upstream
 *    deepseek-harness — see coworkModelLimits.ts).
 *  - Every OTHER row pinning exactly 32_768 (GLM family, uncatalogued
 *    SKUs): 32_768 -> 128_000 (mainstream models cap output far above 32K;
 *    thinking shares the budget, so the old default truncated long-thinking
 *    steps into paid auto-continues).
 *
 * A user-customized ceiling (any value other than the exact legacy default)
 * is left untouched. Idempotent: rows already migrated (or without an
 * explicit ceiling) are no-ops, so re-running on every startup is free.
 *
 * Deps are injected so the migration is unit-testable from compiled output
 * without a live sqlite store.
 */

import { isDeepSeekFamilyModelId } from '../libs/coworkModelLimits';

export const LEGACY_MAX_OUTPUT_TOKENS = 32_768;
export const MIGRATED_DEEPSEEK_MAX_OUTPUT_TOKENS = 256_000;
export const MIGRATED_DEFAULT_MAX_OUTPUT_TOKENS = 128_000;

type ModelRow = { id?: unknown; maxOutputTokens?: unknown };

interface MutableModelRow {
  id?: unknown;
  maxOutputTokens?: number;
}

export interface DeepSeekOutputCeilingMigrationAppConfig {
  model?: { availableModels?: unknown } | null;
  providers?: Record<string, { models?: unknown } | undefined | null> | null;
}

export interface DeepSeekOutputCeilingMigrationDeps {
  /** Read app_config; null/undefined when unavailable (migration no-ops). */
  getAppConfig: () => DeepSeekOutputCeilingMigrationAppConfig | null | undefined;
  /** Persist the rewritten app_config back to the kv store. */
  setAppConfig: (config: DeepSeekOutputCeilingMigrationAppConfig) => void;
  log?: (message: string) => void;
}

export interface DeepSeekOutputCeilingMigrationResult {
  /** Model rows rewritten from the legacy 32_768 default to 256_000. */
  migrated: number;
}

function isMutableModelRow(value: unknown): value is MutableModelRow {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** Rewrite one models array in place; returns the number of rows changed. */
function migrateModelRows(models: unknown): number {
  if (!Array.isArray(models)) return 0;
  let changed = 0;
  for (const row of models) {
    const model = row as ModelRow;
    if (!isMutableModelRow(model)) continue;
    if (model.maxOutputTokens !== LEGACY_MAX_OUTPUT_TOKENS) continue;
    if (typeof model.id !== 'string' || model.id.length === 0) continue;
    model.maxOutputTokens = isDeepSeekFamilyModelId(model.id)
      ? MIGRATED_DEEPSEEK_MAX_OUTPUT_TOKENS
      : MIGRATED_DEFAULT_MAX_OUTPUT_TOKENS;
    changed++;
  }
  return changed;
}

export function migrateDeepSeekOutputCeiling(
  deps: DeepSeekOutputCeilingMigrationDeps,
): DeepSeekOutputCeilingMigrationResult {
  const config = deps.getAppConfig();
  if (!config || typeof config !== 'object') return { migrated: 0 };

  let migrated = 0;
  const providers = config.providers;
  if (providers && typeof providers === 'object') {
    for (const provider of Object.values(providers)) {
      if (!provider || typeof provider !== 'object') continue;
      migrated += migrateModelRows(provider.models);
    }
  }
  if (config.model && typeof config.model === 'object') {
    migrated += migrateModelRows(config.model.availableModels);
  }

  if (migrated > 0) {
    deps.setAppConfig(config);
    deps.log?.(`[output-ceiling-migration] raised ${migrated} model row(s) from the legacy ${LEGACY_MAX_OUTPUT_TOKENS} default (DeepSeek family -> ${MIGRATED_DEEPSEEK_MAX_OUTPUT_TOKENS}, others -> ${MIGRATED_DEFAULT_MAX_OUTPUT_TOKENS})`)
  }
  return { migrated };
}
