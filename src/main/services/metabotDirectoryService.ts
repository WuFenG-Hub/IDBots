/**
 * Local MetaBot directory: sanitized read model for the twin bot's planning
 * (roster with profiles). Used by the /api/idbots/list-metabots RPC endpoint
 * and unit-testable without the RPC server closure.
 */

import type { MetabotStore } from '../metabotStore';

export interface MetabotDirectoryEntry {
  id: number;
  name: string;
  bio: string | null;
  role: string | null;
  goal: string | null;
  /** Structured worker position slug (dev/researcher/...); null = unset/twin. */
  position: string | null;
  metabot_type: string;
  enabled: boolean;
  globalmetaid: string | null;
}

function toTrimmedOrNull(value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  return text || null;
}

/** All local metabots (including disabled ones), trimmed strings, nullable profile fields. */
export function buildMetabotDirectory(metabotStore: MetabotStore): MetabotDirectoryEntry[] {
  return metabotStore.listMetabots().map((metabot) => ({
    id: metabot.id,
    name: (metabot.name ?? '').trim(),
    bio: toTrimmedOrNull(metabot.bio ?? metabot.background),
    role: toTrimmedOrNull(metabot.role),
    goal: toTrimmedOrNull(metabot.goal),
    position: toTrimmedOrNull(metabot.position),
    metabot_type: metabot.metabot_type,
    enabled: Boolean(metabot.enabled),
    globalmetaid: toTrimmedOrNull(metabot.globalmetaid),
  }));
}
