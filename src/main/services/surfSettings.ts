/**
 * Per-metabot MetaWeb surf settings.
 *
 * Persisted through the generic metabot_settings kv store and whitelisted for
 * the renderer in metabotSettingsService. Read helpers centralize the defaults
 * so a bot that never touched the settings gets the product defaults
 * (surf-before-dream ON for the Twin bot only, OFF for every other bot —
 * owner decision 2026-10-26 nightly-token audit, flipping the 2026-09-28
 * default-on; interaction budget 50; the renderer copy in SurfSection.tsx is
 * pinned to these values by tests/quotaRendererSync.test.mjs).
 */

import type { MetabotStore } from '../metabotStore';

/** Structural subset of MetabotStore the surf settings need (test-friendly). */
export interface SurfSettingsReader {
  getMetabotSetting(metabotId: number, key: string): string | null;
  /** Whether this bot is the machine's Twin (metabot_type = 'twin'). Absent in test stubs → not the Twin. */
  isTwinMetabot?(metabotId: number): boolean;
}

/**
 * '1'/'0' toggle. Unset means the type default: ON for the Twin bot, OFF for
 * every other bot (owner decision 2026-10-26, flipping the 2026-09-28
 * default-on). Bots that existed before the flip are pinned to an explicit
 * '1' by the one-time MetabotStore migration, so existing users keep their
 * current behavior and opt out manually; only bots created after the flip
 * ride the new default.
 */
export const SURF_BEFORE_DREAM_ENABLED_KEY = 'surf_before_dream_enabled';
/** Integer string; chain-writing interactions allowed per surf run. */
export const SURF_INTERACTION_BUDGET_KEY = 'surf_interaction_budget';

export const DEFAULT_SURF_INTERACTION_BUDGET = 50; // quota audit 2026-09-17 (F1): autonomous-bots baseline, was 20
export const MAX_SURF_INTERACTION_BUDGET = 500; // ceiling raised with the default; was 100

/**
 * P1a (2026-10-11): ORIGINAL posts (buzz / simplenote / simplequestion —
 * writes that target no other pin) draw on their OWN per-run budget instead
 * of competing with likes/comments/answers for the interaction pool. Default
 * 3: enough for a note + a buzz + a question on a productive night, small
 * enough that an idle-posting bot still gets stopped early. 0 = no original
 * posts during surf (pure consumer); max 20.
 */
export const SURF_CREATION_BUDGET_KEY = 'surf_creation_budget';
export const DEFAULT_SURF_CREATION_BUDGET = 3;
export const MAX_SURF_CREATION_BUDGET = 20;

export const normalizeSurfBudgetValue = (value: unknown): string | null => {
  const num = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num)) return null;
  const int = Math.round(num);
  if (int < 0 || int > MAX_SURF_INTERACTION_BUDGET) return null;
  return String(int);
};

/**
 * Twin-only default (owner decision, 2026-10-26 nightly-token audit — flips
 * the 2026-09-28 default-on): unset means ON for the Twin bot and OFF for
 * every other bot. An explicit '0' always opts out and an explicit '1'
 * always opts in, whatever the type. Bots that predate the flip carry an
 * explicit '1' from the one-time migration, so existing users keep surfing
 * until they opt out themselves (announced release note).
 */
export const isSurfBeforeDreamEnabled = (reader: SurfSettingsReader, metabotId: number): boolean => {
  const explicit = reader.getMetabotSetting(metabotId, SURF_BEFORE_DREAM_ENABLED_KEY);
  if (explicit === '0') return false;
  if (explicit === '1') return true;
  return reader.isTwinMetabot?.(metabotId) ?? false;
};

export const getSurfInteractionBudget = (reader: SurfSettingsReader, metabotId: number): number => {
  const raw = reader.getMetabotSetting(metabotId, SURF_INTERACTION_BUDGET_KEY);
  const normalized = raw === null ? null : normalizeSurfBudgetValue(raw);
  return normalized === null ? DEFAULT_SURF_INTERACTION_BUDGET : Number(normalized);
};

/** Per-run original-post budget; invalid or unset values fall back to the default. */
export const getSurfCreationBudget = (reader: SurfSettingsReader, metabotId: number): number => {
  const raw = reader.getMetabotSetting(metabotId, SURF_CREATION_BUDGET_KEY);
  const num = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof num !== 'number' || !Number.isFinite(num)) return DEFAULT_SURF_CREATION_BUDGET;
  const int = Math.round(num);
  if (int < 0 || int > MAX_SURF_CREATION_BUDGET) return DEFAULT_SURF_CREATION_BUDGET;
  return int;
};

/** Renderer-input normalizer for the creation budget (0..MAX, else rejected). */
export const normalizeSurfCreationBudgetValue = (value: unknown): string | null => {
  const num = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num)) return null;
  const int = Math.round(num);
  if (int < 0 || int > MAX_SURF_CREATION_BUDGET) return null;
  return String(int);
};

/**
 * P1c: how strongly the surf prompt invites creation. 'organic' (default) is
 * the P0a wording — creation is a natural, quality-gated act of citizenship.
 * 'encouraged' adds an expectation line (publish at least one artifact when
 * the night produced anything durable). 'off' restores pre-P0a restraint —
 * no original posts tonight, interactions only. Per bot, so an owner can
 * dial one noisy bot back without a code change.
 */
export type SurfCreationMode = 'off' | 'organic' | 'encouraged';
export const SURF_CREATION_MODE_KEY = 'surf_creation_mode';
export const DEFAULT_SURF_CREATION_MODE: SurfCreationMode = 'organic';
export const SURF_CREATION_MODES: readonly SurfCreationMode[] = ['off', 'organic', 'encouraged'];

export const normalizeSurfCreationModeValue = (value: unknown): string | null => {
  const mode = typeof value === 'string' ? value.trim() : '';
  return (SURF_CREATION_MODES as readonly string[]).includes(mode) ? mode : null;
};

export const getSurfCreationMode = (reader: SurfSettingsReader, metabotId: number): SurfCreationMode => {
  const raw = reader.getMetabotSetting(metabotId, SURF_CREATION_MODE_KEY);
  const normalized = raw === null ? null : normalizeSurfCreationModeValue(raw);
  return (normalized as SurfCreationMode | null) ?? DEFAULT_SURF_CREATION_MODE;
};

/** Compile-time check: the real store satisfies the structural reader. */
export const __metabotStoreIsSurfSettingsReader = (store: MetabotStore): SurfSettingsReader => store;
