// src/main/services/dailyReportSettings.ts — per-Twin Daily Report settings.
//
// Contract under test:
//   a. the enabled toggle persists '1'/'0' and gates on an EXPLICIT '1' only
//      (default OFF — an experimental proactive feature);
//   b. the hour normalizer accepts whole 0–23 only and rejects everything
//      else (null → caller falls back to the default hour);
//   c. resolveDailyReportHour falls back to 08:00 when unset or invalid.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DAILY_REPORT_ENABLED_KEY,
  DAILY_REPORT_HOUR_KEY,
  DEFAULT_DAILY_REPORT_HOUR,
  normalizeDailyReportEnabledValue,
  normalizeDailyReportHourValue,
  isDailyReportEnabled,
  resolveDailyReportHour,
} from '../src/main/services/dailyReportSettings.ts';

const readerWith = (kv) => ({
  getMetabotSetting: (_id, key) => (key in kv ? kv[key] : null),
});

test('enabled toggle: explicit 1 only — unset and 0 both mean OFF', () => {
  assert.equal(isDailyReportEnabled(readerWith({}), 1), false, 'unset defaults OFF');
  assert.equal(isDailyReportEnabled(readerWith({ [DAILY_REPORT_ENABLED_KEY]: '0' }), 1), false);
  assert.equal(isDailyReportEnabled(readerWith({ [DAILY_REPORT_ENABLED_KEY]: '1' }), 1), true);
});

test('normalizeDailyReportEnabledValue: 1/0-shaped values only', () => {
  assert.equal(normalizeDailyReportEnabledValue(true), '1');
  assert.equal(normalizeDailyReportEnabledValue('1'), '1');
  assert.equal(normalizeDailyReportEnabledValue(1), '1');
  assert.equal(normalizeDailyReportEnabledValue(false), '0');
  assert.equal(normalizeDailyReportEnabledValue('0'), '0');
  assert.equal(normalizeDailyReportEnabledValue(0), '0');
  assert.equal(normalizeDailyReportEnabledValue('yes'), null);
  assert.equal(normalizeDailyReportEnabledValue(2), null);
  assert.equal(normalizeDailyReportEnabledValue(null), null);
  assert.equal(normalizeDailyReportEnabledValue(undefined), null);
});

test('normalizeDailyReportHourValue: whole 0–23 only', () => {
  assert.equal(normalizeDailyReportHourValue(0), '0');
  assert.equal(normalizeDailyReportHourValue('8'), '8');
  assert.equal(normalizeDailyReportHourValue('23'), '23');
  assert.equal(normalizeDailyReportHourValue(23.4), '23', 'rounded to whole hour');
  assert.equal(normalizeDailyReportHourValue(-1), null);
  assert.equal(normalizeDailyReportHourValue(24), null);
  assert.equal(normalizeDailyReportHourValue('25'), null);
  assert.equal(normalizeDailyReportHourValue('abc'), null);
  assert.equal(normalizeDailyReportHourValue(''), null);
  assert.equal(normalizeDailyReportHourValue(null), null);
  assert.equal(normalizeDailyReportHourValue(8.5), '9', 'rounded, still in range');
});

test('resolveDailyReportHour: default 08:00 when unset or invalid', () => {
  assert.equal(resolveDailyReportHour(readerWith({}), 1), DEFAULT_DAILY_REPORT_HOUR);
  assert.equal(
    resolveDailyReportHour(readerWith({ [DAILY_REPORT_HOUR_KEY]: 'junk' }), 1),
    DEFAULT_DAILY_REPORT_HOUR,
  );
  assert.equal(resolveDailyReportHour(readerWith({ [DAILY_REPORT_HOUR_KEY]: '0' }), 1), 0);
  assert.equal(resolveDailyReportHour(readerWith({ [DAILY_REPORT_HOUR_KEY]: '17' }), 1), 17);
});
