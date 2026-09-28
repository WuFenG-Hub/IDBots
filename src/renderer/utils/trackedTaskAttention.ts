/**
 * "Tracked tasks that need the owner" — the number behind the amber dots on the
 * sidebar's 跟踪任务 entry and the 长期任务 tab.
 *
 * The board's cards carry a read-time derived `column`; a card parked in
 * `waiting_owner` (待拍板) is a task whose next step is the OWNER's, so it must
 * be visible without opening the tab: the Twin asking for a decision must never
 * be something the owner could miss.
 *
 * Pure module (no React / electron / i18n imports) so it is unit-testable and
 * can be called from any view. MetaTask alerts are the next contributor to this
 * signal — the shape below is already the fold-in point (see `metaTask`), it is
 * simply not wired yet.
 */

import type { LongTermBoard } from '../types/longTermTask';

export interface TrackedTasksAttention {
  /** Long-term board cards waiting on an owner decision. */
  longTerm: number;
  /**
   * Reserved for MetaTask alerts that need the owner (task tab, P2). Always 0
   * until that read path is wired — kept in the shape so consumers already read
   * one combined number.
   */
  metaTask: number;
  /** What the badges show. */
  total: number;
}

/** Structural input: only the slices the derivation reads. */
export interface TrackedTasksAttentionInput {
  longTermTask: { board: LongTermBoard | null };
}

/** Cards parked in the owner-decision column. */
export const countLongTermTasksAwaitingOwner = (board: LongTermBoard | null): number =>
  (board?.cards ?? []).filter((card) => card.column === 'waiting_owner').length;

/**
 * The combined "needs the owner" count. Callers memoize on the board identity
 * (useMemo) so the returned object never re-renders them on unrelated store
 * traffic.
 */
export const selectTrackedTasksNeedingAttention = (
  state: TrackedTasksAttentionInput,
): TrackedTasksAttention => {
  const longTerm = countLongTermTasksAwaitingOwner(state.longTermTask?.board ?? null);
  const metaTask = 0;
  return { longTerm, metaTask, total: longTerm + metaTask };
};
