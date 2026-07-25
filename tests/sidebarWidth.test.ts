import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clampSidebarWidth,
  loadSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_STORAGE_KEY,
} from '../src/renderer/utils/sidebarWidth';

test('clampSidebarWidth clamps to the 240–480 range and rounds', () => {
  assert.equal(clampSidebarWidth(100), SIDEBAR_WIDTH_MIN);
  assert.equal(clampSidebarWidth(1000), SIDEBAR_WIDTH_MAX);
  assert.equal(clampSidebarWidth(288), 288);
  assert.equal(clampSidebarWidth(300.6), 301);
});

test('clampSidebarWidth falls back to default for non-finite input', () => {
  assert.equal(clampSidebarWidth(Number.NaN), SIDEBAR_WIDTH_DEFAULT);
  assert.equal(clampSidebarWidth(Number.POSITIVE_INFINITY), SIDEBAR_WIDTH_DEFAULT);
});

test('loadSidebarWidth reads, parses, and clamps the stored value', () => {
  assert.equal(loadSidebarWidth(() => null), SIDEBAR_WIDTH_DEFAULT);
  assert.equal(loadSidebarWidth(() => '350'), 350);
  assert.equal(loadSidebarWidth(() => '10'), SIDEBAR_WIDTH_MIN);
  assert.equal(loadSidebarWidth(() => 'not-a-number'), SIDEBAR_WIDTH_DEFAULT);
  let requestedKey: string | null = null;
  loadSidebarWidth((key) => {
    requestedKey = key;
    return null;
  });
  assert.equal(requestedKey, SIDEBAR_WIDTH_STORAGE_KEY);
});
