import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const {
  searchMetaIds,
  getMetaIdDetail,
  MetaIdSearchNotFoundError,
} = require('../dist-electron/main/services/metaIdSearchService.js');

const SAMPLE_ITEM = {
  globalMetaId: 'idq1alice123',
  metaId: 'legacyMetaId1',
  address: 'addr1',
  chainName: 'mvc',
  name: 'Alice',
  avatarId: 'a275356ai0',
  bio: '链上生活记录者',
  chatSkills: ['translate', 'draw'],
  hasChatPubkey: true,
  hasHomepage: true,
  createdAt: 1768284841,
  updatedAt: 1768284841,
};

const SAMPLE_DETAIL = {
  ...SAMPLE_ITEM,
  avatarContentType: 'image/png',
  role: 'translator bot',
  soul: '热情开朗',
  goal: '帮助用户跨语言交流',
  persona: { traits: ['cheerful', 'patient'] },
  llm: { provider: 'anthropic', model: 'claude-sonnet', name: 'Alice Brain' },
  homepage: { type: 'metaidapp', uri: 'metaidapp://home' },
  background: '/content/bgpini0',
  chatPubkey: 'pubkey123',
  fieldPins: { name: 'namepini0', avatar: 'a275356ai0', bio: 'biopini0' },
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

test('searchMetaIds builds the list URL with all params and normalizes items', async () => {
  const capture = {};
  const page = await searchMetaIds(
    {
      keyword: '开朗 聊天',
      skill: 'translate',
      chainName: 'mvc',
      hasChatPubkey: true,
      hasHomepage: true,
      since: 1768000000,
      until: 1768289999,
      size: 8,
      cursor: 'eyJvIjoyMH0',
    },
    { fetchImpl: stubFetch({ code: 0, message: 'ok', data: { items: [SAMPLE_ITEM], nextCursor: 'abc', hasMore: true } }, capture) },
  );
  const url = new URL(capture.url);
  assert.equal(url.origin + url.pathname, 'https://so.metaid.io/api/metaid/list');
  assert.equal(url.searchParams.get('keyword'), '开朗 聊天');
  assert.equal(url.searchParams.get('skill'), 'translate');
  assert.equal(url.searchParams.get('chainName'), 'mvc');
  assert.equal(url.searchParams.get('hasChatPubkey'), '1');
  assert.equal(url.searchParams.get('hasHomepage'), '1');
  assert.equal(url.searchParams.get('since'), '1768000000');
  assert.equal(url.searchParams.get('until'), '1768289999');
  assert.equal(url.searchParams.get('size'), '8');
  assert.equal(url.searchParams.get('cursor'), 'eyJvIjoyMH0');

  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].globalMetaId, 'idq1alice123');
  assert.equal(page.items[0].name, 'Alice');
  assert.deepEqual(page.items[0].chatSkills, ['translate', 'draw']);
  assert.equal(page.items[0].hasChatPubkey, true);
  assert.equal(page.items[0].hasHomepage, true);
  assert.equal(page.nextCursor, 'abc');
  assert.equal(page.hasMore, true);
});

test('searchMetaIds omits empty params and tolerates missing item fields', async () => {
  const capture = {};
  const page = await searchMetaIds({}, {
    fetchImpl: stubFetch({ code: 0, data: { items: [{ globalMetaId: 'idq1x' }] } }, capture),
  });
  assert.equal(capture.url, 'https://so.metaid.io/api/metaid/list');
  assert.equal(page.items[0].name, '');
  assert.deepEqual(page.items[0].chatSkills, []);
  assert.equal(page.items[0].hasChatPubkey, false);
  assert.equal(page.items[0].hasHomepage, false);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
});

test('searchMetaIds maps API error codes to typed errors', async () => {
  await assert.rejects(
    searchMetaIds({ keyword: 'x' }, { fetchImpl: stubFetch({ code: 40000, message: 'bad cursor' }) }),
    /40000: bad cursor/,
  );
  await assert.rejects(
    searchMetaIds({ keyword: 'x' }, { fetchImpl: stubFetch({ code: 40400, message: 'not here' }) }),
    (error) => error instanceof MetaIdSearchNotFoundError,
  );
});

test('searchMetaIds throws on an invalid response body', async () => {
  await assert.rejects(
    searchMetaIds({}, { fetchImpl: async () => ({ status: 200, json: async () => null }) }),
    /invalid response/,
  );
});

test('getMetaIdDetail encodes the identity and normalizes the profile', async () => {
  const capture = {};
  const detail = await getMetaIdDetail('idq1alice123', {
    fetchImpl: stubFetch({ code: 0, data: SAMPLE_DETAIL }, capture),
  });
  assert.equal(capture.url, 'https://so.metaid.io/api/metaid/detail/idq1alice123');
  assert.equal(detail.globalMetaId, 'idq1alice123');
  assert.equal(detail.name, 'Alice');
  assert.equal(detail.role, 'translator bot');
  assert.equal(detail.soul, '热情开朗');
  assert.equal(detail.goal, '帮助用户跨语言交流');
  assert.deepEqual(detail.persona, { traits: ['cheerful', 'patient'] });
  assert.deepEqual(detail.llm, { provider: 'anthropic', model: 'claude-sonnet', name: 'Alice Brain' });
  assert.deepEqual(detail.homepage, { type: 'metaidapp', uri: 'metaidapp://home' });
  assert.equal(detail.background, '/content/bgpini0');
  assert.equal(detail.chatPubkey, 'pubkey123');
  assert.deepEqual(detail.fieldPins, { name: 'namepini0', avatar: 'a275356ai0', bio: 'biopini0' });
});

test('getMetaIdDetail tolerates missing optional detail fields', async () => {
  const detail = await getMetaIdDetail('addr9', {
    fetchImpl: stubFetch({ code: 0, data: { globalMetaId: 'idq1x', name: 'Bob', llm: {}, persona: 'not-json', fieldPins: { name: '' } } }),
  });
  assert.equal(detail.name, 'Bob');
  assert.equal(detail.llm, null);
  assert.equal(detail.persona, null);
  assert.equal(detail.homepage, null);
  assert.deepEqual(detail.fieldPins, {});
  assert.equal(detail.chatPubkey, '');
});

test('getMetaIdDetail requires a non-empty identity', async () => {
  await assert.rejects(getMetaIdDetail('  ', { fetchImpl: stubFetch({}) }), /identity is required/);
});

test('getMetaIdDetail maps 40400 to MetaIdSearchNotFoundError', async () => {
  await assert.rejects(
    getMetaIdDetail('idq1ghost', { fetchImpl: stubFetch({ code: 40400, message: 'identity not found' }) }),
    (error) => error instanceof MetaIdSearchNotFoundError,
  );
});
