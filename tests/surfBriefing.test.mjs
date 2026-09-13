import test from 'node:test';
import assert from 'node:assert/strict';

const { createNativeSqliteDatabase } = await import('../dist-electron/main/nativeSqliteDatabase.js');
const { MetawebSurfStore } = await import('../dist-electron/main/metawebSurfStore.js');
const {
  buildSurfBriefing,
  renderSurfBriefingMarkdown,
  SURF_FIRST_LOOKBACK_SECONDS,
  SURF_TOTAL_FETCH_LIMIT,
} = await import('../dist-electron/main/libs/surfBriefing.js');

const NOW_MS = Date.parse('2026-09-13T01:00:00.000Z');
const NOW_SEC = Math.floor(NOW_MS / 1000);

const setup = () => {
  const db = createNativeSqliteDatabase(':memory:');
  assert.ok(db, 'native sqlite available in test runtime');
  return new MetawebSurfStore(db, () => {});
};

const makeItem = (pinId, createdAt, protocolKey = 'fakeproto') => ({
  pinId,
  protocolKey,
  chainName: 'mvc',
  title: `Title ${pinId}`,
  summary: `Summary ${pinId}`,
  authorName: '',
  authorGlobalMetaId: 'idq-test',
  createdAt,
  likeCount: null,
  commentCount: null,
  extra: null,
});

const makeDescriptor = (key, items, error = null) => ({
  key,
  displayName: `Fake ${key}`,
  paths: [`/protocols/${key}`],
  interactions: ['like'],
  relevanceHint: 'hint',
  fetchFresh: async ({ sinceTs, limit }) => {
    if (error) throw new Error(error);
    return items.filter((item) => sinceTs === null || item.createdAt > sinceTs).slice(0, limit);
  },
});

test('first surf looks back SURF_FIRST_LOOKBACK_SECONDS and stays side-effect free', async () => {
  const store = setup();
  const inside = NOW_SEC - 1000;
  const outside = NOW_SEC - SURF_FIRST_LOOKBACK_SECONDS - 1000;
  const registry = [makeDescriptor('alpha', [makeItem('pin-in', inside, 'alpha'), makeItem('pin-out', outside, 'alpha')])];

  const briefing = await buildSurfBriefing({ store, metabotId: 7, interactionBudget: 20, registry, nowMs: NOW_MS });
  assert.deepEqual(briefing.items.map((item) => item.pinId), ['pin-in']);
  assert.equal(
    store.getSeenAction(7, 'pin-in'),
    null,
    'briefing must NOT mark pins presented — that moved to the run success path (failed runs re-present the window)',
  );
  assert.equal(briefing.protocols[0].keptCount, 1);
  assert.equal(briefing.interactionBudget, 20);
});

test('already-seen pins are excluded from the briefing', async () => {
  const store = setup();
  store.markSeen(7, 'pin-old', 'read', new Date(NOW_MS).toISOString());
  const registry = [makeDescriptor('alpha', [makeItem('pin-old', NOW_SEC - 10, 'alpha'), makeItem('pin-new', NOW_SEC - 5, 'alpha')])];

  const briefing = await buildSurfBriefing({ store, metabotId: 7, interactionBudget: 20, registry, nowMs: NOW_MS });
  assert.deepEqual(briefing.items.map((item) => item.pinId), ['pin-new']);
});

test('a failing protocol is recorded as an error section, others continue', async () => {
  const store = setup();
  const registry = [
    makeDescriptor('broken', [], 'network down'),
    makeDescriptor('alpha', [makeItem('pin-a', NOW_SEC - 5, 'alpha')]),
  ];
  const briefing = await buildSurfBriefing({ store, metabotId: 7, interactionBudget: 20, registry, nowMs: NOW_MS });
  assert.equal(briefing.protocols[0].error, 'network down');
  assert.equal(briefing.protocols[1].keptCount, 1);
  assert.equal(briefing.items.length, 1);
});

test('items are newest-first and capped at SURF_TOTAL_FETCH_LIMIT', async () => {
  const store = setup();
  // Per-protocol cap is 50, so the total cap only bites across protocols.
  const registry = Array.from({ length: 4 }, (_, p) =>
    makeDescriptor(`proto${p}`, Array.from({ length: 80 }, (_, i) =>
      makeItem(`p${p}-pin-${i}`, NOW_SEC - 10000 + p * 100 + i, `proto${p}`))));
  const briefing = await buildSurfBriefing({ store, metabotId: 7, interactionBudget: 20, registry, nowMs: NOW_MS });
  assert.equal(briefing.items.length, SURF_TOTAL_FETCH_LIMIT);
  assert.ok(briefing.items[0].createdAt >= briefing.items[1].createdAt);
});

test('digest markdown lists sections and items', async () => {
  const store = setup();
  const registry = [makeDescriptor('alpha', [makeItem('pin-a', NOW_SEC - 5, 'alpha')])];
  const briefing = await buildSurfBriefing({ store, metabotId: 7, interactionBudget: 20, registry, nowMs: NOW_MS });
  const md = renderSurfBriefingMarkdown(briefing);
  assert.match(md, /# Surf digest/);
  assert.match(md, /Fake alpha — 1 new/);
  assert.match(md, /pin-a/);
});

test('total-cap deferral: dropped counts and next watermarks per protocol (round 3)', async () => {
  const store = setup();
  // The per-protocol fetch cap is 50, so overflowing the 150 total cap takes
  // five protocols: a+b+c fill 140 slots, d keeps only its newest 10, e is
  // crowded out entirely.
  const registry = [
    makeDescriptor('proto-a', Array.from({ length: 50 }, (_, i) => makeItem(`a-${i}`, NOW_SEC - 1000 + i, 'proto-a'))),
    makeDescriptor('proto-b', Array.from({ length: 50 }, (_, i) => makeItem(`b-${i}`, NOW_SEC - 2000 + i, 'proto-b'))),
    makeDescriptor('proto-c', Array.from({ length: 40 }, (_, i) => makeItem(`c-${i}`, NOW_SEC - 3000 + i, 'proto-c'))),
    makeDescriptor('proto-d', Array.from({ length: 50 }, (_, i) => makeItem(`d-${i}`, NOW_SEC - 4000 + i, 'proto-d'))),
    makeDescriptor('proto-e', Array.from({ length: 20 }, (_, i) => makeItem(`e-${i}`, NOW_SEC - 5000 + i, 'proto-e'))),
  ];
  const briefing = await buildSurfBriefing({ store, metabotId: 7, interactionBudget: 20, registry, nowMs: NOW_MS });
  assert.equal(briefing.items.length, SURF_TOTAL_FETCH_LIMIT);
  const byKey = Object.fromEntries(briefing.protocols.map((section) => [section.key, section]));
  assert.equal(byKey['proto-a'].droppedByTotalCap, 0);
  assert.equal(byKey['proto-a'].nextWatermarkTs, NOW_SEC - 1000, 'oldest in-list item');
  assert.equal(byKey['proto-c'].droppedByTotalCap, 0);
  assert.equal(byKey['proto-c'].nextWatermarkTs, NOW_SEC - 3000);
  assert.equal(byKey['proto-d'].droppedByTotalCap, 40);
  assert.equal(byKey['proto-d'].nextWatermarkTs, NOW_SEC - 4000 + 40, 'oldest in-list item; the 40 crowded-out items (older) survive the ledger filter next run');
  assert.equal(byKey['proto-e'].droppedByTotalCap, 20);
  assert.equal(byKey['proto-e'].nextWatermarkTs, null, 'fully crowded out — keep the old cursor');
});

test('all-ledger-filtered protocol still advances its cursor', async () => {
  const store = setup();
  store.markSeen(7, 'pin-old', 'presented', new Date(NOW_MS).toISOString());
  const registry = [makeDescriptor('alpha', [makeItem('pin-old', NOW_SEC - 10, 'alpha')])];
  const briefing = await buildSurfBriefing({ store, metabotId: 7, interactionBudget: 20, registry, nowMs: NOW_MS });
  assert.equal(briefing.protocols[0].keptCount, 0);
  assert.equal(briefing.protocols[0].droppedByTotalCap, 0);
  assert.equal(briefing.protocols[0].nextWatermarkTs, NOW_SEC - 10, 'nothing to rescue — cursor may advance');
});

test('digest markdown marks items held back by the run cap', async () => {
  const store = setup();
  // 4 x 50 = 200 kept; the oldest protocol is crowded out of the 150 cap.
  const registry = [
    makeDescriptor('proto-new', Array.from({ length: 50 }, (_, i) => makeItem(`new-${i}`, NOW_SEC - 1000 + i, 'proto-new'))),
    makeDescriptor('proto-mid', Array.from({ length: 50 }, (_, i) => makeItem(`mid-${i}`, NOW_SEC - 2000 + i, 'proto-mid'))),
    makeDescriptor('proto-low', Array.from({ length: 50 }, (_, i) => makeItem(`low-${i}`, NOW_SEC - 3000 + i, 'proto-low'))),
    makeDescriptor('proto-old', Array.from({ length: 50 }, (_, i) => makeItem(`old-${i}`, NOW_SEC - 4000 + i, 'proto-old'))),
  ];
  const briefing = await buildSurfBriefing({ store, metabotId: 7, interactionBudget: 20, registry, nowMs: NOW_MS });
  const md = renderSurfBriefingMarkdown(briefing);
  assert.match(md, /Fake proto-old — 50 new/);
  assert.match(md, /plus 50 more held back by the run cap — they stay unseen and return next surf/);
  assert.doesNotMatch(md, /## Fake proto-old — 50 new\n\(nothing new\)/, 'a section with held-back items is not "nothing new"');
});
