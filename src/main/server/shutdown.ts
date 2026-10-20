/**
 * Server-mode graceful shutdown (REQ-A-3, C1 "Lifecycle").
 *
 * On SIGTERM/SIGINT the tenant must stop accepting gateway work, tear down
 * child processes through their EXISTING stop paths, flush SQLite, and exit
 * within 20 s — a hard watchdog (`setTimeout(exit, 20_000).unref()`) fires
 * exit(1) if anything stalls. Desktop registers its own handlers and never
 * installs these.
 *
 * Sequence (each phase logged through the server logger):
 *   1. gateway-close — close sockets with code 4012 and stop accepting
 *      connections/invokes (the gateway handle's close() flips its closing
 *      flag, which rejects new invokes).
 *   2. app-cleanup — the existing runAppCleanup(): daemons, DSH runtime, IM
 *      gateways, skill services, proxy, scheduler… unchanged from desktop.
 *   3. sqlite-flush — persist the store (save + close).
 *   4. exit(0).
 *
 * Electron-free: plain-node testable with fakes (tests/serverMode.test.mjs).
 */

import type { ServerLogLevel } from './logger';

/** C1: total shutdown budget; the watchdog converts a stall into exit(1). */
export const SERVER_SHUTDOWN_WATCHDOG_MS = 20_000;
/** C2 close code "server restarting or upgrading". */
export const SERVER_SHUTDOWN_CLOSE_CODE = 4012;

export interface ServerShutdownGateway {
  close: (opts?: { code?: number; reason?: string }) => Promise<void>;
}

export interface ServerShutdownDeps {
  /** The running gateway, or null when it failed to start. */
  getGateway: () => ServerShutdownGateway | null;
  /** Existing desktop teardown: daemons, DSH runtime, IM gateways, … */
  runAppCleanup: () => Promise<void>;
  /** Persist SQLite (store save). */
  flushSqlite: () => void | Promise<void>;
  /** Close SQLite after the flush (optional hard close). */
  closeSqlite?: () => void;
  exit: (code: number) => void;
  log: (level: ServerLogLevel, phase: string, msg: string, extra?: Record<string, unknown>) => void;
  /** Notified exactly once when the sequence begins (e.g. bootstrap `stopping`). */
  onBegin?: () => void;
  /** Test hook: override the 20 s budget. */
  watchdogMs?: number;
  /** Test hook: timer implementation. */
  setTimeoutFn?: typeof setTimeout;
}

export interface ServerShutdownRun {
  /** Resolves when the sequence reaches the exit phase (exit itself is injected). */
  finished: Promise<void>;
  /** The hard-watchdog timer (unref'd); fires exit(1) on stall. */
  watchdog: ReturnType<typeof setTimeout>;
  /** Starts the sequence (idempotent). */
  start: () => void;
}

/**
 * Run the shutdown sequence once. Exposed separately from signal
 * installation so tests can drive it directly with fakes.
 */
export function runServerShutdown(deps: ServerShutdownDeps): ServerShutdownRun {
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const watchdogMs = deps.watchdogMs ?? SERVER_SHUTDOWN_WATCHDOG_MS;
  let started = false;
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });

  const watchdog = setTimeoutFn(() => {
    deps.log('error', 'watchdog', `shutdown exceeded ${watchdogMs} ms; forcing exit`, {});
    try {
      deps.exit(1);
    } finally {
      resolveFinished();
    }
  }, watchdogMs);
  watchdog.unref?.();

  const start = (): void => {
    if (started) return;
    started = true;
    try {
      deps.onBegin?.();
    } catch {
      // Observer failures must never block shutdown.
    }
    void (async () => {
      deps.log('info', 'gateway-close', 'closing gateway (code 4012); no new connections or invokes', {});
      const gateway = deps.getGateway();
      if (gateway) {
        await gateway.close({ code: SERVER_SHUTDOWN_CLOSE_CODE, reason: 'server shutdown' }).catch((error: unknown) => {
          deps.log('warn', 'gateway-close', 'gateway close failed; continuing shutdown', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      } else {
        deps.log('warn', 'gateway-close', 'no gateway handle; skipping', {});
      }

      deps.log('info', 'app-cleanup', 'stopping daemons, DSH runtime, and child processes', {});
      await deps.runAppCleanup().catch((error: unknown) => {
        deps.log('error', 'app-cleanup', 'cleanup failed; continuing to SQLite flush', {
          error: error instanceof Error ? error.message : String(error),
        });
      });

      deps.log('info', 'sqlite-flush', 'flushing SQLite', {});
      try {
        await deps.flushSqlite();
        deps.closeSqlite?.();
      } catch (error: unknown) {
        deps.log('error', 'sqlite-flush', 'SQLite flush failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      deps.log('info', 'exit', 'shutdown complete; exiting 0', {});
      clearTimeout(watchdog);
      try {
        deps.exit(0);
      } finally {
        resolveFinished();
      }
    })();
  };

  return { finished, watchdog, start };
}

/**
 * REQ-A-3: register SIGTERM/SIGINT handlers for server mode. Returns a
 * disposer (primarily for tests); the process is expected to exit through
 * the sequence anyway.
 */
export function installServerShutdownHandlers(deps: ServerShutdownDeps): () => void {
  let current: ServerShutdownRun | null = null;
  const onSignal = (signal: string) => (): void => {
    deps.log('warn', 'signal', `received ${signal}; starting graceful shutdown`, {});
    if (!current) {
      current = runServerShutdown(deps);
      current.start();
    }
  };
  const onSigterm = onSignal('SIGTERM');
  const onSigint = onSignal('SIGINT');
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);
  return () => {
    process.off('SIGTERM', onSigterm);
    process.off('SIGINT', onSigint);
  };
}
