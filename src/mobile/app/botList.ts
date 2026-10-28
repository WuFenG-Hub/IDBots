/**
 * Pure presentation helpers for the Me → MetaBot list (UI-UX batch 2026-10-28).
 *
 * Sorting contract (owner-approved): the Twin Bot always ranks first; the
 * remaining Bots follow `created_at` ascending (earliest second, newest last).
 * Missing/invalid `created_at` is treated as Infinity — a dirty row never
 * jumps ahead of a well-dated one. Ties keep insertion order (stable sort of
 * Array.prototype, documented in the unit test).
 */
import type { MobileMetabot } from '../bridge/types';

function createdAtValue(bot: MobileMetabot): number {
  const value = bot.created_at;
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

/**
 * Returns a NEW array sorted for display; the input array is never mutated,
 * so callers keep the roster order intact for other consumers.
 */
export function sortBotsForList(bots: readonly MobileMetabot[]): MobileMetabot[] {
  return [...bots].sort((a, b) => {
    const aTwin = a.metabot_type === 'twin' ? 0 : 1;
    const bTwin = b.metabot_type === 'twin' ? 0 : 1;
    if (aTwin !== bTwin) return aTwin - bTwin;
    const byCreated = createdAtValue(a) - createdAtValue(b);
    if (byCreated !== 0) return byCreated;
    return 0;
  });
}

/** Avatar fallback letter: first letter/number character, else '?'. */
export function avatarInitial(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  const match = trimmed.match(/\p{L}|\p{N}/u);
  return match ? match[0] : '?';
}
