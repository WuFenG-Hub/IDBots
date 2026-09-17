import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runsToTelemetryDays, movingAverage, cumulative } from '../src/renderer/components/settings/dreamTelemetrySeries.ts';

test('runsToTelemetryDays keeps only completed runs and sorts ascending', () => {
  const days = runsToTelemetryDays([
    { dreamDate: '2026-09-03', status: 'completed', telemetry: { replay: { points: 1 } } },
    { dreamDate: '2026-09-01', status: 'failed', telemetry: { replay: { points: 9 } } },
    { dreamDate: '2026-09-01', status: 'completed', telemetry: { replay: { points: 2 } } },
    { dreamDate: '2026-09-02', status: 'running', telemetry: { replay: { points: 8 } } },
  ]);
  assert.deepEqual(days.map((day) => day.date), ['2026-09-01', '2026-09-03']);
  assert.deepEqual(days.map((day) => day.negativePoints), [2, 1]);
});

test('runsToTelemetryDays maps replay/validation/token fields', () => {
  const [day] = runsToTelemetryDays([
    {
      dreamDate: '2026-09-05',
      status: 'completed',
      telemetry: {
        estimatedActivityTokens: 1500,
        diaryUnmatchedRefs: 3,
        validation: { checked: 4, validated: 2, rejected: 1 },
        replay: { points: 5, lessons: 2, pointsByKind: { thumbs_down: 5 } },
      },
    },
  ]);
  assert.equal(day.hasTelemetry, true);
  assert.equal(day.negativePoints, 5);
  assert.equal(day.lessons, 2);
  assert.equal(day.draftsChecked, 4);
  assert.equal(day.draftsValidated, 2);
  assert.equal(day.draftsRejected, 1);
  assert.equal(day.unmatchedRefs, 3);
  assert.equal(day.activityTokens, 1500);
});

test('runsToTelemetryDays treats empty days as zero activity with null unmatched refs', () => {
  const [day] = runsToTelemetryDays([
    {
      dreamDate: '2026-09-06',
      status: 'completed',
      telemetry: { emptyDay: true, validation: { checked: 2, validated: 1, rejected: 0 }, replay: { points: 0, lessons: 0 } },
    },
  ]);
  assert.equal(day.hasTelemetry, true);
  assert.equal(day.negativePoints, 0);
  assert.equal(day.lessons, 0);
  assert.equal(day.draftsChecked, 2);
  assert.equal(day.unmatchedRefs, null);
  assert.equal(day.activityTokens, 0);
});

test('runsToTelemetryDays tolerates missing and garbage telemetry shapes', () => {
  const days = runsToTelemetryDays([
    { dreamDate: '2026-09-01', status: 'completed', telemetry: 'not-an-object' },
    { dreamDate: '2026-09-02', status: 'completed', telemetry: [1, 2, 3] },
    { dreamDate: '2026-09-03', status: 'completed', telemetry: null },
    { dreamDate: '2026-09-04', status: 'completed' },
    {
      dreamDate: '2026-09-05',
      status: 'completed',
      telemetry: { validation: { checked: { nested: 1 }, validated: 'abc', rejected: [] }, replay: 'x', diaryUnmatchedRefs: NaN },
    },
  ]);
  assert.equal(days.length, 5);
  for (const day of days.slice(0, 4)) {
    assert.equal(day.hasTelemetry, false);
    assert.deepEqual(
      [day.negativePoints, day.lessons, day.draftsChecked, day.draftsValidated, day.draftsRejected, day.unmatchedRefs, day.activityTokens],
      [null, null, null, null, null, null, null],
    );
  }
  const garbage = days[4];
  assert.equal(garbage.hasTelemetry, true);
  assert.equal(garbage.negativePoints, 0);
  assert.equal(garbage.draftsChecked, 0);
  assert.equal(garbage.draftsValidated, 0);
  assert.equal(garbage.draftsRejected, 0);
  assert.equal(garbage.unmatchedRefs, null);
});

test('runsToTelemetryDays coerces numeric strings but rejects non-finite numbers', () => {
  const [day] = runsToTelemetryDays([
    {
      dreamDate: '2026-09-07',
      status: 'completed',
      telemetry: { replay: { points: '4' }, diaryUnmatchedRefs: Infinity, estimatedActivityTokens: '800' },
    },
  ]);
  assert.equal(day.negativePoints, 4);
  assert.equal(day.unmatchedRefs, null);
  assert.equal(day.activityTokens, 800);
});

test('runsToTelemetryDays dedupes duplicate dates with the last run winning', () => {
  const days = runsToTelemetryDays([
    { dreamDate: '2026-09-01', status: 'completed', telemetry: { replay: { points: 1 } } },
    { dreamDate: '2026-09-01', status: 'completed', telemetry: { replay: { points: 7 } } },
  ]);
  assert.equal(days.length, 1);
  assert.equal(days[0].negativePoints, 7);
});

test('movingAverage averages trailing non-null values within the window', () => {
  assert.deepEqual(movingAverage([1, 2, 3, 4], 2), [1, 1.5, 2.5, 3.5]);
  assert.deepEqual(movingAverage([2, 4, 6], 3), [2, 3, 4]);
  assert.deepEqual(movingAverage([1, null, 3], 2), [1, 1, 3]);
  assert.deepEqual(movingAverage([null, null], 3), [null, null]);
  assert.deepEqual(movingAverage([], 7), []);
});

test('cumulative accumulates running totals', () => {
  assert.deepEqual(cumulative([1, 2, 3]), [1, 3, 6]);
  assert.deepEqual(cumulative([]), []);
  assert.deepEqual(cumulative([0, 0, 5]), [0, 0, 5]);
});
