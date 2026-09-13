import test from 'node:test';
import assert from 'node:assert/strict';

const { sinceFiltered, applyFreshWindowFilter } = await import('../dist-electron/main/libs/surfProtocols.js');

const makeItem = (pinId, createdAt) => ({
  pinId,
  protocolKey: 'alpha',
  chainName: 'mvc',
  title: '',
  summary: '',
  authorName: '',
  authorGlobalMetaId: 'idq-test',
  createdAt,
  likeCount: null,
  commentCount: null,
  extra: null,
});

test('sinceFiltered keeps the boundary second (>=) so same-second stragglers return (review 2, item 2)', () => {
  const items = [
    makeItem('pin-older', 999),
    makeItem('pin-boundary-a', 1000),
    makeItem('pin-boundary-b', 1000),
    makeItem('pin-newer', 1001),
  ];
  // A strict `>` would drop BOTH boundary pins; `>=` keeps them — the seen
  // ledger dedupes the one already presented, the other finally surfaces.
  assert.deepEqual(
    sinceFiltered(items, 1000, 50).map((item) => item.pinId),
    ['pin-boundary-a', 'pin-boundary-b', 'pin-newer'],
  );
});

test('sinceFiltered passes everything through when there is no watermark yet', () => {
  const items = [makeItem('pin-1', 100), makeItem('pin-2', 200)];
  assert.equal(sinceFiltered(items, null, 50).length, 2);
});

test('sinceFiltered drops id-less items and caps at the limit', () => {
  const items = [
    makeItem('', 1000),
    makeItem('pin-a', 1000),
    makeItem('pin-b', 1000),
    makeItem('pin-c', 1000),
  ];
  assert.deepEqual(
    sinceFiltered(items, 1000, 2).map((item) => item.pinId),
    ['pin-a', 'pin-b'],
  );
});

test('applyFreshWindowFilter on a BACKLOG page must NOT apply the since filter (regression: backlog items are older than the watermark)', () => {
  // A backlog page is resumed by the server cursor alone; every item on it
  // is OLDER than the watermark (sinceTs) by construction. Running the
  // window filter on it empties the page while the cursor still advances —
  // paging past unseen content forever (caught in review).
  const items = [makeItem('pin-old-1', 100), makeItem('pin-old-2', 200)];
  assert.deepEqual(
    applyFreshWindowFilter(items, 1789000000, 50, true).map((item) => item.pinId),
    ['pin-old-1', 'pin-old-2'],
    'backlog mode keeps older-than-watermark items',
  );
  assert.deepEqual(
    applyFreshWindowFilter(items, 1789000000, 50, false),
    [],
    'window mode still filters them out',
  );
});

test('applyFreshWindowFilter in backlog mode still drops id-less items and caps at the limit', () => {
  const items = [makeItem('', 100), makeItem('pin-a', 100), makeItem('pin-b', 200), makeItem('pin-c', 300)];
  assert.deepEqual(
    applyFreshWindowFilter(items, 1789000000, 2, true).map((item) => item.pinId),
    ['pin-a', 'pin-b'],
  );
});
