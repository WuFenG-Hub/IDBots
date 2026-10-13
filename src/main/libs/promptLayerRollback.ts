import type { DreamDayActivity } from '../dreamStore';
import { extractImplicitSignals } from './implicitSignals';

/**
 * Prompt-layer retention gate (RSI-Anything P0) — pure helpers, no I/O.
 *
 * The nightly dream rewrites the bot's prompt-injected layers (dream-origin
 * memories, promoted procedures). A bad night must be REVERSIBLE: before every
 * write the previous layer is snapshotted (DreamStore), and at the start of
 * the next dream run this gate decides — deterministically, no LLM — whether
 * yesterday carried a negative-feedback spike strong enough to roll the last
 * written layer back. This module owns the counting and the trigger math;
 * DreamService owns the orchestration and the store writes.
 */

/** Absolute floor: below this many negative signals a rollback never fires. */
export const ROLLBACK_NEGATIVE_FLOOR = 2;
/** Baseline window: trailing 14 days of daily negative-signal counts. */
export const ROLLBACK_BASELINE_DAYS = 14;
/**
 * With fewer baseline days than this the median is noise, so the cold-start
 * absolute bar applies instead of the baseline comparison.
 */
export const ROLLBACK_BASELINE_MIN_DAYS = 7;
/** Cold-start bar (used while the baseline has < ROLLBACK_BASELINE_MIN_DAYS days). */
export const ROLLBACK_COLD_START_MIN_NEGATIVE = 3;
/** Snapshots retained per bot; oldest superseded/rolled_back rows prune first. */
export const ROLLBACK_MAX_SNAPSHOTS_PER_BOT = 30;
/** Accepted group tasks rated at or below this count as negative. */
export const ROLLBACK_LOW_RATING_THRESHOLD = 2;

/**
 * One day's negative-signal count, from the same mechanically-extracted
 * signals the dream already collects: thumbs-down assistant messages, accepted
 * group tasks rated ≤ ROLLBACK_LOW_RATING_THRESHOLD, and the implicit
 * structural signals (reask / unanswered_burst — repeat_order is load-bearing
 * neutral and never counts). Uses activity.implicitSignals when the caller
 * already attached them, else computes them here.
 */
export function countNegativeSignalsForDay(activity: DreamDayActivity): number {
  let count = 0;
  for (const session of activity.sessions) {
    for (const message of session.messages) {
      if (message.type === 'assistant' && message.feedbackRating === 'down') count += 1;
    }
  }
  for (const task of activity.groupTasks ?? []) {
    const phase = task.phase ?? 'accepted';
    if (phase === 'accepted' && task.rating != null && task.rating <= ROLLBACK_LOW_RATING_THRESHOLD) {
      count += 1;
    }
  }
  const signals = activity.implicitSignals ?? extractImplicitSignals(activity);
  for (const signal of signals) {
    if (signal.kind === 'reask' || signal.kind === 'unanswered_burst') count += 1;
  }
  return count;
}

/** Median of a non-empty numeric list (average of the two middle values). */
export function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface PromptLayerRollbackVerdict {
  triggered: boolean;
  /** Human-readable trigger reason (audit + snapshot.rollback_reason). */
  reason: string | null;
  /** Baseline median when one was computed (null in the cold-start regime). */
  baselineMedian: number | null;
}

/**
 * The retention gate. Fires only when ALL hold:
 *  - negativeToday >= ROLLBACK_NEGATIVE_FLOOR (absolute floor), and
 *  - negativeToday > trailing-14d daily median + 1 (baseline comparison over
 *    the days that had any activity; with < ROLLBACK_BASELINE_MIN_DAYS such
 *    days the cold-start rule applies: negativeToday >=
 *    ROLLBACK_COLD_START_MIN_NEGATIVE, median ignored).
 */
export function evaluatePromptLayerRollback(input: {
  negativeToday: number;
  /** Daily negative-signal counts of the trailing baseline days that had any activity. */
  baselineDailyNegatives: number[];
}): PromptLayerRollbackVerdict {
  const negativeToday = Math.max(0, Math.floor(Number(input.negativeToday) || 0));
  const baseline = (input.baselineDailyNegatives ?? [])
    .map((value) => Math.max(0, Math.floor(Number(value) || 0)));
  if (baseline.length < ROLLBACK_BASELINE_MIN_DAYS) {
    if (negativeToday >= ROLLBACK_COLD_START_MIN_NEGATIVE) {
      return {
        triggered: true,
        reason: `cold start: ${negativeToday} negative signal(s) >= ${ROLLBACK_COLD_START_MIN_NEGATIVE} (only ${baseline.length} baseline day(s) with activity)`,
        baselineMedian: null,
      };
    }
    return { triggered: false, reason: null, baselineMedian: null };
  }
  const median = medianOf(baseline) ?? 0;
  if (negativeToday >= ROLLBACK_NEGATIVE_FLOOR && negativeToday > median + 1) {
    return {
      triggered: true,
      reason: `${negativeToday} negative signal(s) > trailing-14d daily median ${median} + 1`,
      baselineMedian: median,
    };
  }
  return { triggered: false, reason: null, baselineMedian: median };
}

/**
 * The notice folded into tonight's dream prompt after a rollback — the dream
 * must treat the rolled-back day's lessons with suspicion.
 */
export function buildRollbackNotice(rolledBackDate: string): string {
  return `${rolledBackDate} 的提示层已因负反馈激增被自动回滚;蒸馏时请对那一天产出的教训保持警觉,不要直接沿用。`;
}
