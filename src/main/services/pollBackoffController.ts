/**
 * PollBackoffController — shared retry hygiene for background polling loops.
 *
 * Problem (issue #24 family): during a network outage the host's pollers
 * (chat-history backfill, provider-discovery online-status, the MetaTask
 * chain sweep) kept re-firing on their fixed short cadence for hours — no
 * backoff, no circuit breaker, nothing downstream could tell they were
 * hammering a dead endpoint. This module is the shared countermeasure:
 *
 *  - ESCALATING LADDER: each consecutive failure delays the next attempt by
 *    `baseMs * factor^failures` (capped at `maxTierMs`), jittered by
 *    ±jitterRatio so many instances do not re-align.
 *  - CIRCUIT BREAKER: after `openAfterFailures` consecutive failures the
 *    circuit OPENS — the loop must skip attempts entirely for `cooldownMs`.
 *    When the cooldown elapses the controller flips to HALF-OPEN and allows
 *    exactly one probe; a failed probe re-opens, a successful one closes.
 *  - VISIBILITY: every state transition emits one log line with the fixed
 *    `[PollBackoff:<name>]` prefix, so "is this loop backing off?" is a grep,
 *    not a guess.
 *
 * Single-flight contract: callers must guarantee at most one attempt is in
 * flight per controller (all integrated loops already have re-entry guards).
 * The controller does not start timers of its own — it only answers
 * `ready()` / `nextDelayMs()` questions and remembers outcomes.
 */

export type PollBackoffCircuit = 'closed' | 'open' | 'half-open';

export interface PollBackoffState {
  name: string;
  baseMs: number;
  consecutiveFailures: number;
  circuit: PollBackoffCircuit;
  /** Epoch ms of the earliest allowed next attempt. */
  nextAttemptAllowedAtMs: number;
  openedAtMs: number | null;
}

export interface PollBackoffOptions {
  /** Loop identity used in log lines (`[PollBackoff:<name>]`). */
  name: string;
  /** The loop's normal (healthy) cadence; tier delays grow from here. */
  baseMs: number;
  /** Multiplier per consecutive failure (default 2). */
  factor?: number;
  /** Absolute cap for one tier delay (default `baseMs * 16`). */
  maxTierMs?: number;
  /** Random jitter ratio in [0, 1) applied around each tier delay (default 0.2). */
  jitterRatio?: number;
  /** Consecutive failures before the circuit opens (default 5). */
  openAfterFailures?: number;
  /** How long an open circuit skips attempts before the half-open probe (default 10 min). */
  cooldownMs?: number;
  /** Clock seam (default Date.now). */
  now?: () => number;
  /** Random seam for jitter (default Math.random). */
  random?: () => number;
  /** Log sink; receives one line per state transition (default console.log). */
  emitLog?: (line: string) => void;
}

const DEFAULT_FACTOR = 2;
const DEFAULT_JITTER_RATIO = 0.2;
const DEFAULT_OPEN_AFTER_FAILURES = 5;
const DEFAULT_COOLDOWN_MS = 10 * 60_000;
const DEFAULT_MAX_TIER_MULTIPLIER = 16;

const formatDuration = (ms: number): string => {
  const totalSeconds = Math.max(1, Math.round(ms / 1_000));
  if (totalSeconds < 90) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 90) {
    const seconds = totalSeconds % 60;
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
};

export class PollBackoffController {
  private readonly name: string;
  private readonly baseMs: number;
  private readonly factor: number;
  private readonly maxTierMs: number;
  private readonly jitterRatio: number;
  private readonly openAfterFailures: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly emitLog: (line: string) => void;

  private consecutiveFailures = 0;
  private circuit: PollBackoffCircuit = 'closed';
  private nextAttemptAllowedAtMs = 0;
  private openedAtMs: number | null = null;

  constructor(options: PollBackoffOptions) {
    this.name = String(options.name ?? '').trim() || 'unnamed-poll';
    this.baseMs = Math.max(1, Math.trunc(options.baseMs ?? 0));
    this.factor = Math.max(1.1, Number(options.factor ?? DEFAULT_FACTOR));
    this.maxTierMs = Math.max(
      this.baseMs,
      Math.trunc(options.maxTierMs ?? this.baseMs * DEFAULT_MAX_TIER_MULTIPLIER),
    );
    this.jitterRatio = Math.min(
      0.9,
      Math.max(0, Number(options.jitterRatio ?? DEFAULT_JITTER_RATIO)),
    );
    this.openAfterFailures = Math.max(1, Math.trunc(options.openAfterFailures ?? DEFAULT_OPEN_AFTER_FAILURES));
    this.cooldownMs = Math.max(0, Math.trunc(options.cooldownMs ?? DEFAULT_COOLDOWN_MS));
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.emitLog = options.emitLog ?? ((line: string) => console.log(line));
  }

  /**
   * May an attempt start now? While the circuit is open this is false until
   * the cooldown elapses, at which point the controller flips to half-open
   * (exactly one probe allowed) and returns true.
   */
  ready(): boolean {
    if (this.circuit === 'open') {
      const openedAtMs = this.openedAtMs ?? this.now();
      if (this.now() < openedAtMs + this.cooldownMs) return false;
      this.circuit = 'half-open';
      this.emitLog(
        `[PollBackoff:${this.name}] half-open probe after cooldown — one attempt allowed`,
      );
      return true;
    }
    if (this.circuit === 'half-open') return true;
    return this.now() >= this.nextAttemptAllowedAtMs;
  }

  /** Record one failed attempt; escalates the ladder and may open the circuit. */
  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.circuit === 'half-open') {
      this.openCircuit(`probe failed (failure #${this.consecutiveFailures})`);
      return;
    }
    if (this.circuit === 'open') {
      // A failure recorded while open (e.g. an external demand-driven call
      // bypassed the gate): just keep the circuit open from now.
      this.openedAtMs = this.now();
      this.nextAttemptAllowedAtMs = this.openedAtMs + this.cooldownMs;
      return;
    }
    if (this.consecutiveFailures >= this.openAfterFailures) {
      this.openCircuit(`after ${this.consecutiveFailures} consecutive failures`);
      return;
    }
    const delayMs = this.delayForTier(this.consecutiveFailures);
    this.nextAttemptAllowedAtMs = this.now() + delayMs;
    this.emitLog(
      `[PollBackoff:${this.name}] backing off after failure #${this.consecutiveFailures} — next attempt in ~${formatDuration(delayMs)}`,
    );
  }

  /** Record one successful attempt; resets the ladder and closes the circuit. */
  recordSuccess(): void {
    const wasDegraded = this.consecutiveFailures > 0 || this.circuit !== 'closed';
    this.consecutiveFailures = 0;
    this.circuit = 'closed';
    this.openedAtMs = null;
    this.nextAttemptAllowedAtMs = this.now();
    if (wasDegraded) {
      this.emitLog(`[PollBackoff:${this.name}] recovered — resuming normal cadence`);
    }
  }

  /**
   * Delay for the loop's self-rescheduling timer: the remaining wait when an
   * attempt is gated, otherwise the healthy base cadence.
   */
  nextDelayMs(): number {
    const waitMs = this.nextAttemptAllowedAtMs - this.now();
    return waitMs > 0 ? waitMs : this.baseMs;
  }

  /** Snapshot for tests and future UI surfaces. */
  getState(): PollBackoffState {
    return {
      name: this.name,
      baseMs: this.baseMs,
      consecutiveFailures: this.consecutiveFailures,
      circuit: this.circuit,
      nextAttemptAllowedAtMs: this.nextAttemptAllowedAtMs,
      openedAtMs: this.openedAtMs,
    };
  }

  private openCircuit(reason: string): void {
    this.circuit = 'open';
    this.openedAtMs = this.now();
    this.nextAttemptAllowedAtMs = this.openedAtMs + this.cooldownMs;
    this.emitLog(
      `[PollBackoff:${this.name}] circuit OPEN (${reason}) — pausing attempts for ${formatDuration(this.cooldownMs)}`,
    );
  }

  /** Tier delay for the n-th consecutive failure (n >= 1), jittered. */
  private delayForTier(n: number): number {
    const rawMs = Math.min(this.maxTierMs, this.baseMs * Math.pow(this.factor, n));
    const jitter = 1 + (this.random() * 2 - 1) * this.jitterRatio;
    return Math.max(1, Math.round(rawMs * jitter));
  }
}
