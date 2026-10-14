import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatQuotaResetSuffix,
  quotaResetDaysLeft,
  type QuotaTranslate,
} from '../src/renderer/services/quotaResetCountdown.ts';

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 9, 14, 0, 0, 0); // 2026-10-14T00:00:00Z, fixed for determinism

// Fake translator mirroring the zh dictionary values used by the helper.
const translate: QuotaTranslate = (key: string) => {
  const table: Record<string, string> = {
    freeQuotaResetCountdown: '· {n} 天后重置',
    freeQuotaResetImminent: '· 即将重置',
  };
  return table[key] ?? key;
};

test('quotaResetDaysLeft rounds up to whole days', () => {
  assert.equal(quotaResetDaysLeft(NOW + 3 * DAY_MS, NOW), 3, 'exactly 3 days → 3');
  assert.equal(quotaResetDaysLeft(NOW + 3 * DAY_MS - 1, NOW), 3, '3 days minus 1ms still rounds up to 3');
  assert.equal(quotaResetDaysLeft(NOW + 3 * DAY_MS + 1, NOW), 4, 'just past 3 days → 4');
  assert.equal(quotaResetDaysLeft(NOW + 2 * 3600_000, NOW), 1, 'a couple of hours → 1 day');
});

test('quotaResetDaysLeft treats disabled/past cycles as imminent (<= 0)', () => {
  assert.equal(quotaResetDaysLeft(0, NOW), 0, 'weekly quota disabled → 0');
  assert.equal(quotaResetDaysLeft(Number.NaN, NOW), 0, 'NaN → 0');
  assert.equal(quotaResetDaysLeft(NOW - 1000, NOW), 0, 'cross-cycle instant → <= 0');
});

test('formatQuotaResetSuffix renders the countdown with whole days', () => {
  assert.equal(
    formatQuotaResetSuffix(NOW + 3 * DAY_MS + 3600_000, translate, NOW),
    '· 4 天后重置',
  );
  assert.equal(
    formatQuotaResetSuffix(NOW + 2 * 3600_000, translate, NOW),
    '· 1 天后重置',
  );
});

test('formatQuotaResetSuffix falls back to imminent copy at the cycle boundary', () => {
  assert.equal(formatQuotaResetSuffix(NOW - 1, translate, NOW), '· 即将重置');
});

test('formatQuotaResetSuffix renders nothing when weekly quotas are disabled', () => {
  assert.equal(formatQuotaResetSuffix(0, translate, NOW), '', 'absent/0 field → no countdown');
  assert.equal(formatQuotaResetSuffix(Number.NaN, translate, NOW), '', 'invalid field → no countdown');
});
