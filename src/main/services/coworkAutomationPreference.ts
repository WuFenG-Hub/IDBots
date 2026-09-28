/**
 * Per-metabot switches for the 0.1.7 experimental automation backends:
 * browser automation (dsh-browser-use + Playwright MCP provider — one
 * headless Chromium per session, tools surface as mcp__playwright-mcp__*)
 * and desktop computer use (cua-driver native provider).
 *
 * Default ON for both (owner decision, 2026-09-28 — flips the original
 * per-bot opt-in): browser automation launches a real browser process per
 * DSH session and its tool schemas ride every request; computer use operates
 * the user's actual desktop and needs OS permission grants held by the host
 * app. An explicit '0' opts a bot out, and the app-scoped kill-switch below
 * remains the one-flip containment gate.
 *
 * Slot isolation: the backends mount at composition scope (runtime-wide), so
 * the DSH turn hub keys runtime slots by provider + automation combo
 * (dshRuntimeKeyOf). Sessions whose bot opted out never share a process with
 * an automation backend, and opting out re-pins the session onto the clean
 * slot on the very next turn — no runtime restart needed.
 */

import type { MetabotStore } from '../metabotStore';

/** metabot_settings keys; values are '1' (on, the default) / '0' (opt-out). */
export const COWORK_BROWSER_AUTOMATION_KEY = 'cowork.browserAutomation';
export const COWORK_COMPUTER_USE_KEY = 'cowork.computerUse';

/** App-scoped kv key for the fleet-wide kill-switch: '0'/false disables BOTH
 * backends for every bot regardless of the per-bot switches. Missing or
 * unparsable means allowed — with the per-bot defaults now ON, this gate is
 * the fleet-wide containment for a backend incident in one flip. */
export const EXPERIMENTAL_AUTOMATION_GLOBAL_KEY = 'automation.experimentalEnabled';

/** Minimal kv reader/writer shape shared by SqliteStore and test doubles. */
export interface ExperimentalAutomationStore {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}

export function isExperimentalAutomationAllowed(
  store: Pick<ExperimentalAutomationStore, 'get'> | null | undefined,
): boolean {
  try {
    const value = store?.get(EXPERIMENTAL_AUTOMATION_GLOBAL_KEY);
    return value !== '0' && value !== false;
  } catch {
    return true;
  }
}

export function setExperimentalAutomationAllowed(
  store: ExperimentalAutomationStore | null | undefined,
  allowed: boolean,
): void {
  try {
    store?.set(EXPERIMENTAL_AUTOMATION_GLOBAL_KEY, allowed ? '1' : '0');
  } catch {
    // Persistence loss is non-fatal; the next read falls back to allowed.
  }
}

/** Missing or unparsable records mean on — an explicit '0' opts the bot out. */
export function isCoworkBrowserAutomationEnabled(
  metabotStore: MetabotStore,
  metabotId: number | null | undefined,
): boolean {
  if (metabotId === null || metabotId === undefined) return false;
  return metabotStore.getMetabotSetting(metabotId, COWORK_BROWSER_AUTOMATION_KEY) !== '0';
}

export function isCoworkComputerUseEnabled(
  metabotStore: MetabotStore,
  metabotId: number | null | undefined,
): boolean {
  if (metabotId === null || metabotId === undefined) return false;
  return metabotStore.getMetabotSetting(metabotId, COWORK_COMPUTER_USE_KEY) !== '0';
}
