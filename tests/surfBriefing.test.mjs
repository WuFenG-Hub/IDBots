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
