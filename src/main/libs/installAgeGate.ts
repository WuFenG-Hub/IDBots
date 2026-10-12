/**
 * Fresh-install deferral for background LLM automation (2026-10-12).
 *
 * Incident: a brand-new install handed the user a 2M-token free starter
 * allowance, then burned it before the user typed anything — the onboarding
 * greeting turn (~88k tokens), an A2A auto-reply that read the chain for a
 * while (~340k), and then the nightly pipeline: a first pre-dream surf that
 * really surfed, followed by six more "[编排任务] …surf session" runs in 20
 * seconds (one per catch-up dream date, each dying on QUOTA). The user's own
 * first message then failed with no allowance left.
 *
 * Product decision: on a fresh install, background LLM daemons (dream +
 * catch-up, the pre-dream surf, and the overnight study queue) stay deferred
 * for 24 hours. User-facing turns — the onboarding greeting, normal chat — are
 * never gated.
 *
 * The anchor is the machine's earliest durable install signal: the local user
 * identity's `created_at`, falling back to the oldest bot's `created_at`. Both
 * already exist on upgraded installs (an identity created months ago, bots
 * created months ago), so an upgrade is never deferred; only a machine whose
 * account/bots were created within the deferral window is.
 *
 * Fail-open rule: when no anchor can be read but the machine already holds
 * bots, background automation is NOT deferred — a partially readable store
 * must never silently stop an existing user's nightly work. With neither an
 * anchor nor any bot, deferring is a no-op anyway (every daemon needs a bot to
 * act on).
 */

/** How long background automation stays off after the install anchor. */
export const BACKGROUND_AUTOMATION_DEFERRAL_MS = 24 * 60 * 60 * 1000;

export interface InstallAgeGateInput {
  /** Epoch ms of the earliest durable install signal, or null when unknown. */
  anchorMs: number | null;
  /** Whether the machine already holds at least one bot (upgrade safety). */
  hasExistingBots: boolean;
  nowMs?: number;
  deferralMs?: number;
}

export interface InstallAgeGateState {
  deferred: boolean;
  /** One-line reason for the skip log; empty when not deferred. */
  reason: string;
  anchorMs: number | null;
  /** Milliseconds left in the deferral window (0 when not deferred). */
  remainingMs: number;
}

const isFinitePositiveMs = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * Resolve the install anchor from the durable timestamps the machine already
 * has: the local user identity (created by the first relay bootstrap, or by
 * the user long ago) first, then the oldest bot row. Null when neither exists.
 */
export function pickInstallAnchorMs(input: {
  identityCreatedAtMs?: number | null;
  metabotCreatedAtMs?: Array<number | null | undefined>;
}): number | null {
  if (isFinitePositiveMs(input?.identityCreatedAtMs)) {
    return input.identityCreatedAtMs;
  }
  const botTimestamps = (input?.metabotCreatedAtMs ?? []).filter(isFinitePositiveMs);
  if (botTimestamps.length === 0) {
    return null;
  }
  return Math.min(...botTimestamps);
}

/**
 * Whether background automation must stay off right now.
 *
 * - anchor inside the deferral window → deferred
 * - anchor at/older than the window → allowed (exactly 24h counts as elapsed)
 * - no anchor + existing bots → allowed (fail-open for upgrades)
 * - no anchor + no bots → deferred (nothing for the daemons to act on anyway)
 */
export function evaluateInstallAgeGate(input: InstallAgeGateInput): InstallAgeGateState {
  const nowMs = typeof input?.nowMs === 'number' && Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const deferralMs = isFinitePositiveMs(input?.deferralMs)
    ? input.deferralMs
    : BACKGROUND_AUTOMATION_DEFERRAL_MS;
  const anchorMs = isFinitePositiveMs(input?.anchorMs) ? input.anchorMs : null;

  if (anchorMs == null) {
    if (input?.hasExistingBots) {
      return { deferred: false, reason: '', anchorMs: null, remainingMs: 0 };
    }
    return {
      deferred: true,
      reason: 'no install anchor yet and no bots on this machine',
      anchorMs: null,
      remainingMs: deferralMs,
    };
  }

  const ageMs = Math.max(0, nowMs - anchorMs);
  if (ageMs >= deferralMs) {
    return { deferred: false, reason: '', anchorMs, remainingMs: 0 };
  }
  const remainingMs = deferralMs - ageMs;
  const hours = Math.floor(remainingMs / (60 * 60 * 1000));
  const minutes = Math.ceil((remainingMs % (60 * 60 * 1000)) / (60 * 1000));
  return {
    deferred: true,
    reason: `install is ${Math.floor(ageMs / (60 * 60 * 1000))}h old; ${hours}h${minutes}m left of the 24h fresh-install window`,
    anchorMs,
    remainingMs,
  };
}
