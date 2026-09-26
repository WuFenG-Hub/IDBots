/**
 * One-shot DeepSeek output-ceiling migration (old-user upgrade safety).
 *
 * The DeepSeek V4 family's declared output ceiling moved from the legacy
 * 32_768 default to 256_000 (parity with upstream deepseek-harness — see
 * coworkModelLimits.ts). Provider rows seeded by earlier versions carry
 * `maxOutputTokens: 32768` explicitly, and provider-model values take
 * precedence over the known-model catalog, so upgraded installs would keep
 * the 32K ceiling forever without this rewrite.
 *
 * The migration walks `app_config.providers[*].models[*]` and
 * `app_config.model.availableModels[*]` and rewrites `maxOutputTokens`
 * 32_768 → 256_000 ONLY for DeepSeek-family model ids whose value still
 * equals the legacy default — a user-customized ceiling (any other value)
 * is left untouched. Idempotent: rows already at 256_000 (or absent) are
 * no-ops, so re-running on every startup is free.
 *
 * Deps are injected so the migration is unit-testable from compiled output
 * without a live sqlite store.
 */

import { isDeepSeekFamilyModelId } from '../libs/coworkModelLimits';

export const LEGACY_DEEPSEEK_MAX_OUTPUT_TOKENS = 32_768;
export const MIGRATED_DEEPSEEK_MAX_OUTPUT_TOKENS = 256_000;

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
    if (
      typeof model.id === 'string'
      && isDeepSeekFamilyModelId(model.id)
      && model.maxOutputTokens === LEGACY_DEEPSEEK_MAX_OUTPUT_TOKENS
    ) {
      model.maxOutputTokens = MIGRATED_DEEPSEEK_MAX_OUTPUT_TOKENS;
      changed++;
    }
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
    deps.log?.(`[deepseek-output-ceiling-migration] raised ${migrated} DeepSeek model row(s) from ${LEGACY_DEEPSEEK_MAX_OUTPUT_TOKENS} to ${MIGRATED_DEEPSEEK_MAX_OUTPUT_TOKENS}`);
  }
  return { migrated };
}
