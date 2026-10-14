/**
 * Weekly free-quota reset countdown, shared by the chat free-quota card
 * (FreeQuotaCard) and the cerebellum settings area. Both renderers consume
 * the same quotaCycleResetAt from the same quota snapshot, so routing the
 * formatting through one helper keeps the two displays from drifting apart.
 *
 * quotaCycleResetAt is absent/0 when the backend runs lifetime quotas — no
 * countdown is rendered in that mode.
 */

const DAY_MS = 86_400_000;

/** Translate function shaped after i18nService.t (passed in to keep this pure). */
export type QuotaTranslate = (key: string) => string;

/** Whole days until the cycle resets, rounded up; 0 means imminent or disabled. */
export function quotaResetDaysLeft(resetAt: number, now: number = Date.now()): number {
  if (!Number.isFinite(resetAt) || resetAt <= 0) return 0;
  const days = Math.ceil((resetAt - now) / DAY_MS);
  // Math.ceil over a negative delta yields -0; normalize so callers compare === 0.
  return days > 0 ? days : 0;
}

/**
 * Countdown suffix to append to a quota line ('· N 天后重置' / '· 即将重置').
 * Returns '' when weekly quotas are disabled (resetAt absent/0).
 */
export function formatQuotaResetSuffix(resetAt: number, translate: QuotaTranslate, now: number = Date.now()): string {
  if (!Number.isFinite(resetAt) || resetAt <= 0) return '';
  const days = quotaResetDaysLeft(resetAt, now);
  if (days <= 0) return translate('freeQuotaResetImminent');
  return translate('freeQuotaResetCountdown').replace('{n}', String(days));
}
