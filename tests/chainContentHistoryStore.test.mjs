import test from 'node:test';
import assert from 'node:assert/strict';

const { createNativeSqliteDatabase } = await import('../dist-electron/main/nativeSqliteDatabase.js')
  .catch(() => import('../dist-electron/nativeSqliteDatabase.js'));
const {
  ChainContentHistoryStore,
  ensureChainContentHistorySchema,
  SUMMARY_MIN_CONTENT_CHARS,
  MAX_WRITE_CONTENT_CHARS,
  MAX_READ_EXCERPT_CHARS,
  MAX_SUMMARY_ATTEMPTS,
} = await import('../dist-electron/main/chainContentHistoryStore.js')
  .catch(() => import('../dist-electron/chainContentHistoryStore.js'));

const setup = () => {
  const db = createNativeSqliteDatabase(':memory:');
  assert.ok(db, 'native sqlite available in test runtime');
  const store = new ChainContentHistoryStore(db, () => {});
  return { db, store };
};

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-09-01T10:00:00.000Z');

const makeWrite = (overrides = {}) => ({
  metabotId: 7,
  pinId: 'pin-write-1',
  txId: 'tx-1',
  path: '/protocols/simplebuzz',
  operation: 'create',
  contentText: 'hello chain',
  contentType: 'text/plain',
  origin: 'tool:post_buzz',
  occurredAtMs: T0,
  ...overrides,
});

const makeRead = (overrides = {}) => ({
  metabotId: 7,
  pinId: 'pin-read-1',
  path: '/protocols/simplenote',
  protocol: 'simplenote',
  title: 'Some article',
  authorGlobalMetaId: 'gm-author',
  contentText: 'a'.repeat(100),
  source: 'read_metaweb_pin',
  readAtMs: T0,
  ...overrides,
});

test('schema creation is idempotent', () => {
  const { db } = setup();
  ensureChainContentHistorySchema(db);
  ensureChainContentHistorySchema(db);
});

test('recordWrite stores text payload and dedupes by pin_id', () => {
  const { store } = setup();
  const first = store.recordWrite(makeWrite());
  assert.equal(first.created, true);
  const dupe = store.recordWrite(makeWrite({ contentText: 'different' }));
  assert.equal(dupe.created, false, 'duplicate pin_id is ignored');
  const row = store.getWriteByPinId('pin-write-1');
  assert.equal(row.contentText, 'hello chain', 'first write wins');
  assert.equal(row.metabotId, 7);
  assert.equal(row.summaryStatus, 'skipped', 'short text needs no summary');
});

test('recordWrite rejects missing pin id', () => {
  const { store } = setup();
  assert.deepEqual(store.recordWrite(makeWrite({ pinId: '  ' })), { created: false });
});

test('recordWrite caps long text and queues a summary', () => {
  const { store } = setup();
  const long = 'x'.repeat(MAX_WRITE_CONTENT_CHARS + 500);
  store.recordWrite(makeWrite({ pinId: 'pin-long', contentText: long }));
  const row = store.getWriteByPinId('pin-long');
  assert.equal(row.contentText.length, MAX_WRITE_CONTENT_CHARS);
  assert.equal(row.contentTruncated, true);
  assert.equal(row.summaryStatus, 'pending');
  assert.equal(row.contentBytes, Buffer.byteLength(long, 'utf8'), 'byte size reflects the original');
});

test('recordWrite stores binary pins as metadata only', () => {
  const { store } = setup();
  store.recordWrite(makeWrite({
    pinId: 'pin-file',
    path: '/file',
    contentText: null,
    contentBytes: 123456,
    contentType: 'video/mp4',
  }));
  const row = store.getWriteByPinId('pin-file');
  assert.equal(row.contentText, null);
  assert.equal(row.contentBytes, 123456);
  assert.equal(row.summaryStatus, 'skipped');
});

test('recordRead upserts: re-read bumps count, refreshes time, keeps summary', () => {
  const { store } = setup();
  store.recordRead(makeRead());
  store.applySummarySuccess('read', store.getReadByPinId(7, 'pin-read-1').id, 'summary one', T0 + 1000);
  store.recordRead(makeRead({ readAtMs: T0 + DAY, title: null, contentText: null }));
  const row = store.getReadByPinId(7, 'pin-read-1');
  assert.equal(row.readCount, 2);
  assert.equal(row.lastReadAtMs, T0 + DAY);
  assert.equal(row.firstReadAtMs, T0);
  assert.equal(row.summary, 'summary one', 're-read must not clobber a finished summary');
  assert.equal(row.title, 'Some article', 'null fields never erase stored metadata');
});

test('recordRead queues summary for long content only', () => {
  const { store } = setup();
  store.recordRead(makeRead({ pinId: 'short', contentText: 'b'.repeat(SUMMARY_MIN_CONTENT_CHARS - 1) }));
  store.recordRead(makeRead({ pinId: 'long', contentText: 'b'.repeat(SUMMARY_MIN_CONTENT_CHARS) }));
  assert.equal(store.getReadByPinId(7, 'short').summaryStatus, 'skipped');
  assert.equal(store.getReadByPinId(7, 'long').summaryStatus, 'pending');
});

test('read excerpt is capped', () => {
  const { store } = setup();
  store.recordRead(makeRead({ contentText: 'y'.repeat(MAX_READ_EXCERPT_CHARS * 2) }));
  const row = store.getReadByPinId(7, 'pin-read-1');
  assert.equal(row.contentExcerpt.length, MAX_READ_EXCERPT_CHARS);
});

test('markReadSavedToKb flags known pins only', () => {
  const { store } = setup();
  store.recordRead(makeRead());
  assert.equal(store.markReadSavedToKb(7, 'pin-read-1', 'kb-9'), true);
  assert.equal(store.markReadSavedToKb(7, 'pin-unknown', 'kb-9'), false);
  const row = store.getReadByPinId(7, 'pin-read-1');
  assert.equal(row.savedToKb, true);
  assert.equal(row.kbId, 'kb-9');
});

test('summary lifecycle: pending list, success, failure attempts then failed', () => {
  const { store } = setup();
  store.recordWrite(makeWrite({ pinId: 'p1', contentText: 'z'.repeat(2000) }));
  const id1 = store.getWriteByPinId('p1').id;
  assert.equal(store.listPendingSummaries('write', 10).length, 1);

  for (let i = 0; i < MAX_SUMMARY_ATTEMPTS; i += 1) {
    store.applySummaryFailure('write', id1);
  }
  const failed = store.getWriteByPinId('p1');
  assert.equal(failed.summaryStatus, 'failed');
  assert.equal(failed.summaryAttempts, MAX_SUMMARY_ATTEMPTS);
  assert.equal(store.listPendingSummaries('write', 10).length, 0, 'failed rows leave the queue');

  store.recordWrite(makeWrite({ pinId: 'p2', contentText: 'z'.repeat(2000) }));
  const id2 = store.getWriteByPinId('p2').id;
  store.applySummarySuccess('write', id2, 'a summary', T0 + 1000);
  const done = store.getWriteByPinId('p2');
  assert.equal(done.summaryStatus, 'done');
  assert.equal(done.summary, 'a summary');
  assert.equal(done.summarizedAtMs, T0 + 1000);
});

test('countSummariesSince counts only recent completions for the bot', () => {
  const { store } = setup();
  store.recordWrite(makeWrite({ pinId: 'p1', metabotId: 7, contentText: 'z'.repeat(2000) }));
  store.recordWrite(makeWrite({ pinId: 'p2', metabotId: 8, contentText: 'z'.repeat(2000) }));
  store.applySummarySuccess('write', store.getWriteByPinId('p1').id, 's', T0);
  store.applySummarySuccess('write', store.getWriteByPinId('p2').id, 's', T0);
  assert.equal(store.countSummariesSince('write', 7, T0 - 1000), 1);
  assert.equal(store.countSummariesSince('write', 7, T0 + 1000), 0);
});

test('listWritesForDay / listReadsForDay filter by bot and day window', () => {
  const { store } = setup();
  const dayStart = Date.parse('2026-09-01T00:00:00.000Z');
  const dayEnd = dayStart + DAY;
  store.recordWrite(makeWrite({ pinId: 'in-day', occurredAtMs: dayStart + 1000 }));
  store.recordWrite(makeWrite({ pinId: 'prev-day', occurredAtMs: dayStart - 1000 }));
  store.recordWrite(makeWrite({ pinId: 'other-bot', metabotId: 8, occurredAtMs: dayStart + 2000 }));
  assert.deepEqual(
    store.listWritesForDay(7, dayStart, dayEnd).map((row) => row.pinId),
    ['in-day'],
  );

  store.recordRead(makeRead({ pinId: 'r-in', readAtMs: dayStart + 3000 }));
  store.recordRead(makeRead({ pinId: 'r-prev', readAtMs: dayStart - 3000 }));
  assert.deepEqual(
    store.listReadsForDay(7, dayStart, dayEnd).map((row) => row.pinId),
    ['r-in'],
  );
});

test('searchWrites: keyword, pinId match, time window, newest first and limit', () => {
  const { store } = setup();
  store.recordWrite(makeWrite({ pinId: 'w-old', contentText: '关于 MetaWeb 的发布', occurredAtMs: T0 }));
  store.recordWrite(makeWrite({ pinId: 'w-new', contentText: '另一条内容', path: '/protocols/simplenote', occurredAtMs: T0 + 2 * DAY }));
  store.recordWrite(makeWrite({ pinId: 'w-other', metabotId: 8, contentText: '关于 MetaWeb 的别的', occurredAtMs: T0 + DAY }));

  const hits = store.searchWrites(7, { query: 'MetaWeb' });
  assert.deepEqual(hits.map((row) => row.pinId), ['w-old'], 'keyword matches content_text, bot-scoped');

  const byPinId = store.searchWrites(7, { query: 'w-new' });
  assert.deepEqual(byPinId.map((row) => row.pinId), ['w-new'], 'pinId is searchable too');

  const windowed = store.searchWrites(7, { fromMs: T0 + DAY, toMs: T0 + 3 * DAY });
  assert.deepEqual(windowed.map((row) => row.pinId), ['w-new'], 'time window filtering');

  const ordered = store.searchWrites(7, {});
  assert.deepEqual(ordered.map((row) => row.pinId), ['w-new', 'w-old'], 'newest first');
  const capped = store.searchWrites(7, { limit: 1 });
  assert.deepEqual(capped.map((row) => row.pinId), ['w-new'], 'limit applies');
});

test('searchWrites escapes LIKE wildcards in the query', () => {
  const { store } = setup();
  store.recordWrite(makeWrite({ pinId: 'w1', contentText: 'literal 50%_off note' }));
  store.recordWrite(makeWrite({ pinId: 'w2', contentText: 'something else' }));
  assert.deepEqual(
    store.searchWrites(7, { query: '50%_off' }).map((row) => row.pinId),
    ['w1'],
    'percent and underscore are matched literally',
  );
});

test('searchReads: keyword over title/excerpt/summary/author, window and newest-first', () => {
  const { store } = setup();
  store.recordRead(makeRead({
    pinId: 'r-guide', title: 'MetaWeb 使用指南', contentText: '介绍 MetaWeb 用法', readAtMs: T0,
  }));
  store.recordRead(makeRead({
    pinId: 'r-later', title: '别的文章', authorGlobalMetaId: 'gm-metaweb-fan',
    contentText: '与标题无关的正文', readAtMs: T0 + DAY,
  }));
  store.recordRead(makeRead({
    pinId: 'r-other', metabotId: 8, title: 'MetaWeb 别人的', contentText: 'x', readAtMs: T0,
  }));

  const byTitle = store.searchReads(7, { query: '使用指南' });
  assert.deepEqual(byTitle.map((row) => row.pinId), ['r-guide'], 'title match, bot-scoped');

  const byAuthor = store.searchReads(7, { query: 'gm-metaweb-fan' });
  assert.deepEqual(byAuthor.map((row) => row.pinId), ['r-later'], 'author match');

  const byExcerpt = store.searchReads(7, { query: '正文' });
  assert.deepEqual(byExcerpt.map((row) => row.pinId), ['r-later'], 'excerpt match');

  const windowed = store.searchReads(7, { fromMs: T0 + 1000, toMs: T0 + 2 * DAY });
  assert.deepEqual(windowed.map((row) => row.pinId), ['r-later'], 'last_read_at window');

  const ordered = store.searchReads(7, {});
  assert.deepEqual(ordered.map((row) => row.pinId), ['r-later', 'r-guide'], 'newest read first');
});

test('searchReads: summary becomes searchable once the async summary lands', () => {
  const { store } = setup();
  store.recordRead(makeRead({ pinId: 'r1', title: '普通标题', contentText: '正文内容' }));
  assert.equal(store.searchReads(7, { query: '中心思想' }).length, 0);
  store.applySummarySuccess('read', store.getReadByPinId(7, 'r1').id, '这篇文章的中心思想是链上记录', T0 + 500);
  assert.deepEqual(
    store.searchReads(7, { query: '中心思想' }).map((row) => row.pinId),
    ['r1'],
    'a landed summary is immediately recallable',
  );
});
