import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const {
  searchMetaApps,
  listMetaAppForks,
  MetaAppSearchNotFoundError,
} = require('../dist-electron/main/services/metaAppSearchService.js');

const SAMPLE_ITEM = {
  pinId: 'a'.repeat(64) + 'i0',
  sourcePinId: 'a'.repeat(64) + 'i0',
  chainName: 'mvc',
  title: '番茄钟',
  appName: 'pomodoro',
  intro: '极简番茄钟',
  tags: ['tool', 'timer'],
  runtime: 'browser',
  version: '1.0.0',
  content: 'metafile://x.zip',
  indexFile: 'index.html',
  forkedFrom: '',
  disabled: false,
  publisherGlobalMetaId: 'idq1abc',
  publisherMetaId: 'metaId1',
  publisherAddress: 'addr1',
  publisherName: 'BOT-007',
  publisherAvatarId: 'a275356ai0',
  createdAt: 1768284841,
  updatedAt: 1768284841,
};

function stubFetch(body, capture = {}) {
  return async (url) => {
    capture.url = url;
    return {
      status: 200,
      json: async () => body,
    };
  };
}

test('searchMetaApps builds the list URL and normalizes items', async () => {
  const capture = {};
  const page = await searchMetaApps(
    { keyword: '番茄钟 极简', tag: 'tool', publisher: 'idq1abc', since: 1768000000, size: 8 },
    { fetchImpl: stubFetch({ code: 0, message: 'ok', data: { items: [SAMPLE_ITEM], nextCursor: 'abc', hasMore: true } }, capture) },
  );
  const url = new URL(capture.url);
  assert.equal(url.origin + url.pathname, 'https://so.metaid.io/api/metaapp/list');
  assert.equal(url.searchParams.get('keyword'), '番茄钟 极简');
  assert.equal(url.searchParams.get('tag'), 'tool');
  assert.equal(url.searchParams.get('publisher'), 'idq1abc');
  assert.equal(url.searchParams.get('since'), '1768000000');
  assert.equal(url.searchParams.get('size'), '8');

  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].title, '番茄钟');
  assert.deepEqual(page.items[0].tags, ['tool', 'timer']);
  assert.equal(page.items[0].publisherName, 'BOT-007');
  assert.equal(page.items[0].publisherAvatarId, 'a275356ai0');
  assert.equal(page.nextCursor, 'abc');
  assert.equal(page.hasMore, true);
});

test('searchMetaApps omits empty params and tolerates missing item fields', async () => {
  const capture = {};
  const page = await searchMetaApps({}, {
    fetchImpl: stubFetch({ code: 0, data: { items: [{ pinId: 'x' }] } }, capture),
  });
  assert.equal(capture.url, 'https://so.metaid.io/api/metaapp/list');
  assert.equal(page.items[0].indexFile, 'index.html');
  assert.equal(page.items[0].disabled, false);
  assert.equal(page.hasMore, false);
});

test('searchMetaApps maps API error codes to typed errors', async () => {
  await assert.rejects(
    searchMetaApps({ keyword: 'x' }, { fetchImpl: stubFetch({ code: 40000, message: 'bad cursor' }) }),
    /40000: bad cursor/,
  );
  await assert.rejects(
    searchMetaApps({ keyword: 'x' }, { fetchImpl: stubFetch({ code: 40400, message: 'not here' }) }),
    (error) => error instanceof MetaAppSearchNotFoundError,
  );
});

test('searchMetaApps throws on an invalid response body', async () => {
  await assert.rejects(
    searchMetaApps({}, { fetchImpl: async () => ({ status: 200, json: async () => null }) }),
    /invalid response/,
  );
});

test('listMetaAppForks encodes the pinId and passes size', async () => {
  const capture = {};
  const pinId = 'b'.repeat(64) + 'i0';
  const page = await listMetaAppForks({ pinId, size: 5 }, {
    fetchImpl: stubFetch({ code: 0, data: { items: [SAMPLE_ITEM], hasMore: false } }, capture),
  });
  assert.equal(capture.url, `https://so.metaid.io/api/metaapp/forks/${pinId}?size=5`);
  assert.equal(page.items.length, 1);
});

test('listMetaAppForks requires a pinId', async () => {
  await assert.rejects(listMetaAppForks({ pinId: ' ' }, { fetchImpl: stubFetch({}) }), /pinId is required/);
});
