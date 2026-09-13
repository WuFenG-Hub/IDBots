/**
 * Per-metabot MetaWeb surf settings.
 *
 * Persisted through the generic metabot_settings kv store and whitelisted for
 * the renderer in metabotSettingsService. Read helpers centralize the defaults
 * so a bot that never touched the settings gets the product defaults
 * (surf-before-dream OFF — opt-in, interaction budget 20).
 */

import type { MetabotStore } from '../metabotStore';

/** Structural subset of MetabotStore the surf settings need (test-friendly). */
export interface SurfSettingsReader {
  getMetabotSetting(metabotId: number, key: string): string | null;
}

/** '1'/'0' toggle; unset means OFF (default) — nightly surfing is opt-in per bot. */
export const SURF_BEFORE_DREAM_ENABLED_KEY = 'surf_before_dream_enabled';
/** Integer string; chain-writing interactions allowed per surf run. */
export const SURF_INTERACTION_BUDGET_KEY = 'surf_interaction_budget';

export const DEFAULT_SURF_INTERACTION_BUDGET = 20;
export const MAX_SURF_INTERACTION_BUDGET = 100;

export const normalizeSurfBudgetValue = (value: unknown): string | null => {
  const num = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num)) return null;
  const int = Math.round(num);
  if (int < 0 || int > MAX_SURF_INTERACTION_BUDGET) return null;
  return String(int);
};

/**
 * Default OFF (opt-in): only an explicit '1' enables pre-dream surfing. Every
 * nightly surf spends LLM tokens and gas, so a bot that never touched the
 * toggle stays off (owner decision, 2026-09-14); an explicit '1'/'0' always
 * wins — users who turned it on keep it on.
 */
export const isSurfBeforeDreamEnabled = (reader: SurfSettingsReader, metabotId: number): boolean =>
  reader.getMetabotSetting(metabotId, SURF_BEFORE_DREAM_ENABLED_KEY) === '1';

export const getSurfInteractionBudget = (reader: SurfSettingsReader, metabotId: number): number => {
  const raw = reader.getMetabotSetting(metabotId, SURF_INTERACTION_BUDGET_KEY);
  const normalized = raw === null ? null : normalizeSurfBudgetValue(raw);
  return normalized === null ? DEFAULT_SURF_INTERACTION_BUDGET : Number(normalized);
};

/** Compile-time check: the real store satisfies the structural reader. */
export const __metabotStoreIsSurfSettingsReader = (store: MetabotStore): SurfSettingsReader => store;
