/**
 * Pure data shaping for the dream telemetry trend panel. No React imports —
 * kept separate from DreamTelemetryPanel.tsx so it stays unit-testable.
 *
 * The main process writes one telemetry JSON blob per completed dream run
 * (src/main/services/dreamService.ts → updateRunTelemetry). All fields are
 * optional in practice, so every read here is defensive.
 */

export interface DreamRunTelemetry {
  emptyDay?: boolean;
  fastPath?: boolean;
  fragmentCount?: number;
  estimatedActivityTokens?: number;
  outputChars?: number;
  implicitSignals?: number;
  /** Absent on empty days; hallucination proxy (lower = better). */
  diaryUnmatchedRefs?: number;
  validation?: { checked?: number; validated?: number; rejected?: number };
  replay?: { points?: number; lessons?: number; pointsByKind?: Record<string, number> };
  weeklyLongDream?: boolean;
  durationMs?: number;
}

/** One trend row per dream date. */
export interface TelemetryDay {
  date: string;
  hasTelemetry: boolean;
  /** Daily negative-outcome decision points replayed (telemetry.replay.points). */
  negativePoints: number | null;
  /** Replay lessons written as value boundaries. */
  lessons: number | null;
  draftsChecked: number | null;
  draftsValidated: number | null;
  draftsRejected: number | null;
  /**
   * Diary references matching no real record. Null on empty days (no diary was
   * written) and on runs without usable telemetry — genuinely not measurable.
   */
  unmatchedRefs: number | null;
  activityTokens: number | null;
}

export interface DreamRunLike {
  dreamDate: string;
  status: string;
  telemetry?: unknown;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Number(x) coercion with guards: arrays/booleans/objects/garbage → null. */
const coerceNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const nullDay = (date: string): TelemetryDay => ({
  date,
  hasTelemetry: false,
  negativePoints: null,
  lessons: null,
  draftsChecked: null,
  draftsValidated: null,
  draftsRejected: null,
  unmatchedRefs: null,
  activityTokens: null,
});

/**
 * Completed runs only, ascending by dream date. Runs whose telemetry is not a
 * plain object keep a placeholder day with all-null metrics so the x-axis
 * still lines up with the diary list. Duplicate dates: the last run in the
 * input array wins.
 */
export function runsToTelemetryDays(runs: DreamRunLike[]): TelemetryDay[] {
  const byDate = new Map<string, TelemetryDay>();
  for (const run of runs) {
    if (run.status !== 'completed') continue;
    if (!isPlainObject(run.telemetry)) {
      byDate.set(run.dreamDate, nullDay(run.dreamDate));
      continue;
    }
    const telemetry = run.telemetry as DreamRunTelemetry;
    const validation = isPlainObject(telemetry.validation) ? telemetry.validation : undefined;
    const replay = isPlainObject(telemetry.replay) ? telemetry.replay : undefined;
    // Empty days still validate pending drafts, but write no diary and replay
    // no negative points — mirror that asymmetry in the derived fields.
    const emptyDay = telemetry.emptyDay === true;
    byDate.set(run.dreamDate, {
      date: run.dreamDate,
      hasTelemetry: true,
      negativePoints: emptyDay ? 0 : (coerceNumber(replay?.points) ?? 0),
      lessons: emptyDay ? 0 : (coerceNumber(replay?.lessons) ?? 0),
      draftsChecked: coerceNumber(validation?.checked) ?? 0,
      draftsValidated: coerceNumber(validation?.validated) ?? 0,
      draftsRejected: coerceNumber(validation?.rejected) ?? 0,
      unmatchedRefs: emptyDay ? null : coerceNumber(telemetry.diaryUnmatchedRefs),
      activityTokens: emptyDay ? 0 : (coerceNumber(telemetry.estimatedActivityTokens) ?? 0),
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Trailing moving average over non-null values: each slot averages the
 * non-null entries among values[i - windowSize + 1 .. i]. Null when the
 * window contains no non-null values.
 */
export function movingAverage(values: Array<number | null>, windowSize: number): Array<number | null> {
  const size = Math.max(1, Math.floor(windowSize));
  return values.map((_, index) => {
    const window = values.slice(Math.max(0, index - size + 1), index + 1);
    let sum = 0;
    let count = 0;
    for (const value of window) {
      if (value !== null) {
        sum += value;
        count += 1;
      }
    }
    return count === 0 ? null : sum / count;
  });
}

/** Running totals. */
export function cumulative(values: number[]): number[] {
  let sum = 0;
  return values.map((value) => {
    sum += value;
    return sum;
  });
}
