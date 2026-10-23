import { resolveServerBootDelayMs } from '../server/serverMode';

/**
 * Deferred-startup tier queue (extracted from main.ts for testability).
 *
 * Boot work is queued with setTimeout and fired on a later tick. The SQLite
 * daemon start used to clear the WHOLE queue synchronously, so any tier
 * queued before it (server mode's task-scheduler tier, the other boot jobs)
 * was deterministically cancelled before it ever ran — the S1 incident where
 * the scheduler never started in server mode.
 *
 * `noteSqliteDaemonsStarted` is the seam startSqliteDaemons() calls first.
 */

let startupTierTimers: Array<ReturnType<typeof setTimeout>> = [];
let startupTiersCancelled = false;
let startupTierLog: ((message: string) => void) | null = null;

/** main.ts injects its startupLog so tier logging stays identical. */
export const setStartupTierLogger = (logger: (message: string) => void): void => {
  startupTierLog = logger;
};

export const clearPendingStartupTiers = (): void => {
  for (const timer of startupTierTimers) {
    clearTimeout(timer);
  }
  startupTierTimers = [];
};

/** App cleanup calls this: a pending tier must never start work after cleanup. */
export const cancelDeferredStartupWork = (): void => {
  startupTiersCancelled = true;
  clearPendingStartupTiers();
};

export const scheduleStartupTier = (label: string, delayMs: number, run: () => void): void => {
  if (startupTiersCancelled) return;
  // REQ-A-33: server mode spreads each tier by a deterministic per-tenant
  // jitter so a host restarting many tenants does not run their boot work in
  // the same instant. Desktop timing is unchanged.
  const effectiveDelayMs = resolveServerBootDelayMs(delayMs, `tier:${label}`);
  const timer = setTimeout(() => {
    startupTierTimers = startupTierTimers.filter((entry) => entry !== timer);
    if (startupTiersCancelled) return;
    startupTierLog?.(`deferred startup "${label}" begin`);
    try {
      run();
    } catch (error) {
      console.error(`[Startup] deferred startup "${label}" failed:`, error);
    }
    startupTierLog?.(`deferred startup "${label}" done`);
  }, effectiveDelayMs);
  startupTierTimers.push(timer);
};

export const hasPendingStartupTiers = (): boolean => startupTierTimers.length > 0;

export const areStartupTiersCancelled = (): boolean => startupTiersCancelled;

/** Test hook: reset the queue between cases without touching production flow. */
export const resetStartupTiersForTesting = (): void => {
  clearPendingStartupTiers();
  startupTiersCancelled = false;
  sqliteDaemonsStarted = false;
};

/**
 * Called at the top of startSqliteDaemons(). The FIRST daemon start clears
 * nothing: tiers queued during this same boot (server mode's task scheduler,
 * the other boot jobs) must survive. A re-entry (sqlite recovery restarts
 * the daemons) drops the previous generation's pending tiers so no daemon is
 * started twice by an old timer — the original re-entry semantics.
 */
let sqliteDaemonsStarted = false;

export const noteSqliteDaemonsStarted = (): void => {
  if (sqliteDaemonsStarted) {
    clearPendingStartupTiers();
  }
  sqliteDaemonsStarted = true;
};
