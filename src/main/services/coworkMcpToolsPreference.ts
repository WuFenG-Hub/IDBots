/**
 * Per-metabot switch controlling whether cowork sessions mount the user's
 * configured MCP servers.
 *
 * Default OFF: every mounted MCP tool's schema rides every LLM request, and
 * a typical MCP set (GitHub/Playwright/Tavily) adds tens of thousands of
 * characters to a session's very first request, so MCP mounting is opt-in
 * per bot rather than a global default.
 *
 * DSH caveat: cowork sessions share one DSH runtime whose MCP tools register
 * at composition scope, so once ANY bot mounts MCP servers the tools stay
 * visible to all live DSH sessions until the runtime restarts. The toggle
 * still guarantees the default fleet-wide behavior when no bot opts in.
 */

import type { MetabotStore } from '../metabotStore';

/** metabot_settings key; values are '1' (mount) / '0' (skip, the default). */
export const COWORK_MOUNT_MCP_TOOLS_KEY = 'cowork.mountMcpTools';

/** Missing or unparsable records mean off — MCP mounting is per-bot opt-in. */
export function isCoworkMcpMountEnabled(
  metabotStore: MetabotStore,
  metabotId: number | null | undefined,
): boolean {
  if (metabotId === null || metabotId === undefined) return false;
  return metabotStore.getMetabotSetting(metabotId, COWORK_MOUNT_MCP_TOOLS_KEY) === '1';
}
