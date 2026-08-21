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
