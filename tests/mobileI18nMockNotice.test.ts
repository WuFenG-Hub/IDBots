import test from 'node:test';
import assert from 'node:assert/strict';
import { mobileI18n } from '../src/mobile/i18n';

/**
 * Build-mode test for the login demo notice (`mobile.login.demoNote`).
 * Runs TWICE from test:mobile with opposite expectations:
 *
 *   - VITE_MOBILE_MOCK=1 (dev server / mock suite): the notice renders.
 *   - unset (production build mode): the notice key is gone from both
 *     dictionaries and t() renders nothing — the page's unconditional
 *     `{t('mobile.login.demoNote')}` must show no copy at all, never the
 *     raw key name.
 */
const MOCK_MODE = process.env.VITE_MOBILE_MOCK === '1';

test('demo notice copy matches the build mode', () => {
  mobileI18n.setLanguage('zh');
  const zh = mobileI18n.t('mobile.login.demoNote');
  mobileI18n.setLanguage('en');
  const en = mobileI18n.t('mobile.login.demoNote');
  if (MOCK_MODE) {
    assert.ok(zh.includes('演示环境'), `mock build must show the zh notice, got: ${zh}`);
    assert.ok(en.toLowerCase().includes('mock'), `mock build must show the en notice, got: ${en}`);
  } else {
    assert.equal(zh, '', 'production build must render no demo notice (zh)');
    assert.equal(en, '', 'production build must render no demo notice (en)');
  }
});

test('t() never leaks an internal key name for a missing key', () => {
  mobileI18n.setLanguage('en');
  const warns: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(' '));
  };
  try {
    assert.equal(mobileI18n.t('mobile.login.keyThatDoesNotExist'), '');
    assert.ok(
      warns.some((line) => line.includes('mobile.login.keyThatDoesNotExist')),
      'missing keys must still be reported on the console',
    );
  } finally {
    console.warn = original;
  }
});
