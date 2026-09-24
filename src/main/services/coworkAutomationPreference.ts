/**
 * Per-metabot switches for the 0.1.7 experimental automation backends:
 * browser automation (dsh-browser-use + Playwright MCP provider — one
 * headless Chromium per session, tools surface as mcp__playwright-mcp__*)
 * and desktop computer use (cua-driver native provider).
 *
 * Default OFF for both: browser automation launches a real browser process
 * per DSH session and its tool schemas ride every request; computer use
 * operates the user's actual desktop and needs OS permission grants held by
 * the host app. Neither should ever be a fleet-wide default.
 *
 * DSH caveat (same as cowork.mountMcpTools): cowork sessions share one DSH
 * runtime per provider slot and the providers mount at composition scope, so
 * once ANY bot on a slot opts in, the backend activates for every session on
 * that slot until the runtime restarts. The toggle still guarantees the
 * default fleet-wide behavior when no bot opts in.
 */

import type { MetabotStore } from '../metabotStore';

/** metabot_settings keys; values are '1' (enable) / '0' (off, the default). */
export const COWORK_BROWSER_AUTOMATION_KEY = 'cowork.browserAutomation';
export const COWORK_COMPUTER_USE_KEY = 'cowork.computerUse';

/** Missing or unparsable records mean off — automation is per-bot opt-in. */
export function isCoworkBrowserAutomationEnabled(
  metabotStore: MetabotStore,
  metabotId: number | null | undefined,
): boolean {
  if (metabotId === null || metabotId === undefined) return false;
  return metabotStore.getMetabotSetting(metabotId, COWORK_BROWSER_AUTOMATION_KEY) === '1';
}

export function isCoworkComputerUseEnabled(
  metabotStore: MetabotStore,
  metabotId: number | null | undefined,
): boolean {
  if (metabotId === null || metabotId === undefined) return false;
  return metabotStore.getMetabotSetting(metabotId, COWORK_COMPUTER_USE_KEY) === '1';
}
