/**
 * Per-metabot MetaWeb surf settings.
 *
 * Persisted through the generic metabot_settings kv store and whitelisted for
 * the renderer in metabotSettingsService. Read helpers centralize the defaults
 * so a bot that never touched the settings gets the product defaults
 * (surf-before-dream ON, interaction budget 20).
 */

import type { MetabotStore } from '../metabotStore';

/** '1'/'0' toggle; unset means ON (default). */
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

/** Default ON: only an explicit '0' disables pre-dream surfing. */
export const isSurfBeforeDreamEnabled = (metabotStore: MetabotStore, metabotId: number): boolean =>
  metabotStore.getMetabotSetting(metabotId, SURF_BEFORE_DREAM_ENABLED_KEY) !== '0';

export const getSurfInteractionBudget = (metabotStore: MetabotStore, metabotId: number): number => {
  const raw = metabotStore.getMetabotSetting(metabotId, SURF_INTERACTION_BUDGET_KEY);
  const normalized = raw === null ? null : normalizeSurfBudgetValue(raw);
  return normalized === null ? DEFAULT_SURF_INTERACTION_BUDGET : Number(normalized);
};
