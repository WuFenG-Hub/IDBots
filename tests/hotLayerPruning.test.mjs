// RRSI P3 — pure hot-layer ranking, demotion, and re-entry selection (Task 2),
// plus the store roster ranking and the pruning pass flows (Tasks 4–5).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  rankHotLayerItems,
  selectHotLayerDemotions,
  selectHotLayerReentries,
} = require('../dist-electron/main/libs/hotLayerPruning.js');

// ---------------------------------------------------------------------------
// Pure selection vectors (RRSI P3 Task 2)
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 31);
const c = (key, appliedNights, ageDays, exposedNights = 0) => ({
  key, kind: 'technique', hotSinceMs: NOW - ageDays * DAY, appliedNights, exposedNights,
});
const keys = (items) => items.map((item) => item.key);

test('ranking: no fresh items → applied evidence first, then the most recent zero-applied', () => {
  const items = [c('a', 3, 40), c('b', 0, 30), c('c', 2, 50), c('d', 0, 20), c('e', 1, 60), c('f', 0, 90), c('g', 0, 25)];
  assert.deepEqual(keys(rankHotLayerItems(items, { cap: 5, nowMs: NOW })), ['a', 'c', 'e', 'd', 'g']);
});

test('ranking: the fresh slot is honored over merit', () => {
  const items = [c('a', 3, 40), c('b', 2, 40), c('c', 2, 41), c('d', 1, 40), c('e', 1, 41), c('n', 0, 3)];
  assert.deepEqual(keys(rankHotLayerItems(items, { cap: 5, nowMs: NOW })), ['a', 'b', 'c', 'd', 'n']);
});

test('ranking: only the newest fresh item gets the slot', () => {
  const items = [c('a', 3, 40), c('b', 2, 40), c('c', 2, 41), c('d', 1, 40), c('e', 1, 41), c('n', 0, 3), c('m', 0, 5)];
  assert.deepEqual(keys(rankHotLayerItems(items, { cap: 5, nowMs: NOW })), ['a', 'b', 'c', 'd', 'n']);
});

test('ranking: a fresh item that ranks on merit does not consume a second slot', () => {
  const items = [c('n', 4, 2), c('a', 3, 40), c('b', 2, 40), c('c', 1, 40), c('d', 1, 41), c('e', 0, 40)];
  assert.deepEqual(keys(rankHotLayerItems(items, { cap: 5, nowMs: NOW })), ['n', 'a', 'b', 'c', 'd']);
});

test('ranking: ties fall through to recency then key', () => {
  assert.deepEqual(keys(rankHotLayerItems([c('b', 1, 10), c('a', 1, 10)], { cap: 1, nowMs: NOW, freshSlots: 0 })), ['a']);
});

test('ranking: cap larger than the input returns everything sorted; cap 0 is empty', () => {
  const items = [c('b', 0, 10), c('a', 1, 10)];
  assert.deepEqual(keys(rankHotLayerItems(items, { cap: 10, nowMs: NOW })), ['a', 'b']);
  assert.deepEqual(rankHotLayerItems(items, { cap: 0, nowMs: NOW }), []);
});

test('demotions: past grace + ≥5 audited exposures + never applied', () => {
  const demote = (item) => selectHotLayerDemotions([item], { nowMs: NOW });
  assert.deepEqual(keys(demote(c('x', 0, 30, 5))), ['x']);
  assert.deepEqual(demote(c('y', 0, 30, 4)), [], 'four audited nights are not enough');
  assert.deepEqual(demote(c('z', 0, 10, 9)), [], 'inside the grace period');
  assert.deepEqual(demote(c('w', 1, 30, 9)), [], 'applied at least once');
});

test('demotions: at most two per night, worst exposure first, then oldest', () => {
  const picked = selectHotLayerDemotions(
    [c('i', 0, 30, 6), c('j', 0, 40, 7), c('k', 0, 50, 7), c('h', 0, 30, 9)],
    { nowMs: NOW },
  );
  assert.deepEqual(keys(picked), ['h', 'k']);
});

test('re-entries: at least two applied nights, most applied first', () => {
  const picked = selectHotLayerReentries([c('a', 2, 10), c('b', 1, 10), c('c', 3, 10)]);
  assert.deepEqual(keys(picked), ['c', 'a']);
});
