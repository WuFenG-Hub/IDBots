/**
 * Heartbeat service — first-class periodic dispatcher (long-term task
 * redesign P1, owner-ruled 2026-09-22).
 *
 * Until now the de-facto heartbeat was the group-task daemon's 5s tick with
 * concerns piggybacking under their own throttles (the tracked sweep rode it
 * at 1h). This service promotes the pattern to its own home:
 *
 *  - ONE master tick (default 5s) with the daemon's proven guarded-tick
 *    mechanics: an inactivity-based watchdog (a hung tick resets the loop
 *    instead of bricking it forever) and an epoch guard against a dangling
 *    late finally.
 *  - Handlers register by name with their own `intervalMs`; a tick runs every
 *    handler that is due. A slow/throwing handler never blocks the tick or
 *    its peers: async runs are fire-and-forget with a per-handler re-entry
 *    flag, and failures are logged, never fatal.
 *  - The heartbeat knows NOTHING about long-term tasks — `longterm.advance`
 *    is just the first registered handler (longTermAdvanceService). Future
 *    business (the legacy tracked sweep, other periodic checks) registers the
 *    same way. Handlers must be cheap LOCAL checks; escalating to LLM turns
 *    is the handler's own decision and budget.
 */

export const HEARTBEAT_TICK_MS = 5_000;
export const HEARTBEAT_WATCHDOG_MS = 45 * 60_000;

export interface HeartbeatHandler {
  name: string;
  /** Minimum spacing between runs of THIS handler. */
  intervalMs: number;
  run: (nowMs: number) => void | Promise<void>;
}

interface HandlerState {
  handler: HeartbeatHandler;
  /** null = never ran (0 is a valid timestamp, not a sentinel). */
  lastRunAtMs: number | null;
  running: boolean;
}

export interface HeartbeatServiceOptions {
  tickMs?: number;
  watchdogMs?: number;
  now?: () => number;
  emitLog?: (line: string) => void;
}

export class HeartbeatService {
  private readonly tickMs: number;
  private readonly watchdogMs: number;
  private readonly now: () => number;
  private readonly emitLog: (line: string) => void;
  private readonly handlers = new Map<string, HandlerState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private tickEpoch = 0;
  private tickLastProgressAtMs = 0;

  constructor(options: HeartbeatServiceOptions = {}) {
    this.tickMs = Math.max(1_000, Math.trunc(options.tickMs ?? HEARTBEAT_TICK_MS));
    this.watchdogMs = Math.max(10_000, Math.trunc(options.watchdogMs ?? HEARTBEAT_WATCHDOG_MS));
    this.now = options.now ?? Date.now;
    this.emitLog = options.emitLog ?? ((line: string) => console.log(line));
  }

  /** Register (or replace, by name) a handler. Idempotent across daemon restarts. */
  registerHandler(handler: HeartbeatHandler): void {
    this.handlers.set(handler.name, { handler, lastRunAtMs: null, running: false });
  }

  unregisterHandler(name: string): void {
    this.handlers.delete(name);
  }

  handlerNames(): string[] {
    return [...this.handlers.keys()];
  }

  /**
   * Run every handler that is due at `nowMs`. Async handler runs are
   * fire-and-forget (the tick never awaits them); a handler still in flight
   * is skipped, never double-run. Returns the fired handler names (test seam).
   */
  runDueHandlers(nowMs: number = this.now()): string[] {
    const fired: string[] = [];
    for (const state of this.handlers.values()) {
      if (state.running) continue;
      if (state.lastRunAtMs !== null && nowMs - state.lastRunAtMs < state.handler.intervalMs) continue;
      state.lastRunAtMs = nowMs;
      state.running = true;
      fired.push(state.handler.name);
      const stateRef = state;
      Promise.resolve()
        .then(() => stateRef.handler.run(nowMs))
        .catch((error: unknown) => {
          this.emitLog(
            `[Heartbeat] handler "${stateRef.handler.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => {
          stateRef.running = false;
        });
    }
    return fired;
  }

  private readonly runGuardedTick = (): void => {
    // Inactivity-based watchdog: a tick whose handlers made no observable
    // progress for the whole watchdog window is presumed hung — log loudly
    // and reset the loop rather than bricking the heartbeat forever.
    if (this.ticking) {
      if (this.now() - this.tickLastProgressAtMs > this.watchdogMs) {
        this.emitLog(
          `[Heartbeat] tick watchdog: no progress for ${Math.round(this.watchdogMs / 60_000)} min — resetting the loop`,
        );
        this.ticking = false;
      } else {
        return;
      }
    }
    this.ticking = true;
    this.tickLastProgressAtMs = this.now();
    this.tickEpoch += 1;
    const epoch = this.tickEpoch;
    Promise.resolve()
      .then(() => {
        this.runDueHandlers();
      })
      .catch(() => undefined)
      .finally(() => {
        this.tickLastProgressAtMs = this.now();
        if (this.tickEpoch === epoch) this.ticking = false;
      });
  };

  /** Start the master tick. Idempotent — safe to call again after daemon restarts. */
  start(): void {
    if (this.timer) return;
    this.runGuardedTick();
    this.timer = setInterval(this.runGuardedTick, this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }
}
