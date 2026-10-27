import type http from 'http';

export interface ListenWithRetryOptions {
  retryDelayMs?: number;
  maxAttempts?: number;
  /**
   * After maxAttempts fast retries are exhausted on EADDRINUSE, keep retrying
   * every this many ms until the bind succeeds or the server closes. A port
   * conflict (sibling dev instance, zombie process) can clear at any time;
   * without a background rebind the gateway stays dead for the lifetime of
   * the process and every local RPC client (SKILL scripts, cowork sessions)
   * fails even after the port frees up. 0/undefined = give up (legacy).
   */
  rebindDelayMs?: number;
  logger?: Pick<Console, 'warn' | 'error'>;
  onListening?: () => void;
}

const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_MAX_ATTEMPTS = 120;
/** Throttle background-rebind logs: one line per this many slow attempts. */
const REBIND_LOG_EVERY = 40;

export function listenWithRetry(
  server: http.Server,
  port: number,
  host: string,
  options: ListenWithRetryOptions = {},
): void {
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const rebindDelayMs = Math.max(0, options.rebindDelayMs ?? 0);
  const logger = options.logger ?? console;

  let attempt = 0;
  let stopped = false;
  let backgroundModeAnnounced = false;
  let retryTimer: NodeJS.Timeout | null = null;

  const clearRetryTimer = () => {
    if (!retryTimer) {
      return;
    }
    clearTimeout(retryTimer);
    retryTimer = null;
  };

  const scheduleRetry = (delayMs: number) => {
    clearRetryTimer();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      tryListen();
    }, delayMs);
    // A stuck rebind loop must never hold the process (or a test) open.
    retryTimer.unref?.();
  };

  const tryListen = () => {
    if (stopped || server.listening) {
      return;
    }

    attempt += 1;

    // Pair the error/listening listeners and always remove the counterpart
    // when one settles — re-adding a one-shot 'listening' callback per retry
    // without removing it leaks listeners (MaxListenersExceededWarning) and
    // replays stale callbacks on the eventual success.
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      if (stopped) {
        return;
      }

      if (error.code === 'EADDRINUSE') {
        if (attempt < maxAttempts) {
          logger.warn(`[MetaID RPC] Port ${host}:${port} busy; retrying bind (${attempt}/${maxAttempts})`);
          scheduleRetry(retryDelayMs);
          return;
        }
        if (rebindDelayMs > 0) {
          if (!backgroundModeAnnounced) {
            backgroundModeAnnounced = true;
            logger.error(
              `[MetaID RPC] Failed to bind ${host}:${port} after ${maxAttempts} attempts: ${error.message}; ` +
              `keeping a slow background rebind every ${rebindDelayMs}ms until the port frees up`,
            );
          } else if (attempt % REBIND_LOG_EVERY === 0) {
            logger.warn(`[MetaID RPC] Port ${host}:${port} still busy; background rebind attempt ${attempt}`);
          }
          scheduleRetry(rebindDelayMs);
          return;
        }
        stopped = true;
        logger.error(`[MetaID RPC] Failed to bind ${host}:${port}: ${error.message}`);
        return;
      }

      stopped = true;
      logger.error(`[MetaID RPC] Failed to bind ${host}:${port}: ${error.message}`);
    };

    const onListening = () => {
      server.removeListener('error', onError);
      clearRetryTimer();
      stopped = true;
      options.onListening?.();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  };

  server.once('close', () => {
    stopped = true;
    clearRetryTimer();
  });

  tryListen();
}

export interface ListenWithPortFallbackOptions extends ListenWithRetryOptions {
  /**
   * How many consecutive ports to try above the preferred one. 0 disables
   * fallback (preferred port only).
   */
  fallbackPortSpan?: number;
  /** Called once with the port the server actually bound. */
  onPortSelected?: (port: number) => void;
}

/**
 * Bind on the preferred port, stepping upward while it stays busy.
 *
 * Companion to listenWithRetry for instances that own their own userData:
 * when another app instance permanently holds the preferred port (production
 * app alongside a dev-fresh profile), waiting forever strands this instance
 * without a gateway while its session env still advertises the busy port —
 * every skill RPC then lands in the OTHER instance (cross-instance data
 * blend, 2026-10-27 incident). A brief in-place retry absorbs transient
 * conflicts (a restarting sibling); past that, take the next free port and
 * report it via onPortSelected so env injection follows the real bind.
 *
 * If every port in the span is busy, degrade to listenWithRetry's indefinite
 * background rebind on the preferred port rather than giving up.
 */
export function listenWithPortFallback(
  server: http.Server,
  port: number,
  host: string,
  options: ListenWithPortFallbackOptions = {},
): void {
  const {
    fallbackPortSpan = 64,
    onPortSelected,
    onListening,
    logger = console,
    ...retryOptions
  } = options;
  // Short in-place budget for transient conflicts before stepping sideways.
  const transientAttempts = retryOptions.maxAttempts ?? 3;
  const transientDelayMs = retryOptions.retryDelayMs ?? 500;

  const tryBind = (candidate: number, maxAttempts: number, delayMs: number) =>
    new Promise<'listening' | 'busy'>((resolve) => {
      let attempt = 0;
      const attemptOnce = () => {
        attempt += 1;
        const onError = (error: NodeJS.ErrnoException) => {
          server.removeListener('listening', onListeningOnce);
          if (error.code === 'EADDRINUSE' && attempt < maxAttempts) {
            logger.warn(
              `[MetaID RPC] Port ${host}:${candidate} busy; retrying bind (${attempt}/${maxAttempts})`,
            );
            setTimeout(attemptOnce, delayMs).unref?.();
            return;
          }
          resolve('busy');
        };
        const onListeningOnce = () => {
          server.removeListener('error', onError);
          resolve('listening');
        };
        server.once('error', onError);
        server.once('listening', onListeningOnce);
        server.listen(candidate, host);
      };
      attemptOnce();
    });

  void (async () => {
    for (let candidate = port; candidate <= port + fallbackPortSpan; candidate += 1) {
      // Preferred port gets the transient retry budget; step-up candidates
      // are tried once — a busy step-up port is a real conflict, not a race.
      const result = await tryBind(
        candidate,
        candidate === port ? transientAttempts : 1,
        transientDelayMs,
      );
      if (result === 'listening') {
        if (candidate !== port) {
          logger.warn(
            `[MetaID RPC] Port ${host}:${port} held by another instance; gateway bound on fallback port ${candidate}`,
          );
        }
        onPortSelected?.(candidate);
        onListening?.();
        return;
      }
    }
    logger.error(
      `[MetaID RPC] No free port in ${host}:${port}-${port + fallbackPortSpan}; ` +
      `falling back to background rebind on ${port}`,
    );
    listenWithRetry(server, port, host, { ...retryOptions, onListening, logger });
  })();
}
