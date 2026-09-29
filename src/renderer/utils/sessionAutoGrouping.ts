/**
 * Delegated-task session folding for the bot-home sidebar's local-chats list.
 *
 * The app creates sessions on its own — [长期] long-term task runs,
 * [编排任务] / [Orchestration Task] delegation runs, [定时] scheduled-task runs.
 * Main stamps `auto_origin` on those rows (CoworkStore.setSessionAutoOrigin) and
 * the summary carries it as `autoOrigin`. The sidebar folds SOME of them into a
 * collapsed "Delegated Tasks" (委派任务) section per the policy below;
 * scheduled-task runs are deliberately NOT folded — they are usually the user's
 * own automations, and their one-session-per-fire cadence belongs in the main
 * list the user watches.
 *
 * The folder is named for what the rows ARE to the owner — runs the app
 * delegated on their behalf — while the `autoOrigin` field keeps naming the
 * creation fact (who created the session).
 *
 * Pure module (no React / i18n / electron imports) so it can be unit-tested with
 * tsx directly, mirroring sessionViewGrouping.ts.
 */

import type { CoworkSessionSummary } from '../types/cowork';

/** The two halves of a local-chats list after folding. */
export interface SessionsByDelegatedFold {
  /** Human-initiated sessions (plus scheduled-task runs) — the visible main list. */
  humanSessions: CoworkSessionSummary[];
  /** Folded delegated sessions — the collapsed "Delegated Tasks" fold. */
  autoSessions: CoworkSessionSummary[];
}

/**
 * Whether the app created this session on its own. Only a real marker counts:
 * `null` (and legacy rows, whose field is `undefined`) is human-initiated.
 * This is the creation FACT; whether the session actually folds is the policy
 * in shouldFoldIntoDelegatedTasks (plus any manual override on the row).
 */
export const isAutoCreatedSession = (
  session: Pick<CoworkSessionSummary, 'autoOrigin'>,
): boolean => session.autoOrigin != null;

/** Origins that collapse into the Delegated Tasks fold. Everything else — human
 * rows and 'schedule' runs alike — stays in the main list. */
const FOLDED_AUTO_ORIGINS: ReadonlySet<NonNullable<CoworkSessionSummary['autoOrigin']>> = new Set([
  'longterm',
  'orchestration',
]);

/** Fold policy: only long-term task runs and orchestration delegations fold. */
export const shouldFoldIntoDelegatedTasks = (
  session: Pick<CoworkSessionSummary, 'autoOrigin'>,
): boolean => session.autoOrigin != null && FOLDED_AUTO_ORIGINS.has(session.autoOrigin);

/**
 * Fold MEMBERSHIP: a manual placement wins over the policy — 'in' parks the row
 * in the fold whatever its origin, 'out' keeps an auto-created run in the main
 * list. With no manual placement (null/undefined, the state of every row that
 * the user never moved) the auto-origin policy decides.
 */
export const isInDelegatedFold = (
  session: Pick<CoworkSessionSummary, 'autoOrigin' | 'foldOverride'>,
): boolean => {
  if (session.foldOverride === 'in') return true;
  if (session.foldOverride === 'out') return false;
  return shouldFoldIntoDelegatedTasks(session);
};

/**
 * Split sessions into the main list and the delegated fold, preserving input
 * order in both halves (the caller owns ordering; this helper never re-sorts).
 */
export const splitSessionsByDelegatedFold = (
  sessions: readonly CoworkSessionSummary[],
): SessionsByDelegatedFold => {
  const humanSessions: CoworkSessionSummary[] = [];
  const autoSessions: CoworkSessionSummary[] = [];
  for (const session of sessions) {
    (isInDelegatedFold(session) ? autoSessions : humanSessions).push(session);
  }
  return { humanSessions, autoSessions };
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
