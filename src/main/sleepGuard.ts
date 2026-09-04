/**
 * Sleep Guard — keep the host device awake while IDBots is actively working.
 *
 * IDBots is a desktop platform that keeps working even when the user walks away:
 * bot/cowork sessions stream, scheduled tasks fire, nightly dreams consolidate,
 * and group-chat tasks orchestrate. If the OS lets the machine sleep during any
 * of that work, the work stalls and deliveries are delayed.
 *
 * This module is a pure, dependency-injected wrapper around Electron's
 * `powerSaveBlocker`. It contains no direct `electron` import so it can be
 * unit-tested with a fake blocker. The main process wires the real
 * `powerSaveBlocker` plus the live "work" sources.
 *
 * The guard is engaged only while at least one work source is active, and is
 * released as soon as all sources are idle — the OS sleep policy is untouched
 * outside of actual work.
 */

export type SleepGuardSource = 'cowork' | 'scheduledTask' | 'dream';

export interface SleepGuardWorkInput {
  /** Ids of actively-running cowork sessions (covers interactive sessions,
   *  scheduled-task sessions, group-chat task sessions, A2A chats and
   *  service-order executions). */
  coworkSessionIds: readonly string[];
  /** Ids of scheduled tasks currently executing (before/around their session). */
  scheduledTaskIds: readonly string[];
  /** Metabot ids currently running a nightly dream consolidation. */
  dreamingMetabotIds: readonly number[];
}

export interface SleepGuardWorkState {
  /** True when at least one work source is active. */
  active: boolean;
  /** The sources that are currently active (empty when idle). */
  sources: SleepGuardSource[];
}

export interface SleepGuardState {
  active: boolean;
  sources: SleepGuardSource[];
  /** Whether the OS power-save blocker is currently engaged. */
  engaged: boolean;
}

/** Minimal surface of Electron's `powerSaveBlocker` used by this module. */
export interface PowerSaveBlockerLike {
  start(type: 'prevent-app-suspension'): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
}

/**
 * Pure policy: decide whether the sleep guard must be engaged from the set of
 * active work sources. Kept side-effect free so it can be unit-tested directly.
 */
export function evaluateSleepGuardWork(input: SleepGuardWorkInput): SleepGuardWorkState {
  const sources: SleepGuardSource[] = [];
  if (input.coworkSessionIds.length > 0) sources.push('cowork');
  if (input.scheduledTaskIds.length > 0) sources.push('scheduledTask');
  if (input.dreamingMetabotIds.length > 0) sources.push('dream');
  return { active: sources.length > 0, sources };
}

export interface SleepGuardOptions {
  powerSaveBlocker: PowerSaveBlockerLike;
  /** Called whenever the engaged/active state changes. */
  onChanged?: (state: SleepGuardState) => void;
}

const BLOCKER_TYPE = 'prevent-app-suspension' as const;

/**
 * Stateful guard: applies work state to the power-save blocker idempotently.
 * Starting the blocker when it is already started, or stopping it when it is
 * already stopped, is a no-op — callers may `apply` freely on any event.
 */
export class SleepGuard {
  private readonly powerSaveBlocker: PowerSaveBlockerLike;
  private readonly onChanged?: (state: SleepGuardState) => void;
  private blockerId: number | null = null;
  private state: SleepGuardState = { active: false, sources: [], engaged: false };

  constructor(options: SleepGuardOptions) {
    this.powerSaveBlocker = options.powerSaveBlocker;
    this.onChanged = options.onChanged;
  }

  apply(work: SleepGuardWorkState): SleepGuardState {
    const prev = this.state;
    let engaged = this.blockerId !== null;

    if (work.active) {
      if (this.blockerId === null) {
        try {
          this.blockerId = this.powerSaveBlocker.start(BLOCKER_TYPE);
        } catch (error) {
          // Blocker start is best-effort (e.g. unsupported platform); keep the
          // guard state consistent rather than crashing the caller.
          console.warn('[SleepGuard] powerSaveBlocker.start failed:', error);
          this.blockerId = null;
        }
      }
      engaged = this.blockerId !== null && this.powerSaveBlocker.isStarted(this.blockerId);
    } else if (this.blockerId !== null) {
      try {
        this.powerSaveBlocker.stop(this.blockerId);
      } catch (error) {
        console.warn('[SleepGuard] powerSaveBlocker.stop failed:', error);
      }
      this.blockerId = null;
      engaged = false;
    }

    const next: SleepGuardState = { active: work.active, sources: [...work.sources], engaged };
    const sourcesChanged =
      prev.sources.length !== next.sources.length ||
      prev.sources.some((source, index) => source !== next.sources[index]);
    if (
      prev.active !== next.active ||
      prev.engaged !== next.engaged ||
      sourcesChanged
    ) {
      this.state = next;
      this.onChanged?.(next);
    } else {
      this.state = next;
    }
    return this.getState();
  }

  getState(): SleepGuardState {
    return { active: this.state.active, sources: [...this.state.sources], engaged: this.state.engaged };
  }

  isEngaged(): boolean {
    return this.state.engaged;
  }

  /** Release the blocker and reset state (used on app shutdown). */
  dispose(): void {
    if (this.blockerId !== null) {
      try {
        this.powerSaveBlocker.stop(this.blockerId);
      } catch {
        // Already released or the runtime is shutting down.
      }
      this.blockerId = null;
    }
    this.state = { active: false, sources: [], engaged: false };
  }
}
