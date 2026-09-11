/**
 * Work-source collection for the sleep guard.
 *
 * Why this module exists: `src/main/sleepGuard.ts` is the pure policy (which
 * sources are active -> engage/release), and `src/main/main.ts` owns the live
 * getters. This module is the seam between them — a dependency-injected
 * collector with per-source fault isolation, so that
 *
 *   1. one broken work source can never take down the guard or the app's
 *      main process (a throwing getter degrades to "no work from that source",
 *      reported through `onError`), and
 *   2. the collection contract is unit-testable without an Electron runtime.
 *
 * Coverage contract (see the acceptance matrix in the sleep-guard work): a
 * work source must be a bounded unit of work the user is waiting on — never a
 * long-lived daemon. Long-lived daemons (p2p indexer, MCP skill servers, the
 * local MetaApp server, chat listeners) are deliberately excluded: they run
 * for the whole app session, so treating them as work would hold the OS sleep
 * assertion permanently.
 */
import type { SleepGuardSource, SleepGuardWorkInput } from './sleepGuard';

/** A group-task daemon turn key, as the daemon's own map is keyed. */
export interface SleepGuardGroupTaskTurnLike {
  taskId: number;
  metabotId: number;
}

/**
 * Minimal shape of the getters the main process injects. Deliberately a plain
 * interface (no service imports) so tests and the real-host check can drive the
 * collector with fakes and the module stays free of runtime side effects.
 */
export interface SleepGuardWorkSourceGetters {
  /** `CoworkRunner.getActiveSessionIds()` — every running cowork session. */
  getActiveCoworkSessionIds(): readonly string[];
  /** `Scheduler.getActiveTaskIds()` — scheduled tasks executing right now. */
  getActiveScheduledTaskIds(): readonly string[];
  /** `DreamService.getDreamingBotIds()` — bots consolidating a dream now. */
  getDreamingMetabotIds(): readonly number[];
  /** `getGroupTaskTurnActivity()` — group-task daemon turns in flight. */
  getGroupTaskTurns(): readonly SleepGuardGroupTaskTurnLike[];
  /** `getActiveGroupChatReplyTaskIds()` — group-chat replies in flight. */
  getActiveGroupChatReplyTaskIds(): readonly string[];
  /** `getActiveA2AReplyTaskIds()` — online private-chat replies in flight. */
  getActiveA2AReplyTaskIds(): readonly string[];
}

/**
 * Map group-task turns to their stable `taskId:metabotId` keys. Group-task
 * turns are the only work source that is not naturally a list of string ids.
 */
export function groupTaskTurnIdsOf(turns: readonly SleepGuardGroupTaskTurnLike[]): string[] {
  return turns.map((turn) => `${turn.taskId}:${turn.metabotId}`);
}

/**
 * Collect the current work input from the injected getters.
 *
 * Every getter is isolated: a throw (or a non-array return) from one source is
 * reported through `onError` and yields an empty list for that source, so the
 * remaining sources still drive the guard.
 */
export function collectSleepGuardWorkFrom(
  getters: SleepGuardWorkSourceGetters,
  onError: (source: SleepGuardSource, error: unknown) => void = () => {},
): SleepGuardWorkInput {
  const readList = <T>(source: SleepGuardSource, read: () => readonly T[]): T[] => {
    try {
      const value = read();
      if (Array.isArray(value)) return [...value];
      onError(source, new Error('sleepGuardWorkSources: unexpected non-array work source value'));
    } catch (error) {
      onError(source, error);
    }
    return [];
  };

  return {
    coworkSessionIds: readList('cowork', () => getters.getActiveCoworkSessionIds()),
    scheduledTaskIds: readList('scheduledTask', () => getters.getActiveScheduledTaskIds()),
    dreamingMetabotIds: readList('dream', () => getters.getDreamingMetabotIds()),
    groupTaskTurnIds: readList('groupTask', () => groupTaskTurnIdsOf(getters.getGroupTaskTurns())),
    groupChatReplyTaskIds: readList('groupChat', () => getters.getActiveGroupChatReplyTaskIds()),
    a2aReplyTaskIds: readList('a2aChat', () => getters.getActiveA2AReplyTaskIds()),
  };
}
