/**
 * Per-Twin Daily Report (每日汇报) settings.
 *
 * Persisted through the generic metabot_settings kv store and whitelisted for
 * the renderer in metabotSettingsService. Unlike the surf defaults, the
 * report is an experimental proactive feature: it fires ONLY when the owner
 * explicitly turned it on (an explicit '1' — default OFF) and the global
 * experimental-automation master switch allows it. The hour is a whole local
 * hour 0–23 (default 08:00).
 */

import type { MetabotStore } from '../metabotStore';

/** Structural subset of MetabotStore the report settings need (test-friendly). */
export interface DailyReportSettingsReader {
  getMetabotSetting(metabotId: number, key: string): string | null;
}

/** '1' (on) / '0' (off); UNSET means OFF (default-off experimental feature). */
export const DAILY_REPORT_ENABLED_KEY = 'dailyReport.enabled';
/** Whole local hour 0–23 as an integer string. */
export const DAILY_REPORT_HOUR_KEY = 'dailyReport.hour';

export const DEFAULT_DAILY_REPORT_HOUR = 8;
export const MIN_DAILY_REPORT_HOUR = 0;
export const MAX_DAILY_REPORT_HOUR = 23;

/** Renderer-input normalizer for the toggle: '1'/'0'-shaped values only. */
export const normalizeDailyReportEnabledValue = (value: unknown): string | null => {
  if (value === true || value === '1' || value === 1) return '1';
  if (value === false || value === '0' || value === 0) return '0';
  return null;
};

/** Renderer-input normalizer for the hour: whole 0–23, else rejected. */
export const normalizeDailyReportHourValue = (value: unknown): string | null => {
  const num = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num)) return null;
  const int = Math.round(num);
  if (int < MIN_DAILY_REPORT_HOUR || int > MAX_DAILY_REPORT_HOUR) return null;
  return String(int);
};

/**
 * Fire gate: an explicit '1' only. A bot (or a Twin that never touched the
 * setting) defaults to OFF, so enabling the experimental master switch never
 * silently turns on proactive daily messages.
 */
export const isDailyReportEnabled = (reader: DailyReportSettingsReader, metabotId: number): boolean =>
  reader.getMetabotSetting(metabotId, DAILY_REPORT_ENABLED_KEY) === '1';

/** Configured local hour; invalid or unset values fall back to 08:00. */
export const resolveDailyReportHour = (reader: DailyReportSettingsReader, metabotId: number): number => {
  const raw = reader.getMetabotSetting(metabotId, DAILY_REPORT_HOUR_KEY);
  const normalized = raw === null ? null : normalizeDailyReportHourValue(raw);
  return normalized === null ? DEFAULT_DAILY_REPORT_HOUR : Number(normalized);
};

/** Compile-time check: the real store satisfies the structural reader. */
export const __metabotStoreIsDailyReportSettingsReader = (store: MetabotStore): DailyReportSettingsReader => store;
