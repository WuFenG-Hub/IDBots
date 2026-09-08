/**
 * Per-address circuit breaker for the MVC fee-sponsor (traffic mode).
 *
 * 2026-09-08 outage follow-up (R3.2 of the host-fix RFP): during a sustained
 * sponsor broadcast outage every write still created a fresh doomed order and
 * waited out the commit-reconcile budget before falling back to self-pay.
 * After 3 sponsor broadcast failures (SPONSOR_BROADCAST_PENDING / node
 * [-25]/[-26] rejects / "broadcast reconciliation in progress" rejections at
 * pre) within 5 minutes for the same bot address, the breaker trips for
 * 5 minutes: sponsored attempts for that address skip the sponsor entirely
 * and go straight to the self-paid path (reason 'circuit_open'). A sponsored
 * success — or the cooldown expiring — resets the breaker, so a recovered
 * sponsor is re-adopted automatically within at most one cooldown.
 *
 * State is process-local and in-memory on purpose: it is a latency/pressure
 * optimization, not a persistence concern, and losing it on restart only
 * means re-probing the sponsor once.
 */

/** ASCII error fingerprints of sponsor-side broadcast failures (never natural-language intent matching). */
const SPONSOR_BROADCAST_FAILURE_PATTERN = /SPONSOR_BROADCAST_PENDING|broadcast (?:failed|reconciliation)|missing inputs|txn-mempool-conflict/i;

export const SPONSOR_BREAKER_FAILURE_WINDOW_MS = 5 * 60_000;
export const SPONSOR_BREAKER_TRIP_THRESHOLD = 3;
export const SPONSOR_BREAKER_COOLDOWN_MS = 5 * 60_000;

interface SponsorBreakerState {
  /** Epoch-ms timestamps of recent sponsor broadcast failures (windowed). */
  failures: number[];
  /** Epoch ms until which sponsored attempts are skipped; 0 = closed. */
  trippedUntil: number;
}

const statesByAddress = new Map<string, SponsorBreakerState>();

function getState(address: string): SponsorBreakerState {
  let state = statesByAddress.get(address);
  if (!state) {
    state = { failures: [], trippedUntil: 0 };
    statesByAddress.set(address, state);
  }
  return state;
}

/** True when the error is a sponsor-side broadcast failure (the only counted class). */
export function isSponsorBroadcastFailureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return SPONSOR_BROADCAST_FAILURE_PATTERN.test(message);
}

export function isSponsorCircuitOpen(address: string, nowMs: number = Date.now()): boolean {
  const state = statesByAddress.get(address);
  return Boolean(state) && state.trippedUntil > nowMs;
}

/** Milliseconds until the breaker re-closes (for logging); 0 when closed. */
export function sponsorCircuitRetryAfterMs(address: string, nowMs: number = Date.now()): number {
  const state = statesByAddress.get(address);
  if (!state || state.trippedUntil <= nowMs) return 0;
  return state.trippedUntil - nowMs;
}

export function recordSponsorBroadcastFailure(
  address: string,
  nowMs: number = Date.now(),
): { failures: number; tripped: boolean } {
  if (!address) return { failures: 0, tripped: false };
  const state = getState(address);
  state.failures.push(nowMs);
  state.failures = state.failures.filter((at) => nowMs - at < SPONSOR_BREAKER_FAILURE_WINDOW_MS);
  if (state.trippedUntil <= nowMs && state.failures.length >= SPONSOR_BREAKER_TRIP_THRESHOLD) {
    state.trippedUntil = nowMs + SPONSOR_BREAKER_COOLDOWN_MS;
    return { failures: state.failures.length, tripped: true };
  }
  return { failures: state.failures.length, tripped: false };
}

/** A sponsored success proves the sponsor recovered — close the breaker immediately. */
export function recordSponsorSuccess(address: string): void {
  statesByAddress.delete(address);
}

/** Recent failure count within the window (for logging); 0 when none. */
export function sponsorCircuitRecentFailures(address: string, nowMs: number = Date.now()): number {
  const state = statesByAddress.get(address);
  if (!state) return 0;
  return state.failures.filter((at) => nowMs - at < SPONSOR_BREAKER_FAILURE_WINDOW_MS).length;
}

export function resetSponsorCircuitBreakerForTests(): void {
  statesByAddress.clear();
}
