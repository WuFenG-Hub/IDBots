/**
 * Autonomous-task session folding for the bot-home sidebar's local-chats list.
 *
 * The app creates sessions on its own — [长期] long-term task runs,
 * [编排任务] / [Orchestration Task] delegation runs, [定时] scheduled-task runs.
 * Main stamps `auto_origin` on those rows (CoworkStore.setSessionAutoOrigin) and
 * the summary carries it as `autoOrigin`. The sidebar sorts the local list
 * into three sections per the placement policy below:
 *
 * - the MAIN list — sessions the human initiated (no auto marker, or a
 *   manual 'out' fold placement);
 * - 待跟进任务 (Follow-Up Tasks) — auto-created sessions that currently need a
 *   human decision or reply (followUpState 'pending', or a live board decision
 *   owed on the session), rendered above the fold;
 * - 自主任务 (Autonomous Tasks) — auto-created sessions that need no human
 *   follow-up, collapsed; opened only for post-hoc review.
 *
 * A session's bucket is not fixed at creation: main re-judges followUpState at
 * every turn end (cerebellum gate, AskUserQuestion bridge, owner moves), so a
 * row moves between Follow-Up and Autonomous as the session progresses.
 *
 * The folder is named for HOW those rows run — the Twin Bot drives them
 * autonomously, without the owner in the loop — while the `autoOrigin` field
 * keeps naming the creation fact (who created the session).
 *
 * Pure module (no React / i18n / electron imports) so it can be unit-tested with
 * tsx directly, mirroring sessionViewGrouping.ts.
 */

import type { CoworkSessionSummary } from '../types/cowork';

/** The two halves of a local-chats list after folding. */
export interface SessionsByAutonomousFold {
  /** Human-initiated sessions — the visible main list. */
  humanSessions: CoworkSessionSummary[];
  /** Folded autonomous sessions — the collapsed "Autonomous Tasks" fold. */
  autoSessions: CoworkSessionSummary[];
}

/** The three sections of a local-chats list: main, follow-up, autonomous fold. */
export interface SessionsWithFollowUpSplit {
  /** Human-initiated sessions — the visible main list. */
  humanSessions: CoworkSessionSummary[];
  /** Sessions awaiting a human decision or reply — the "Follow-Up Tasks" section. */
  followUpSessions: CoworkSessionSummary[];
  /** Folded autonomous sessions — the collapsed "Autonomous Tasks" fold. */
  autoSessions: CoworkSessionSummary[];
}

/**
 * Whether the app created this session on its own. Only a real marker counts:
 * `null` (and legacy rows, whose field is `undefined`) is human-initiated.
 * This is the creation FACT; whether the session actually folds is the policy
 * in shouldFoldIntoAutonomousTasks (plus any manual override on the row).
 */
export const isAutoCreatedSession = (
  session: Pick<CoworkSessionSummary, 'autoOrigin'>,
): boolean => session.autoOrigin != null;

/** Origins that collapse into the Autonomous Tasks fold — every machine-started
 * run kind. Human rows (no marker) are everything else and stay in the main
 * list. */
const FOLDED_AUTO_ORIGINS: ReadonlySet<NonNullable<CoworkSessionSummary['autoOrigin']>> = new Set([
  'longterm',
  'orchestration',
  'schedule',
]);

/** Fold policy: every machine-started run (long-term, orchestration, scheduled) folds. */
export const shouldFoldIntoAutonomousTasks = (
  session: Pick<CoworkSessionSummary, 'autoOrigin'>,
): boolean => session.autoOrigin != null && FOLDED_AUTO_ORIGINS.has(session.autoOrigin);

/**
 * FOLLOW-UP MEMBERSHIP: a session belongs in the "Follow-Up Tasks" section
 * when main has persisted followUpState 'pending' on the row (cerebellum
 * turn-end gate, AskUserQuestion bridge, or a manual owner move) OR when the
 * caller reports a live decision owed on it (`decisionPending` — the
 * board-derived waiting_owner verdicts). The live set is what covers existing
 * sessions that predate the persisted column.
 */
export const isInFollowUpSection = (
  session: Pick<CoworkSessionSummary, 'followUpState'>,
  decisionPending: boolean,
): boolean => session.followUpState === 'pending' || decisionPending;

/**
 * Three-way split of the local-chats list, in placement precedence order
 * (spec §3.1):
 *  1. `foldOverride` 'in' → Autonomous fold, 'out' → main list (a manual
 *     placement always wins, in either direction);
 *  2. follow-up pending (persisted marker or a live board decision) → the
 *     Follow-Up section;
 *  3. auto-origin policy → Autonomous fold;
 *  4. everything else → main list.
 *
 * Input order is preserved in every bucket (the caller owns ordering; this
 * helper never re-sorts).
 */
export const splitSessionsWithFollowUp = (
  sessions: readonly CoworkSessionSummary[],
  decisionSessionIds?: ReadonlySet<string>,
): SessionsWithFollowUpSplit => {
  const humanSessions: CoworkSessionSummary[] = [];
  const followUpSessions: CoworkSessionSummary[] = [];
  const autoSessions: CoworkSessionSummary[] = [];
  for (const session of sessions) {
    if (session.foldOverride === 'in') {
      autoSessions.push(session);
    } else if (session.foldOverride === 'out') {
      humanSessions.push(session);
    } else if (isInFollowUpSection(session, decisionSessionIds?.has(session.id) ?? false)) {
      followUpSessions.push(session);
    } else if (shouldFoldIntoAutonomousTasks(session)) {
      autoSessions.push(session);
    } else {
      humanSessions.push(session);
    }
  }
  return { humanSessions, followUpSessions, autoSessions };
};

/** The three sidebar sections a local-chats row can sit in. */
export type SessionSidebarSection = 'autonomous' | 'follow-up' | 'normal';

/**
 * Which sidebar section the row renders in right now — the same precedence as
 * splitSessionsWithFollowUp, per row: a manual fold placement wins ('in' →
 * the fold, 'out' → the main list), then the follow-up marker or a live board
 * decision, then the auto-origin policy, then the main list. This is what the
 * row menu's "Move to…" submenu marks as the current section (the no-op
 * target) and what the move handler compares against.
 */
export const resolveSessionSidebarSection = (
  session: Pick<CoworkSessionSummary, 'autoOrigin' | 'foldOverride' | 'followUpState'>,
  decisionPending: boolean,
): SessionSidebarSection => {
  if (session.foldOverride === 'in') return 'autonomous';
  if (session.foldOverride === 'out') return 'normal';
  if (isInFollowUpSection(session, decisionPending)) return 'follow-up';
  if (shouldFoldIntoAutonomousTasks(session)) return 'autonomous';
  return 'normal';
};

/**
 * Per-row fold membership. `decisionPending` is the caller-resolved answer of
 * "is this session currently owed an owner verdict" (the list looks the row up
 * in its decision set once and hands the row a plain boolean, so memoized rows
 * compare cheap). Same precedence as isInAutonomousFold.
 */
export const isInAutonomousFoldWithDecision = (
  session: Pick<CoworkSessionSummary, 'autoOrigin' | 'foldOverride'>,
  decisionPending: boolean,
): boolean => {
  if (session.foldOverride === 'in') return true;
  if (session.foldOverride === 'out') return false;
  if (decisionPending) return false;
  return shouldFoldIntoAutonomousTasks(session);
};

/**
 * Fold MEMBERSHIP: a manual placement wins over the policy — 'in' parks the row
 * in the fold whatever its origin, 'out' keeps an auto-created run in the main
 * list. With no manual placement (null/undefined, the state of every row that
 * the user never moved) the auto-origin policy decides.
 *
 * `decisionSessionIds` (optional) holds the sessions currently owed an owner
 * verdict — long-term sub-projects parked in waiting_owner. Those sessions are
 * the DECISION SURFACE: with no manual placement they leave the fold and show
 * on the main timeline (a verdict buried in the collapsed folder is how a
 * finished task nags for days). Derived live from the board, so the row folds
 * back the moment the verdict lands; a manual placement still wins over it.
 */
export const isInAutonomousFold = (
  session: Pick<CoworkSessionSummary, 'id' | 'autoOrigin' | 'foldOverride'>,
  decisionSessionIds?: ReadonlySet<string>,
): boolean => isInAutonomousFoldWithDecision(session, decisionSessionIds?.has(session.id) ?? false);

/**
 * Split sessions into the main list and the autonomous fold, preserving input
 * order in both halves (the caller owns ordering; this helper never re-sorts).
 *
 * Legacy TWO-WAY view: decision-owed sessions (the follow-up bucket of
 * splitSessionsWithFollowUp) ride the main list here, exactly as they did
 * before the Follow-Up section existed. The sidebar's local tab uses the
 * three-way splitSessionsWithFollowUp instead; this variant remains for
 * callers that have no follow-up section.
 */
export const splitSessionsByAutonomousFold = (
  sessions: readonly CoworkSessionSummary[],
  decisionSessionIds?: ReadonlySet<string>,
): SessionsByAutonomousFold => {
  const { humanSessions, followUpSessions, autoSessions } = splitSessionsWithFollowUp(
    sessions,
    decisionSessionIds,
  );
  return { humanSessions: [...humanSessions, ...followUpSessions], autoSessions };
};

/**
 * localStorage key remembering whether the fold is open. The fold is collapsed
 * by default (it is a folder of machine-started runs, not the user's
 * conversations), so only an explicit '1' opens it.
 *
 * The KEY NAME and its stored value are frozen at the pre-rename spelling
 * ('coworkAutoTasksExpanded'): it is deployed user state, and renaming it would
 * silently reset every install's fold preference back to collapsed.
 */
export const AUTO_TASKS_EXPANDED_STORAGE_KEY = 'coworkAutoTasksExpanded';

/** Parse the persisted fold preference; anything but '1' means collapsed. */
export const parseAutoTasksExpandedPreference = (stored: string | null): boolean => stored === '1';

/** Value to persist for the fold preference. */
export const serializeAutoTasksExpandedPreference = (expanded: boolean): string =>
  expanded ? '1' : '0';

/**
 * localStorage key remembering whether the "Follow-Up Tasks" section is open.
 * Same frozen-key contract as the Autonomous fold: the section is collapsed by
 * default (only an explicit '1' opens it), and once shipped the key name and
 * its stored value must never change — renaming it would silently reset every
 * install's preference.
 */
export const FOLLOW_UP_EXPANDED_STORAGE_KEY = 'coworkFollowUpExpanded';

/** Parse the persisted Follow-Up preference; anything but '1' means collapsed. */
export const parseFollowUpExpandedPreference = (stored: string | null): boolean => stored === '1';

/** Value to persist for the Follow-Up preference. */
export const serializeFollowUpExpandedPreference = (expanded: boolean): string =>
  expanded ? '1' : '0';
