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
  fetchFresh: async ({ sinceTs, limit, backlogCursor }) => {
    if (error) throw new Error(error);
    void backlogCursor;
    return {
      items: items.filter((item) => sinceTs === null || item.createdAt > sinceTs).slice(0, limit),
      hasMore: false,
      nextCursor: null,
    };
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

test('very short / symbol-only titles fold into one noise line; signal items keep their lines (live-audit round 1)', async () => {
  const store = setup();
  const noisy = (pinId, title) => ({ ...makeItem(pinId, NOW_SEC - 5, 'alpha'), title });
  const registry = [makeDescriptor('alpha', [
    noisy('pin-good', 'A real methodological write-up'),
    noisy('pin-2', '2'),
    noisy('pin-emoji', '😂'),
    noisy('pin-dots', '……'),
    noisy('pin-untitled', ''),
    noisy('pin-ok', 'ok 好'), // 4 chars incl. CJK — signal
  ])];
  const briefing = await buildSurfBriefing({ store, metabotId: 7, interactionBudget: 20, registry, nowMs: NOW_MS });
  const md = renderSurfBriefingMarkdown(briefing);
  assert.match(md, /A real methodological write-up/);
  assert.match(md, /ok 好/);
  // The untitled item renders via its summary fallback — signal, not noise.
  assert.match(md, /\[pin-untitled\] Summary pin-untitled/);
  assert.match(md, /3 very short \/ symbol-only post\(s\) folded out of this listing/);
  assert.ok(!md.includes('[pin-2]'), 'one-liner noise must not render as an item line');
  assert.ok(!md.includes('[pin-emoji]'));
  assert.ok(!md.includes('[pin-dots]'));
  // Folding is display-only: every item stays briefed for the seen ledger.
  assert.equal(briefing.items.length, 6);
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

// ---------------------------------------------------------------------------
// Surf-reads page contract + backlog catch-up
// ---------------------------------------------------------------------------

test('a window page with hasMore registers backlog debt (cursor store, watermark still advances)', async () => {
  const store = setup();
  const registry = [{
    key: 'alpha',
    displayName: 'Fake alpha',
    paths: ['/protocols/alpha'],
    interactions: ['like'],
    relevanceHint: 'hint',
    fetchFresh: async () => ({
      items: [makeItem('pin-a', NOW_SEC - 100, 'alpha')],
      hasMore: true,
      nextCursor: 'opaque-cursor-2',
    }),
  }];
  const briefing = await buildSurfBriefing({ store, metabotId: 7, interactionBudget: 20, registry, nowMs: NOW_MS });
  const section = briefing.protocols[0];
  assert.equal(section.backlogCursorAction, 'store');
  assert.equal(section.backlogCursor, 'opaque-cursor-2');
  assert.equal(section.nextWatermarkTs, NOW_SEC - 100, 'window debt does not stop the normal watermark advance');
});

test('a fully-scanned window clears any previously registered backlog debt', async () => {
  const store = setup();
  // Previous run left debt that no longer exists (e.g. refetch after a
  // backend restore) — hasMore=false means the window is exhausted.
  store.advanceProtocolState(7, 'alpha', {
    lastSeenTs: NOW_SEC - 500,
    lastPinId: null,
    nowIso: new Date(NOW_MS).toISOString(),
    backlogCursor: 'stale-cursor',
  });
  const briefing = await buildSurfBriefing({
    store, metabotId: 7, interactionBudget: 20,
    registry: [makeDescriptor('alpha', [makeItem('pin-a', NOW_SEC - 100, 'alpha')])],
    nowMs: NOW_MS,
  });
  assert.equal(briefing.protocols[0].backlogCursorAction, 'clear');
  assert.equal(briefing.protocols[0].backlogCursor, null);
});

test('backlog page: cursor passed through verbatim, hasMore stores the next cursor, watermark untouched', async () => {
  const store = setup();
  store.advanceProtocolState(7, 'alpha', {
    lastSeenTs: NOW_SEC - 500,
    lastPinId: null,
    nowIso: new Date(NOW_MS).toISOString(),
    backlogCursor: 'opaque-cursor-2',
  });
  const calls = [];
  const registry = [{
    key: 'alpha',
    displayName: 'Fake alpha',
    paths: ['/protocols/alpha'],
    interactions: ['like'],
    relevanceHint: 'hint',
    fetchFresh: async (input) => {
      calls.push(input);
      return {
        items: [makeItem('pin-old-backlog', NOW_SEC - 800, 'alpha')],
        hasMore: true,
        nextCursor: 'opaque-cursor-3',
      };
    },
  }];
  const briefing = await buildSurfBriefing({ store, metabotId: 7, interactionBudget: 20, registry, nowMs: NOW_MS });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].backlogCursor, 'opaque-cursor-2', 'the registered cursor is forwarded verbatim');
  const section = briefing.protocols[0];
  assert.equal(section.fetchedBacklog, true);
  assert.equal(section.backlogCursorAction, 'store');
  assert.equal(section.backlogCursor, 'opaque-cursor-3');
  assert.equal(section.nextWatermarkTs, null, 'backlog pages NEVER advance the watermark');
  assert.deepEqual(briefing.items.map((item) => item.pinId), ['pin-old-backlog']);
});

test('drained backlog (hasMore=false) clears the cursor and still never touches the watermark', async () => {
  const store = setup();
  store.advanceProtocolState(7, 'alpha', {
    lastSeenTs: NOW_SEC - 500,
    lastPinId: null,
    nowIso: new Date(NOW_MS).toISOString(),
    backlogCursor: 'opaque-cursor-3',
  });
  const registry = [{
    key: 'alpha',
    displayName: 'Fake alpha',
    paths: ['/protocols/alpha'],
    interactions: ['like'],
    relevanceHint: 'hint',
    fetchFresh: async () => ({ items: [], hasMore: false, nextCursor: null }),
  }];
  const briefing = await buildSurfBriefing({ store, metabotId: 7, interactionBudget: 20, registry, nowMs: NOW_MS });
  const section = briefing.protocols[0];
  assert.equal(section.fetchedBacklog, true);
  assert.equal(section.backlogCursorAction, 'clear', 'debt drained');
  assert.equal(section.nextWatermarkTs, null);
});

test('backlog items crowded out by the total cap PRESERVE the cursor (deferral, never drop)', async () => {
  const store = setup();
  store.advanceProtocolState(7, 'alpha', {
    lastSeenTs: NOW_SEC - 500,
    lastPinId: null,
    nowIso: new Date(NOW_MS).toISOString(),
    backlogCursor: 'opaque-cursor-3',
  });
  // Fill the 150 cap with newer protocols; the backlog protocol is crowded out.
  const registry = [
    makeDescriptor('proto-a', Array.from({ length: 50 }, (_, i) => makeItem(`a-${i}`, NOW_SEC - 100 + i, 'proto-a'))),
    makeDescriptor('proto-b', Array.from({ length: 50 }, (_, i) => makeItem(`b-${i}`, NOW_SEC - 200 + i, 'proto-b'))),
    makeDescriptor('proto-c', Array.from({ length: 50 }, (_, i) => makeItem(`c-${i}`, NOW_SEC - 300 + i, 'proto-c'))),
    {
      key: 'alpha',
      displayName: 'Fake alpha',
      paths: ['/protocols/alpha'],
      interactions: ['like'],
      relevanceHint: 'hint',
      fetchFresh: async () => ({
        items: [makeItem('pin-backlog', NOW_SEC - 800, 'alpha')],
        hasMore: true,
        nextCursor: 'opaque-cursor-4',
      }),
    },
  ];
  const briefing = await buildSurfBriefing({ store, metabotId: 7, interactionBudget: 20, registry, nowMs: NOW_MS });
  const section = briefing.protocols.find((entry) => entry.key === 'alpha');
  assert.equal(section.droppedByTotalCap, 1);
  assert.equal(section.backlogCursorAction, 'preserve', 'do not page past unseen backlog items');
  assert.equal(section.nextWatermarkTs, null);
});

test('a fetch error preserves the stored backlog cursor for retry', async () => {
  const store = setup();
  store.advanceProtocolState(7, 'alpha', {
    lastSeenTs: NOW_SEC - 500,
    lastPinId: null,
    nowIso: new Date(NOW_MS).toISOString(),
    backlogCursor: 'opaque-cursor-3',
  });
  const registry = [makeDescriptor('alpha', [], 'network down')];
  const briefing = await buildSurfBriefing({ store, metabotId: 7, interactionBudget: 20, registry, nowMs: NOW_MS });
  assert.equal(briefing.protocols[0].error, 'network down');
  assert.equal(briefing.protocols[0].backlogCursorAction, 'preserve');
});

// ---------------------------------------------------------------------------
// Deterministic inbox (R3)
// ---------------------------------------------------------------------------

const makeInboxItem = (pinId, createdAt, overrides = {}) => ({
  type: 'simplebuzz_comment',
  pinId,
  targetPinId: 'own-pin-1',
  actorName: 'Alice',
  actorGlobalMetaId: 'idq-alice',
  createdAt,
  excerpt: 'great post',
  ...overrides,
});

test('inbox: fetched with the baseline, ledger-filtered, newest-first, capped at 30', async () => {
  const store = setup();
  store.markSeen(7, 'inbox-old', 'presented', new Date(NOW_MS).toISOString());
  const calls = [];
  const many = Array.from({ length: 35 }, (_, i) =>
    makeInboxItem(`inbox-${i}`, NOW_SEC - 300 + i, { excerpt: `excerpt ${i}` }));
  many.push(makeInboxItem('inbox-old', NOW_SEC - 400));
  const briefing = await buildSurfBriefing({
    store, metabotId: 7, interactionBudget: 20,
    registry: [makeDescriptor('alpha', [])],
    nowMs: NOW_MS,
    inboxBaselineTs: NOW_SEC - 1000,
    fetchInbox: async ({ sinceTs }) => {
      calls.push(sinceTs);
      return many;
    },
  });
  assert.deepEqual(calls, [NOW_SEC - 1000]);
  assert.equal(briefing.inbox.error, null);
  assert.equal(briefing.inbox.items.length, 30, 'capped at 30 newest');
  assert.equal(briefing.inbox.items[0].pinId, 'inbox-34', 'newest first');
  assert.ok(briefing.inbox.items.every((item) => item.pinId !== 'inbox-old'), 'ledger-filtered for exactly-once');
});

test('inbox: fetch errors isolate into the section and never throw', async () => {
  const store = setup();
  const briefing = await buildSurfBriefing({
    store, metabotId: 7, interactionBudget: 20,
    registry: [makeDescriptor('alpha', [makeItem('pin-a', NOW_SEC - 5, 'alpha')])],
    nowMs: NOW_MS,
    fetchInbox: async () => { throw new Error('inbox backend down'); },
  });
  assert.equal(briefing.inbox.error, 'inbox backend down');
  assert.deepEqual(briefing.inbox.items, []);
  assert.equal(briefing.items.length, 1, 'protocol sections still build');
});

test('inbox: absent without a fetcher; baseline defaults to the first lookback', async () => {
  const store = setup();
  const withoutFetcher = await buildSurfBriefing({
    store, metabotId: 7, interactionBudget: 20,
    registry: [makeDescriptor('alpha', [])],
    nowMs: NOW_MS,
  });
  assert.equal(withoutFetcher.inbox, undefined);

  const withDefaultBaseline = await buildSurfBriefing({
    store, metabotId: 7, interactionBudget: 20,
    registry: [makeDescriptor('alpha', [])],
    nowMs: NOW_MS,
    fetchInbox: async ({ sinceTs }) => {
      assert.equal(sinceTs, NOW_SEC - SURF_FIRST_LOOKBACK_SECONDS);
      return [];
    },
  });
  assert.equal(withDefaultBaseline.inbox.sinceTs, NOW_SEC - SURF_FIRST_LOOKBACK_SECONDS);
});

// ---------------------------------------------------------------------------
// Protocol radar (R6)
// ---------------------------------------------------------------------------

test('radar: items annotated with isNew against the baseline; rejectedCount passes through', async () => {
  const store = setup();
  const briefing = await buildSurfBriefing({
    store, metabotId: 7, interactionBudget: 20,
    registry: [makeDescriptor('alpha', [])],
    nowMs: NOW_MS,
    inboxBaselineTs: NOW_SEC - 1000,
    fetchProtocolRadar: async () => ({
      items: [
        { path: '/protocols/newproto', title: 'New Proto', protocolName: 'newproto', intro: 'i', version: '1', authorName: 'Bob', createdAt: NOW_SEC - 500 },
        { path: '/protocols/oldproto', title: 'Old Proto', protocolName: 'oldproto', intro: 'i', version: '1', authorName: 'Cara', createdAt: NOW_SEC - 5000 },
      ],
      rejectedCount: 2,
    }),
  });
  assert.equal(briefing.protocolRadar.error, null);
  assert.equal(briefing.protocolRadar.rejectedCount, 2);
  assert.deepEqual(
    briefing.protocolRadar.items.map((item) => `${item.protocolName}:${item.isNew}`),
    ['newproto:true', 'oldproto:false'],
  );
});

test('radar: fetch errors isolate into the section and never throw', async () => {
  const store = setup();
  const briefing = await buildSurfBriefing({
    store, metabotId: 7, interactionBudget: 20,
    registry: [makeDescriptor('alpha', [makeItem('pin-a', NOW_SEC - 5, 'alpha')])],
    nowMs: NOW_MS,
    fetchProtocolRadar: async () => { throw new Error('radar backend down'); },
  });
  assert.equal(briefing.protocolRadar.error, 'radar backend down');
  assert.deepEqual(briefing.protocolRadar.items, []);
});

test('digest markdown renders inbox and radar appendix sections', async () => {
  const store = setup();
  const briefing = await buildSurfBriefing({
    store, metabotId: 7, interactionBudget: 20,
    registry: [makeDescriptor('alpha', [makeItem('pin-a', NOW_SEC - 5, 'alpha')])],
    nowMs: NOW_MS,
    inboxBaselineTs: NOW_SEC - 1000,
    fetchInbox: async () => [makeInboxItem('inbox-1', NOW_SEC - 100)],
    fetchProtocolRadar: async () => ({
      items: [
        { path: '/protocols/newproto', title: 'New Proto', protocolName: 'newproto', intro: 'i', version: '1', authorName: 'Bob', createdAt: NOW_SEC - 500 },
      ],
      rejectedCount: 1,
    }),
  });
  const md = renderSurfBriefingMarkdown(briefing);
  assert.match(md, /## Your inbox — 1 new interaction\(s\)/);
  assert.match(md, /\[simplebuzz_comment\] Alice → own-pin-1/);
  assert.match(md, /## Protocol radar — 1 registered protocol\(s\)/);
  assert.match(md, /\[NEW\] newproto \(\/protocols\/newproto/);
  assert.match(md, /1 declaration\(s\) rejected by validation/);
});
