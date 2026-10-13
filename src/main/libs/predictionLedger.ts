import { formatBotWorkspaceDate } from './botWorkspace';

/**
 * Prediction ledger (RSI-Anything P0) — pure helpers, no I/O.
 *
 * Bots record an explicit, machine-checkable prediction BEFORE a consequential
 * on-chain action (a buzz/comment, a MetaTask submission, a service delivery);
 * the nightly dream reconciles each pending prediction against the observed
 * outcome and folds a calibration digest into the dream prompt. This module
 * owns the deterministic halves of that loop:
 *  - the closed expectation schema per action type (validated at write time in
 *    the prediction_record tool),
 *  - the observed-vs-expected judging rules (hit / partial / miss),
 *  - the calibration-digest rendering for the dream prompt.
 * Storage lives in DreamStore (metabot_predictions); orchestration lives in
 * DreamService.
 */

export const PREDICTION_SOURCES = ['cowork', 'surf', 'metatask', 'service'] as const;
export type PredictionSource = (typeof PREDICTION_SOURCES)[number];

export const PREDICTION_ACTION_TYPES = [
  'buzz_post',
  'metaweb_comment',
  'metatask_submission',
  'service_delivery',
] as const;
export type PredictionActionType = (typeof PREDICTION_ACTION_TYPES)[number];

export const PREDICTION_STATUSES = ['pending', 'hit', 'miss', 'partial', 'expired', 'void'] as const;
export type PredictionStatus = (typeof PREDICTION_STATUSES)[number];

/** A prediction must say something concrete to be machine-checkable. */
export const PREDICTION_TEXT_MIN_CHARS = 10;
export const PREDICTION_TEXT_MAX_CHARS = 1000;
export const PREDICTION_SUBJECT_REF_MAX_CHARS = 200;
/** Default horizon: three days out (today + 3d). */
export const PREDICTION_RESOLVE_DEFAULT_DAYS = 3;
/** Nothing may stay open past two weeks — stale predictions are expired. */
export const PREDICTION_RESOLVE_MAX_DAYS = 14;
/** Calibration digest lookback (trailing 30 days). */
export const PREDICTION_CALIBRATION_WINDOW_DAYS = 30;
/** Recent misses folded into the digest. */
export const PREDICTION_DIGEST_MAX_RECENT_MISSES = 5;
/** One-line truncations inside the digest. */
export const PREDICTION_DIGEST_TEXT_MAX_CHARS = 120;

/** Reception metric set for buzz_post / metaweb_comment predictions. */
export const PREDICTION_RECEPTION_METRICS = ['likes', 'comments', 'interactions'] as const;
export type PredictionReceptionMetric = (typeof PREDICTION_RECEPTION_METRICS)[number];

/** Boolean metrics: metatask_submission → review_pass, service_delivery → order_completed. */
export const PREDICTION_BOOLEAN_METRIC: Record<'metatask_submission' | 'service_delivery', string> = {
  metatask_submission: 'review_pass',
  service_delivery: 'order_completed',
};

export type PredictionValidationResult =
  | {
    ok: true;
    actionType: PredictionActionType;
    source: PredictionSource;
    predictionText: string;
    subjectRef: string | null;
    expectation: Record<string, unknown>;
    resolveDeadline: string;
  }
  | { ok: false; error: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

const shiftDateKey = (todayKey: string, days: number): string => {
  const [year, month, day] = todayKey.split('-').map((part) => Number(part));
  return formatBotWorkspaceDate(new Date(year, (month || 1) - 1, (day || 1) + days));
};

/**
 * Deterministically validate one prediction_record call. Everything the dream
 * reconciler later relies on is pinned here: the closed per-action metric set,
 * the minimum concreteness of the prediction text, and the bounded resolution
 * horizon (default today+3d, max today+14d). `todayKey` is the caller's local
 * YYYY-MM-DD.
 */
export function validatePredictionInput(input: {
  actionType?: unknown;
  source?: unknown;
  predictionText?: unknown;
  subjectRef?: unknown;
  expectation?: unknown;
  resolveDeadline?: unknown;
  defaultSource?: PredictionSource;
  todayKey: string;
}): PredictionValidationResult {
  const actionType = typeof input.actionType === 'string' ? input.actionType.trim() : '';
  if (!(PREDICTION_ACTION_TYPES as readonly string[]).includes(actionType)) {
    return {
      ok: false,
      error: `action_type must be one of ${PREDICTION_ACTION_TYPES.join(' | ')} (got "${actionType || '(missing)'}").`,
    };
  }
  const sourceRaw = typeof input.source === 'string' && input.source.trim() ? input.source.trim() : (input.defaultSource ?? 'cowork');
  if (!(PREDICTION_SOURCES as readonly string[]).includes(sourceRaw)) {
    return {
      ok: false,
      error: `source must be one of ${PREDICTION_SOURCES.join(' | ')} (got "${sourceRaw}").`,
    };
  }
  const predictionText = typeof input.predictionText === 'string' ? input.predictionText.trim() : '';
  if (predictionText.length < PREDICTION_TEXT_MIN_CHARS) {
    return {
      ok: false,
      error: `prediction_text is too vague — write a concrete, checkable expectation in at least ${PREDICTION_TEXT_MIN_CHARS} characters.`,
    };
  }
  if (predictionText.length > PREDICTION_TEXT_MAX_CHARS) {
    return { ok: false, error: `prediction_text exceeds ${PREDICTION_TEXT_MAX_CHARS} characters.` };
  }
  const subjectRef = typeof input.subjectRef === 'string' && input.subjectRef.trim() ? input.subjectRef.trim() : null;
  if (subjectRef && subjectRef.length > PREDICTION_SUBJECT_REF_MAX_CHARS) {
    return { ok: false, error: `subject_ref exceeds ${PREDICTION_SUBJECT_REF_MAX_CHARS} characters.` };
  }

  const expectation = input.expectation;
  if (!isPlainObject(expectation)) {
    return { ok: false, error: 'expectation must be an object shaped per action_type (see the tool description).' };
  }
  const metric = typeof expectation.metric === 'string' ? expectation.metric.trim() : '';
  if (actionType === 'buzz_post' || actionType === 'metaweb_comment') {
    if (!(PREDICTION_RECEPTION_METRICS as readonly string[]).includes(metric)) {
      return {
        ok: false,
        error: `for ${actionType} the expectation metric must be one of ${PREDICTION_RECEPTION_METRICS.join(' | ')} (got "${metric || '(missing)'}").`,
      };
    }
    if (expectation.op !== '>=') {
      return { ok: false, error: `for ${actionType} the expectation op must be ">=" (got ${JSON.stringify(expectation.op)}).` };
    }
    const value = Number(expectation.value);
    if (!Number.isInteger(value) || value < 1) {
      return { ok: false, error: `for ${actionType} the expectation value must be an integer >= 1 (got ${JSON.stringify(expectation.value)}).` };
    }
    const extraKeys = Object.keys(expectation).filter((key) => !['metric', 'op', 'value'].includes(key));
    if (extraKeys.length > 0) {
      return { ok: false, error: `expectation carries unknown keys (${extraKeys.join(', ')}) — the schema is closed: { metric, op, value }.` };
    }
    return finalize(input, actionType as PredictionActionType, sourceRaw as PredictionSource, predictionText, subjectRef, {
      metric,
      op: '>=',
      value,
    });
  }
  const expectedMetric = PREDICTION_BOOLEAN_METRIC[actionType as 'metatask_submission' | 'service_delivery'];
  if (metric !== expectedMetric) {
    return {
      ok: false,
      error: `for ${actionType} the expectation metric must be "${expectedMetric}" (got "${metric || '(missing)'}").`,
    };
  }
  if (expectation.value !== true) {
    return { ok: false, error: `for ${actionType} the expectation value must be true (got ${JSON.stringify(expectation.value)}).` };
  }
  const extraKeys = Object.keys(expectation).filter((key) => !['metric', 'value'].includes(key));
  if (extraKeys.length > 0) {
    return { ok: false, error: `expectation carries unknown keys (${extraKeys.join(', ')}) — the schema is closed: { metric, value }.` };
  }
  return finalize(input, actionType as PredictionActionType, sourceRaw as PredictionSource, predictionText, subjectRef, {
    metric: expectedMetric,
    value: true,
  });
}

function finalize(
  input: { resolveDeadline?: unknown; todayKey: string },
  actionType: PredictionActionType,
  source: PredictionSource,
  predictionText: string,
  subjectRef: string | null,
  expectation: Record<string, unknown>,
): PredictionValidationResult {
  const todayKey = DATE_KEY_RE.test(input.todayKey) ? input.todayKey : formatBotWorkspaceDate(new Date());
  const rawDeadline = typeof input.resolveDeadline === 'string' && input.resolveDeadline.trim()
    ? input.resolveDeadline.trim()
    : null;
  if (rawDeadline && !DATE_KEY_RE.test(rawDeadline)) {
    return { ok: false, error: `resolve_deadline must be a YYYY-MM-DD date (got "${rawDeadline}").` };
  }
  const deadline = rawDeadline ?? shiftDateKey(todayKey, PREDICTION_RESOLVE_DEFAULT_DAYS);
  if (deadline < todayKey) {
    return { ok: false, error: `resolve_deadline ${deadline} is in the past — give the prediction room to be observed (default is today + ${PREDICTION_RESOLVE_DEFAULT_DAYS}d).` };
  }
  const maxDeadline = shiftDateKey(todayKey, PREDICTION_RESOLVE_MAX_DAYS);
  if (deadline > maxDeadline) {
    return { ok: false, error: `resolve_deadline ${deadline} is too far out — the horizon is capped at today + ${PREDICTION_RESOLVE_MAX_DAYS}d (${maxDeadline}).` };
  }
  return {
    ok: true,
    actionType,
    source,
    predictionText,
    subjectRef,
    expectation,
    resolveDeadline: deadline,
  };
}

/**
 * Judge one numeric (reception) expectation against the observed count:
 * observed >= target → hit; some reception but below target → partial; zero →
 * miss.
 */
export function judgeNumericExpectation(expectation: Record<string, unknown>, observed: number): 'hit' | 'partial' | 'miss' {
  const target = Number(expectation.value);
  if (Number.isFinite(target) && observed >= target) return 'hit';
  return observed > 0 ? 'partial' : 'miss';
}

/** Judge one boolean expectation (review_pass / order_completed). */
export function judgeBooleanExpectation(observed: boolean): 'hit' | 'miss' {
  return observed ? 'hit' : 'miss';
}

/** Per-action-type status rollup inside the calibration digest. */
export interface PredictionCalibrationBucket {
  hit: number;
  miss: number;
  partial: number;
  expired: number;
  /** hit + miss + partial (expired predictions never entered the judged set). */
  resolved: number;
  /** hit / resolved as a 0..1 ratio; null when nothing judged yet. */
  hitRate: number | null;
}

export interface PredictionCalibrationDigest {
  windowDays: number;
  pendingCount: number;
  byActionType: Partial<Record<PredictionActionType, PredictionCalibrationBucket>>;
  /** Recent misses AND partials (a near-miss is calibration signal too), newest first. */
  recentMisses: Array<{
    actionType: PredictionActionType;
    status: 'miss' | 'partial';
    predictionText: string;
    outcomeText: string | null;
    resolvedAt: number | null;
  }>;
}

export function isEmptyCalibrationDigest(digest: PredictionCalibrationDigest | null | undefined): boolean {
  if (!digest) return true;
  const resolvedTotal = Object.values(digest.byActionType).reduce((sum, bucket) => sum + (bucket?.resolved ?? 0) + (bucket?.expired ?? 0), 0);
  return resolvedTotal === 0 && digest.pendingCount === 0;
}

const truncateDigestText = (text: string, maxChars = PREDICTION_DIGEST_TEXT_MAX_CHARS): string => {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}…` : normalized;
};

/**
 * Render the calibration digest as one dream-prompt section. '' when the bot
 * has no prediction data at all — the dream never sees an empty section.
 */
export function renderPredictionCalibrationDigest(digest: PredictionCalibrationDigest): string {
  if (isEmptyCalibrationDigest(digest)) return '';
  const lines: string[] = [];
  const totalResolved = Object.values(digest.byActionType).reduce((sum, bucket) => sum + (bucket?.resolved ?? 0), 0);
  lines.push(`近 ${digest.windowDays} 天预测-结果对账:已裁决 ${totalResolved} 条,待裁决 ${digest.pendingCount} 条。`);
  for (const actionType of PREDICTION_ACTION_TYPES) {
    const bucket = digest.byActionType[actionType];
    if (!bucket || (bucket.resolved === 0 && bucket.expired === 0)) continue;
    const rate = bucket.hitRate === null ? '命中率 n/a' : `命中率 ${Math.round(bucket.hitRate * 100)}%`;
    const expiredNote = bucket.expired > 0 ? `,过期未裁决 ${bucket.expired}` : '';
    lines.push(`- ${actionType}:已裁决 ${bucket.resolved}(命中 ${bucket.hit} / 部分命中 ${bucket.partial} / 落空 ${bucket.miss},${rate}${expiredNote})`);
  }
  if (digest.recentMisses.length > 0) {
    lines.push('近期落空/部分命中的预测(预测 vs 实际,逐条对照反思你的判断是否过于乐观或悲观):');
    for (const miss of digest.recentMisses) {
      const statusLabel = miss.status === 'partial' ? '部分命中' : '落空';
      const outcome = miss.outcomeText ? ` → 实际:${truncateDigestText(miss.outcomeText)}` : '';
      lines.push(`- [${miss.actionType}][${statusLabel}] 预测「${truncateDigestText(miss.predictionText)}」${outcome}`);
    }
  }
  return lines.join('\n');
}
