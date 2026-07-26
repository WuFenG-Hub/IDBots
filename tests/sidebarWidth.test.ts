import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clampSidebarWidth,
  defaultSidebarWidth,
  loadSidebarWidth,
  sidebarWidthStorageKey,
  SIDEBAR_WIDTH_BROWSER_DEFAULT,
  SIDEBAR_WIDTH_HOME_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from '../src/renderer/utils/sidebarWidth';

test('clampSidebarWidth clamps to the 240–480 range and rounds', () => {
  assert.equal(clampSidebarWidth(100), SIDEBAR_WIDTH_MIN);
  assert.equal(clampSidebarWidth(1000), SIDEBAR_WIDTH_MAX);
  assert.equal(clampSidebarWidth(288), 288);
  assert.equal(clampSidebarWidth(300.6), 301);
});

test('clampSidebarWidth falls back to the home default for non-finite input', () => {
  assert.equal(clampSidebarWidth(Number.NaN), SIDEBAR_WIDTH_HOME_DEFAULT);
  assert.equal(clampSidebarWidth(Number.POSITIVE_INFINITY), SIDEBAR_WIDTH_HOME_DEFAULT);
});

test('each mode has its own default and storage key', () => {
  assert.equal(defaultSidebarWidth('home'), SIDEBAR_WIDTH_HOME_DEFAULT);
  assert.equal(defaultSidebarWidth('browser'), SIDEBAR_WIDTH_BROWSER_DEFAULT);
  assert.notEqual(sidebarWidthStorageKey('home'), sidebarWidthStorageKey('browser'));
});

test('loadSidebarWidth reads per-mode values independently', () => {
  const store = new Map([
    [sidebarWidthStorageKey('home'), '300'],
    [sidebarWidthStorageKey('browser'), '420'],
  ]);
  const getItem = (key) => store.get(key) ?? null;
  assert.equal(loadSidebarWidth(getItem, 'home'), 300);
  assert.equal(loadSidebarWidth(getItem, 'browser'), 420);
});

test('loadSidebarWidth falls back to per-mode defaults and the legacy key for home', () => {
  assert.equal(loadSidebarWidth(() => null, 'browser'), SIDEBAR_WIDTH_BROWSER_DEFAULT);
  assert.equal(loadSidebarWidth(() => null, 'home'), SIDEBAR_WIDTH_HOME_DEFAULT);

  const legacyOnly = (key) => (key === 'idbots.sidebarWidth' ? '350' : null);
  assert.equal(loadSidebarWidth(legacyOnly, 'home'), 350);
  // The legacy single key never seeds the browser width.
  assert.equal(loadSidebarWidth(legacyOnly, 'browser'), SIDEBAR_WIDTH_BROWSER_DEFAULT);
});

test('loadSidebarWidth clamps stored values', () => {
  const getItem = (key) => (key === sidebarWidthStorageKey('home') ? '10' : null);
  assert.equal(loadSidebarWidth(getItem, 'home'), SIDEBAR_WIDTH_MIN);
});
