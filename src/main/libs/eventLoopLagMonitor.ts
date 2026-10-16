/**
 * Main-process event-loop lag monitor (2026-10-16 first-sentence latency
 * work). Two production sessions (bd646510/c3419940) showed every bounded
 * cerebellum call settling ~14s past its own abort deadline, in the same
 * millisecond, after a total cowork.log silence — the signature of the
 * Electron main process being starved/blocked so setTimeout callbacks fire
 * late. JS-level budgets are defenseless against that, so the next
 * occurrence must at least be CAUGHT: this timer measures its own drift and
 * logs a WARN bracketing any stall window, giving the triage a liveness
 * timeline instead of a silent gap.
 */

import { coworkLog } from './coworkLogger';

const LAG_MONITOR_INTERVAL_MS = 1000;
/** Drift below this is ordinary scheduling jitter; at or above it, log. */
const LAG_MONITOR_WARN_THRESHOLD_MS = 2000;

let monitorStarted = false;

/**
 * Start the drift monitor once per process. The timer is unref'd so it never
 * holds the process open, and intentionally cheap: one Date.now() diff per
 * second, no allocation on the healthy path.
 */
export function startEventLoopLagMonitor(): void {
  if (monitorStarted) return;
  monitorStarted = true;
  let lastTickAt = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const lagMs = now - lastTickAt - LAG_MONITOR_INTERVAL_MS;
    lastTickAt = now;
    if (lagMs >= LAG_MONITOR_WARN_THRESHOLD_MS) {
      coworkLog('WARN', 'eventloop:lag', 'Main-process event loop stalled; every in-process timer (cerebellum abort budgets, turn races) fired late by the same amount', {
        lagMs,
      });
    }
  }, LAG_MONITOR_INTERVAL_MS);
  timer.unref?.();
}
