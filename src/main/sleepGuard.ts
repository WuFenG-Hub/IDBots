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
 * ── Host-level setting (General ▸ 「阻止设备休眠」) ───────────────────────────
 *  Sleep prevention is opt-in and OFF by default (a missing config key must
 *  stay off). When the setting is off the guard performs no sleep-prevention
 *  side effect at all: it neither spawns `caffeinate` nor calls
 *  `powerSaveBlocker`. Toggling it applies immediately — disabling releases any
 *  held mechanism, enabling engages at once if work is already active.
 *
 * The guard is engaged only while the setting is on AND at least one work
 * source is active, and is released as soon as either goes away — the OS sleep
 * policy is untouched outside of that.
 *
 * ── What counts as "work" (collection lives in sleepGuardWorkSources.ts) ────
 *  The guard never infers work from "the app is running": long-lived daemons
 *  (p2p indexer, MCP skill servers, the local MetaApp server, listeners) must
 *  NOT keep the device awake forever. It only tracks bounded units of work:
 *   - `cowork`        — a running cowork session. This is the single long-work
 *                       entry point of the platform: interactive chat, Bot
 *                       Browser sessions, IM turns, A2A online chats, private
 *                       order executions and nightly study runs all fund the
 *                       same `CoworkRunner.activeSessions` map.
 *   - `scheduledTask` — a scheduled task executing around its session.
 *   - `dream`         — a nightly dream consolidation.
 *   - `groupTask`     — a group-task daemon turn in flight (its in-process
 *                       planning/verification/upload stretches have no session).
 *   - `groupChat`     — a group-chat auto-reply pipeline in flight.
 *   - `a2aChat`       — an online private-chat (A2A) reply pipeline in flight.
 */
import { spawn as nodeSpawn } from 'node:child_process';

export type SleepGuardSource =
  | 'cowork'
  | 'scheduledTask'
  | 'dream'
  | 'groupTask'
  | 'groupChat'
  | 'a2aChat';

export interface SleepGuardWorkInput {
  /** Ids of actively-running cowork sessions (covers interactive sessions,
   *  scheduled-task sessions, group-chat task sessions, A2A chats and
   *  service-order executions). */
  coworkSessionIds: readonly string[];
  /** Ids of scheduled tasks currently executing (before/around their session). */
  scheduledTaskIds: readonly string[];
  /** Metabot ids currently running a nightly dream consolidation. */
  dreamingMetabotIds: readonly number[];
  /**
   * Keys (`taskId:metabotId`) of group-task daemon turns currently in flight.
   *
   * A group-task turn is multi-minute by construction (the daemon budgets a
   * 10-minute plain / 30-minute skill turn before its 45-minute latch), but
   * only its SKILL turns run inside a cowork session: chair planning,
   * verification, chain sends, deliverable uploads and the acceptance summary
   * all run in-process in the daemon. Without this source the guard would drop
   * the assertion (or never hold it) for those stretches of a live task.
   */
  groupTaskTurnIds: readonly string[];
  /**
   * Task keys of in-flight group-chat auto-reply pipelines (the cognitive
   * orchestrator's `runReplyPipeline`). Its skill-turn branch is a cowork
   * session, but the plain branch is a direct, possibly minute-long reasoning
   * completion with `thinking: enabled` and no session behind it.
   */
  groupChatReplyTaskIds: readonly string[];
  /**
   * Pin ids of in-flight A2A / online private-chat reply pipelines. Same shape
   * as `groupChatReplyTaskIds`: the long skill branch is a cowork session, the
   * plain branch is a session-less completion.
   */
  a2aReplyTaskIds: readonly string[];
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
  /**
   * Host-level setting (General settings ▸ 「阻止设备休眠」). When false the
   * guard is a no-op: `engaged` is always false regardless of active work.
   */
  preventDeviceSleepEnabled: boolean;
}

/**
 * Resolve the host-level setting from its stored config value.
 *
 * Default-OFF contract: only an explicit boolean `true` enables the feature. A
 * missing key (fresh install / no config yet), a partial write, or any
 * non-boolean value (legacy `'true'`, `1`, `{}`) all resolve to `false`.
 */
export function resolvePreventDeviceSleepEnabled(rawConfigValue: unknown): boolean {
  return rawConfigValue === true;
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
 * App kv-config key backing the host setting (General ▸ 「阻止设备休眠」).
 * Lives in the same store the harness renderer reads/writes through
 * `window.electron.store`, so the main process can read it at boot. Never
 * rename this literal: existing installations would silently lose the setting
 * and fall back to OFF.
 */
export const PREVENT_DEVICE_SLEEP_SETTING_KEY = 'sleep_guard_prevent_device_sleep';

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
 *
 * Source order is stable (it is what the badge tooltip lists), and every work
 * source is independent: one active source is enough to hold the assertion.
 */
export function evaluateSleepGuardWork(input: SleepGuardWorkInput): SleepGuardWorkState {
  const sources: SleepGuardSource[] = [];
  if (input.coworkSessionIds.length > 0) sources.push('cowork');
  if (input.scheduledTaskIds.length > 0) sources.push('scheduledTask');
  if (input.dreamingMetabotIds.length > 0) sources.push('dream');
  if (input.groupTaskTurnIds.length > 0) sources.push('groupTask');
  if (input.groupChatReplyTaskIds.length > 0) sources.push('groupChat');
  if (input.a2aReplyTaskIds.length > 0) sources.push('a2aChat');
  return { active: sources.length > 0, sources };
}

export interface SleepGuardOptions {
  powerSaveBlocker: PowerSaveBlockerLike;
  /** Called whenever the engaged/active state (or the mechanism) changes. */
  onChanged?: (state: SleepGuardState) => void;
  /**
   * Host-level setting (General settings ▸ 「阻止设备休眠」). Defaults to
   * `false`: without an explicit opt-in the guard never touches the OS.
   */
  enabled?: boolean;
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
  private enabled: boolean;
  private state: SleepGuardState = {
    active: false,
    sources: [],
    engaged: false,
    engagedBy: null,
    preventDeviceSleepEnabled: false,
  };

  constructor(options: SleepGuardOptions) {
    this.powerSaveBlocker = options.powerSaveBlocker;
    this.onChanged = options.onChanged;
    this.platform = options.platform ?? process.platform;
    this.spawnHelper = options.spawnHelper ?? defaultSpawnHelper;
    this.parentPid = options.parentPid ?? process.pid;
    this.helperPath = options.helperPath ?? CAFFEINATE_PATH;
    this.warn = options.warn ?? defaultWarn;
    this.enabled = options.enabled === true;
    this.state.preventDeviceSleepEnabled = this.enabled;
  }

  apply(work: SleepGuardWorkState): SleepGuardState {
    if (this.enabled && work.active) {
      if (this.currentEngagedBy() === null) this.engage();
    } else if (this.helper !== null || this.blockerId !== null || this.engagedBy !== null) {
      // Either the setting is off (never hold a mechanism) or the work ended.
      this.release();
    }
    return this.syncState(work.active, work.sources);
  }

  /**
   * Apply the host-level setting at runtime — takes effect immediately, with no
   * app restart. Disabling releases any held mechanism right away; enabling
   * engages at once when work is already active.
   */
  setEnabled(enabled: boolean): SleepGuardState {
    this.enabled = enabled === true;
    if (!this.enabled) {
      if (this.helper !== null || this.blockerId !== null || this.engagedBy !== null) this.release();
    } else if (this.state.active && this.currentEngagedBy() === null) {
      this.engage();
    }
    return this.syncState(this.state.active, this.state.sources);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getState(): SleepGuardState {
    return {
      active: this.state.active,
      sources: [...this.state.sources],
      engaged: this.state.engaged,
      engagedBy: this.state.engagedBy,
      preventDeviceSleepEnabled: this.state.preventDeviceSleepEnabled,
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
    this.state = {
      active: false,
      sources: [],
      engaged: false,
      engagedBy: null,
      preventDeviceSleepEnabled: this.enabled,
    };
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
      preventDeviceSleepEnabled: this.enabled,
    };
    const sourcesChanged =
      prev.sources.length !== next.sources.length ||
      prev.sources.some((source, index) => source !== next.sources[index]);
    this.state = next;
    if (
      prev.active !== next.active ||
      prev.engaged !== next.engaged ||
      prev.engagedBy !== next.engagedBy ||
      prev.preventDeviceSleepEnabled !== next.preventDeviceSleepEnabled ||
      sourcesChanged
    ) {
      this.onChanged?.(this.getState());
    }
    return this.getState();
  }
}
