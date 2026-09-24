/**
 * Renderer-facing per-metabot settings bridge.
 *
 * Whitelist-restricted wrapper around MetabotStore.getMetabotSetting /
 * setMetabotSetting so the IPC layer never exposes the raw metabot_settings kv
 * store: keys not listed in RENDERER_SETTING_DEFS are rejected, and every
 * whitelisted key declares how renderer-supplied values are normalized before
 * persisting.
 */

import type { MetabotStore } from '../metabotStore';
import { OPENTEAM_ALLOW_REMOTE_COLLAB_KEY } from './openTeamGuestService';
import { COWORK_MOUNT_MCP_TOOLS_KEY } from './coworkMcpToolsPreference';
import { COWORK_BROWSER_AUTOMATION_KEY, COWORK_COMPUTER_USE_KEY } from './coworkAutomationPreference';
import {
  SURF_BEFORE_DREAM_ENABLED_KEY,
  SURF_INTERACTION_BUDGET_KEY,
  normalizeSurfBudgetValue,
} from './surfSettings';

/** Boolean toggle settings are persisted as '1' (on) / '0' (off). */
const normalizeToggleValue = (value: unknown): string | null => {
  if (value === true || value === '1' || value === 1) return '1';
  if (value === false || value === '0' || value === 0) return '0';
  return null;
};

interface RendererSettingDef {
  /** Returns the normalized value to persist, or null when the input is invalid. */
  normalizeValue: (value: unknown) => string | null;
}

/** Per-metabot settings the renderer may read/write over IPC. */
const RENDERER_SETTING_DEFS: Record<string, RendererSettingDef> = {
  [OPENTEAM_ALLOW_REMOTE_COLLAB_KEY]: { normalizeValue: normalizeToggleValue },
  [COWORK_MOUNT_MCP_TOOLS_KEY]: { normalizeValue: normalizeToggleValue },
  [COWORK_BROWSER_AUTOMATION_KEY]: { normalizeValue: normalizeToggleValue },
  [COWORK_COMPUTER_USE_KEY]: { normalizeValue: normalizeToggleValue },
  [SURF_BEFORE_DREAM_ENABLED_KEY]: { normalizeValue: normalizeToggleValue },
  [SURF_INTERACTION_BUDGET_KEY]: { normalizeValue: normalizeSurfBudgetValue },
};

export const RENDERER_METABOT_SETTING_KEYS: readonly string[] = Object.keys(RENDERER_SETTING_DEFS);

const resolveRendererSettingDef = (key: unknown): { key: string; def: RendererSettingDef } => {
  const normalizedKey = typeof key === 'string' ? key.trim() : '';
  const def = normalizedKey ? RENDERER_SETTING_DEFS[normalizedKey] : undefined;
  if (!def) {
    throw new Error(`Setting key is not allowed: ${normalizedKey || '(empty)'}`);
  }
  return { key: normalizedKey, def };
};

/** Read one whitelisted per-metabot setting (null when never written). */
export function getRendererMetabotSetting(
  metabotStore: MetabotStore,
  metabotId: number,
  key: unknown,
): string | null {
  const { key: normalizedKey } = resolveRendererSettingDef(key);
  return metabotStore.getMetabotSetting(metabotId, normalizedKey);
}

/** Write one whitelisted per-metabot setting; returns the normalized stored value. */
export function setRendererMetabotSetting(
  metabotStore: MetabotStore,
  metabotId: number,
  key: unknown,
  value: unknown,
): string {
  const { key: normalizedKey, def } = resolveRendererSettingDef(key);
  const normalizedValue = def.normalizeValue(value);
  if (normalizedValue === null) {
    throw new Error(`Invalid value for setting ${normalizedKey}`);
  }
  return metabotStore.setMetabotSetting(metabotId, normalizedKey, normalizedValue);
}
