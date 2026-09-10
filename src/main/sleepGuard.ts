/**
 * Sleep Guard — keep the host device awake while IDBots is actively working.
 *
 * IDBots is a desktop platform that keeps working even when the user walks away:
 * bot/cowork sessions stream, scheduled tasks fire, nightly dreams consolidate,
 * and group-chat tasks orchestrate. If the OS lets the machine sleep during any
 * of that work, the work stalls and deliveries are delayed.
 *
 * This module is a pure, dependency-injected wrapper. It contains no direct
 * `electron` import so it can be unit-tested with fakes; the main process wires
 * the real `powerSaveBlocker` (and, on macOS, the real process spawn seam).
 *
 * ── Platform strategy (macOS sleep-assertion fix, 2026-09) ───────────────────
 *  - darwin: Electron's `prevent-app-suspension` only creates an IOKit
 *    `NoIdleSleepAssertion` (type `kIOPMAssertionTypeNoIdleSleep`, marked
 *    `@deprecated Deprecated in 10.7` in Apple's IOPMLib.h). macOS no longer
 *    treats it as "prevent user-idle system sleep", so it is not a real guard.
 *    On macOS we instead spawn the system helper `/usr/bin/caffeinate -i -w <pid>`:
 *    `-i` declares the current, supported `PreventUserIdleSystemSleep`
 *    assertion, and `-w <pid>` makes the helper exit by itself if IDBots dies.
 *  - darwin fallback: if caffeinate cannot be spawned (or exits while work is
 *    still active), we fall back to Electron's `prevent-display-sleep`, which
 *    was measured on this host to hold a live `NoDisplaySleepAssertion`
 *    (= `PreventUserIdleDisplaySleep` in `pmset -g assertions`).
 *  - other platforms: unchanged `prevent-app-suspension`.
 *
 * ── Documented boundary (not fixed here) ────────────────────────────────────
 *  `PreventUserIdleSystemSleep` prevents *user-idle* system sleep only. Closing
 *  the lid, choosing Apple menu ▸ Sleep, and low-battery forced sleep still put
 *  the machine to sleep; the guard does not (and cannot) override those.
 *
 * The guard is engaged only while at least one work source is active, and is
 * released as soon as all sources are idle — the OS sleep policy is untouched
 * outside of actual work.
 */
import { spawn as nodeSpawn } from 'node:child_process';

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

/** Which mechanism currently holds the OS awake. */
export type SleepGuardEngagedBy = 'caffeinate' | 'powerSaveBlocker';

export interface SleepGuardState {
  active: boolean;
  sources: SleepGuardSource[];
  /** Whether a sleep-prevention mechanism is currently engaged. */
  engaged: boolean;
  /**
   * Which mechanism is engaged: `'caffeinate'` (macOS helper process holding
   * `PreventUserIdleSystemSleep`), `'powerSaveBlocker'` (Electron blocker —
   * `prevent-display-sleep` on macOS, `prevent-app-suspension` elsewhere), or
   * `null` when released.
   */
  engagedBy: SleepGuardEngagedBy | null;
}

export type PowerSaveBlockerType = 'prevent-app-suspension' | 'prevent-display-sleep';

/** Minimal surface of Electron's `powerSaveBlocker` used by this module. */
export interface PowerSaveBlockerLike {
  start(type: PowerSaveBlockerType): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
}

/** Minimal surface of a spawned helper process (`child_process.ChildProcess`). */
export interface SpawnedProcessLike {
  pid?: number | undefined;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: string, listener: (...args: never[]) => void): unknown;
  removeListener?(event: string, listener: (...args: never[]) => void): unknown;
  unref?(): void;
}

/** Spawn seam — injected so unit tests never launch a real process. */
export type SleepGuardSpawnHelper = (command: string, args: readonly string[]) => SpawnedProcessLike;

/** System helper used on macOS to hold a supported sleep assertion. */
export const CAFFEINATE_PATH = '/usr/bin/caffeinate';

/**
 * `-i` prevents user-idle system sleep (the supported assertion type);
 * `-w <pid>` makes caffeinate exit when the watched pid exits.
 */
export function buildCaffeinateArgs(parentPid: number): string[] {
  return ['-i', '-w', String(parentPid)];
}

const LEGACY_BLOCKER_TYPE: PowerSaveBlockerType = 'prevent-app-suspension';
const DARWIN_FALLBACK_BLOCKER_TYPE: PowerSaveBlockerType = 'prevent-display-sleep';

const defaultSpawnHelper: SleepGuardSpawnHelper = (command, args) =>
  nodeSpawn(command, [...args]) as unknown as SpawnedProcessLike;

const defaultWarn = (message: string, error?: unknown): void => {
  if (error === undefined) console.warn(message);
  else console.warn(message, error);
};

/** Diagnostic view of the current engagement (used by the real-host check). */
export interface SleepGuardEngagement {
  engagedBy: SleepGuardEngagedBy | null;
  /** Pid of the spawned caffeinate helper while engaged via caffeinate. */
  helperPid: number | null;
  /** powerSaveBlocker id while engaged via the blocker. */
  blockerId: number | null;
  /** Blocker type currently in use, when engaged via the blocker. */
  blockerType: PowerSaveBlockerType | null;
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
  /** Called whenever the engaged/active state (or the mechanism) changes. */
  onChanged?: (state: SleepGuardState) => void;
  /** Platform override; defaults to `process.platform` (injected for tests). */
  platform?: NodeJS.Platform;
  /** Spawn seam for the macOS helper; defaults to `child_process.spawn`. */
  spawnHelper?: SleepGuardSpawnHelper;
  /** Pid the helper watches (`-w`); defaults to `process.pid`. */
  parentPid?: number;
  /** Helper binary path; defaults to {@link CAFFEINATE_PATH}. */
  helperPath?: string;
  /** Logging seam; defaults to `console.warn`. */
  warn?: (message: string, error?: unknown) => void;
}

/**
 * Stateful guard: applies work state to the sleep-prevention mechanism
 * idempotently. Starting the mechanism when it is already started, or stopping
 * it when it is already stopped, is a no-op — callers may `apply` freely on any
 * event.
 */
export class SleepGuard {
  private readonly powerSaveBlocker: PowerSaveBlockerLike;
  private readonly onChanged?: (state: SleepGuardState) => void;
  private readonly platform: NodeJS.Platform;
  private readonly spawnHelper: SleepGuardSpawnHelper;
  private readonly parentPid: number;
  private readonly helperPath: string;
  private readonly warn: (message: string, error?: unknown) => void;

  private blockerId: number | null = null;
  private blockerType: PowerSaveBlockerType | null = null;
  private helper: SpawnedProcessLike | null = null;
  private helperExitHandler: (() => void) | null = null;
  private engagedBy: SleepGuardEngagedBy | null = null;
  private state: SleepGuardState = { active: false, sources: [], engaged: false, engagedBy: null };

  constructor(options: SleepGuardOptions) {
    this.powerSaveBlocker = options.powerSaveBlocker;
    this.onChanged = options.onChanged;
    this.platform = options.platform ?? process.platform;
    this.spawnHelper = options.spawnHelper ?? defaultSpawnHelper;
    this.parentPid = options.parentPid ?? process.pid;
    this.helperPath = options.helperPath ?? CAFFEINATE_PATH;
    this.warn = options.warn ?? defaultWarn;
  }

  apply(work: SleepGuardWorkState): SleepGuardState {
    if (work.active) {
      if (this.currentEngagedBy() === null) this.engage();
    } else if (this.helper !== null || this.blockerId !== null || this.engagedBy !== null) {
      this.release();
    }
    return this.syncState(work.active, work.sources);
  }

  getState(): SleepGuardState {
    return {
      active: this.state.active,
      sources: [...this.state.sources],
      engaged: this.state.engaged,
      engagedBy: this.state.engagedBy,
    };
  }

  isEngaged(): boolean {
    return this.state.engaged;
  }

  /** Diagnostic detail about the current engagement mechanism. */
  getEngagement(): SleepGuardEngagement {
    return {
      engagedBy: this.engagedBy,
      helperPid: this.helper?.pid ?? null,
      blockerId: this.blockerId,
      blockerType: this.blockerType,
    };
  }

  /** Release the mechanism and reset state (used on app shutdown). */
  dispose(): void {
    this.release();
    this.state = { active: false, sources: [], engaged: false, engagedBy: null };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private engage(): void {
    if (this.platform === 'darwin' && this.startCaffeinateHelper()) return;
    const fallbackType = this.platform === 'darwin' ? DARWIN_FALLBACK_BLOCKER_TYPE : LEGACY_BLOCKER_TYPE;
    this.startBlocker(fallbackType);
  }

  /**
   * macOS: hold the supported `PreventUserIdleSystemSleep` assertion through
   * `/usr/bin/caffeinate -i -w <pid>`. Returns false when the helper could not
   * be started (the caller then falls back to the power-save blocker).
   */
  private startCaffeinateHelper(): boolean {
    const args = buildCaffeinateArgs(this.parentPid);
    let child: SpawnedProcessLike;
    try {
      child = this.spawnHelper(this.helperPath, args);
    } catch (error) {
      this.warn('[SleepGuard] caffeinate spawn threw; falling back to prevent-display-sleep', error);
      return false;
    }
    if (!child || !Number.isInteger(child.pid) || (child.pid as number) <= 0) {
      this.warn('[SleepGuard] caffeinate spawn produced no usable pid; falling back to prevent-display-sleep');
      this.killHelper(child);
      return false;
    }

    const onExit = (): void => this.handleHelperExit(child);
    try {
      child.on('exit', onExit);
      child.on('error', onExit);
      child.unref?.();
    } catch (error) {
      this.warn('[SleepGuard] caffeinate lifecycle hooks failed; falling back to prevent-display-sleep', error);
      this.detachHelper(child, onExit);
      this.killHelper(child);
      return false;
    }

    this.helper = child;
    this.helperExitHandler = onExit;
    return true;
  }

  /**
   * The helper exited (spawn failure surfaced as `error`, or it died) while we
   * still believed it was engaged: swap to the power-save blocker so the device
   * does not silently start sleeping mid-work.
   */
  private handleHelperExit(child: SpawnedProcessLike): void {
    if (this.helper !== child) return; // stale event (already released/replaced)
    this.warn('[SleepGuard] caffeinate exited while work is active; falling back to prevent-display-sleep');
    this.detachHelper(child, this.helperExitHandler);
    this.helper = null;
    this.helperExitHandler = null;
    this.engagedBy = null;
    this.startBlocker(DARWIN_FALLBACK_BLOCKER_TYPE);
    // Mechanism changed (or engagement was lost) outside `apply` — notify.
    this.syncState(this.state.active, this.state.sources);
  }

  private startBlocker(type: PowerSaveBlockerType): boolean {
    try {
      const id = this.powerSaveBlocker.start(type);
      if (typeof id !== 'number' || !this.powerSaveBlocker.isStarted(id)) {
        if (typeof id === 'number') {
          try {
            this.powerSaveBlocker.stop(id);
          } catch {
            // Best-effort cleanup of a blocker that never engaged.
          }
        }
        this.warn(`[SleepGuard] powerSaveBlocker.start('${type}') did not engage`);
        return false;
      }
      this.blockerId = id;
      this.blockerType = type;
      return true;
    } catch (error) {
      this.warn(`[SleepGuard] powerSaveBlocker.start('${type}') failed`, error);
      this.blockerId = null;
      this.blockerType = null;
      return false;
    }
  }

  private release(): void {
    const child = this.helper;
    if (child) {
      this.detachHelper(child, this.helperExitHandler);
      this.helper = null;
      this.helperExitHandler = null;
      try {
        child.kill();
      } catch (error) {
        this.warn('[SleepGuard] caffeinate kill failed', error);
      }
    }
    if (this.blockerId !== null) {
      const id = this.blockerId;
      this.blockerId = null;
      this.blockerType = null;
      try {
        this.powerSaveBlocker.stop(id);
      } catch (error) {
        this.warn('[SleepGuard] powerSaveBlocker.stop failed', error);
      }
    }
    this.engagedBy = null;
  }

  private detachHelper(child: SpawnedProcessLike, handler: (() => void) | null): void {
    if (!handler || typeof child.removeListener !== 'function') return;
    try {
      child.removeListener('exit', handler);
      child.removeListener('error', handler);
    } catch {
      // Detaching is best-effort; a stale handler is neutered by the
      // `this.helper !== child` guard in handleHelperExit.
    }
  }

  private killHelper(child: SpawnedProcessLike | null | undefined): void {
    if (!child || typeof child.kill !== 'function') return;
    try {
      child.kill();
    } catch {
      // Nothing to reap.
    }
  }

  private currentEngagedBy(): SleepGuardEngagedBy | null {
    if (this.helper !== null) return 'caffeinate';
    if (this.blockerId !== null) {
      try {
        if (this.powerSaveBlocker.isStarted(this.blockerId)) return 'powerSaveBlocker';
      } catch (error) {
        this.warn('[SleepGuard] powerSaveBlocker.isStarted failed', error);
      }
    }
    return null;
  }

  private syncState(active: boolean, sources: readonly SleepGuardSource[]): SleepGuardState {
    const engagedBy = this.currentEngagedBy();
    if (engagedBy === null) {
      if (this.blockerId !== null) {
        // The blocker reports itself stopped — drop the stale id; the OS handle
        // is already gone, so no extra stop() call is needed.
        this.blockerId = null;
        this.blockerType = null;
      }
      this.engagedBy = null;
    } else {
      this.engagedBy = engagedBy;
    }

    const prev = this.state;
    const next: SleepGuardState = {
      active,
      sources: [...sources],
      engaged: engagedBy !== null,
      engagedBy,
    };
    const sourcesChanged =
      prev.sources.length !== next.sources.length ||
      prev.sources.some((source, index) => source !== next.sources[index]);
    this.state = next;
    if (
      prev.active !== next.active ||
      prev.engaged !== next.engaged ||
      prev.engagedBy !== next.engagedBy ||
      sourcesChanged
    ) {
      this.onChanged?.(this.getState());
    }
    return this.getState();
  }
}
