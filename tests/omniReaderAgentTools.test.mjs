import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { buildOmniReaderAgentTools } = require('../dist-electron/main/libs/omniReaderAgentTools.js');

function makeHarness(overrides = {}) {
  const calls = { fetchJson: [], fetchText: [] };
  const control = {
    fetchJson: async (url) => {
      calls.fetchJson.push(url);
      if (overrides.fetchJsonError) {
        // Allow per-URL failures (string matched against the url) or a global one.
        const err = overrides.fetchJsonError;
        if (err instanceof Error) throw err;
        if (typeof err === 'object') {
          for (const [needle, error] of Object.entries(err)) {
            if (url.includes(needle)) throw error;
          }
        }
      }
      return overrides.fetchJsonResult ?? { code: 0, data: { ok: true } };
    },
    fetchText: async (url) => {
      calls.fetchText.push(url);
      if (overrides.fetchTextError) throw overrides.fetchTextError;
      return overrides.fetchTextResult ?? 'raw body';
    },
  };
  const tools = buildOmniReaderAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, handler }),
    control,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName };
}

test('builds a single omni_read tool', () => {
  const { byName } = makeHarness();
  assert.ok(byName.omni_read);
  assert.equal(Object.keys(byName).length, 1);
});

test('user_info by metaid hits the metafile-indexer info endpoint with encoded id', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.omni_read.handler({ action: 'user_info', metaid: 'abc123' });
  assert.equal(result.isError, undefined);
  assert.equal(
    calls.fetchJson[0],
    'https://file.metaid.io/metafile-indexer/api/v1/info/metaid/abc123',
  );
});

test('user_info falls back to manapi when the indexer fails (metaid/address only)', async () => {
  const { calls, byName } = makeHarness({
    fetchJsonError: { 'file.metaid.io': new Error('indexer down') },
  });
  const result = await byName.omni_read.handler({ action: 'user_info', address: '1Boat' });
  assert.equal(result.isError, undefined);
  assert.equal(calls.fetchJson.length, 2);
  assert.equal(calls.fetchJson[1], 'https://manapi.metaid.io/api/info/address/1Boat');
});

test('user_info with globalmetaid does NOT fall back to manapi', async () => {
  const { calls, byName } = makeHarness({
    fetchJsonError: new Error('indexer down'),
  });
  const result = await byName.omni_read.handler({ action: 'user_info', globalmetaid: 'idq1alice' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /indexer down/);
  assert.equal(calls.fetchJson.length, 1);
});

test('user_info reports both errors when the manapi fallback also fails', async () => {
  const { byName } = makeHarness({
    fetchJsonError: {
      'file.metaid.io': new Error('indexer down'),
      'manapi.metaid.io': new Error('manapi down'),
    },
  });
  const result = await byName.omni_read.handler({ action: 'user_info', metaid: 'abc123' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /metafile-indexer: indexer down/);
  assert.match(result.content[0].text, /manapi fallback: manapi down/);
});

test('user_info requires exactly one id param', async () => {
  const { calls, byName } = makeHarness();
  const none = await byName.omni_read.handler({ action: 'user_info' });
  assert.equal(none.isError, true);
  assert.match(none.content[0].text, /exactly one of metaid, address, or globalmetaid/);
  const two = await byName.omni_read.handler({ action: 'user_info', metaid: 'a', address: 'b' });
  assert.equal(two.isError, true);
  assert.equal(calls.fetchJson.length, 0);
});

test('search_users builds the keyword query with default limit 10', async () => {
  const { calls, byName } = makeHarness();
  await byName.omni_read.handler({ action: 'search_users', keyword: 'alice', keytype: 'name' });
  const url = new URL(calls.fetchJson[0]);
  assert.equal(url.origin + url.pathname, 'https://file.metaid.io/metafile-indexer/api/v1/info/search');
  assert.equal(url.searchParams.get('keyword'), 'alice');
  assert.equal(url.searchParams.get('keytype'), 'name');
  assert.equal(url.searchParams.get('limit'), '10');
});

test('search_users requires keyword', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.omni_read.handler({ action: 'search_users' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /requires keyword/);
  assert.equal(calls.fetchJson.length, 0);
});

test('buzz_newest forwards lastId/size/metaid/followed to show.now', async () => {
  const { calls, byName } = makeHarness();
  await byName.omni_read.handler({
    action: 'buzz_newest', lastId: '99', size: 10, metaid: 'm1', followed: 1,
  });
  const url = new URL(calls.fetchJson[0]);
  assert.equal(url.origin + url.pathname, 'https://show.now/man/social/buzz/newest');
  assert.equal(url.searchParams.get('lastId'), '99');
  assert.equal(url.searchParams.get('size'), '10');
  assert.equal(url.searchParams.get('metaid'), 'm1');
  assert.equal(url.searchParams.get('followed'), '1');
});

test('buzz_hot rejects size > 50 without fetching', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.omni_read.handler({ action: 'buzz_hot', size: 51 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /size must be <= 50/);
  assert.equal(calls.fetchJson.length, 0);
});

test('buzz_search requires key; buzz_info requires pinId', async () => {
  const { calls, byName } = makeHarness();
  const search = await byName.omni_read.handler({ action: 'buzz_search' });
  assert.equal(search.isError, true);
  assert.match(search.content[0].text, /requires key/);
  const info = await byName.omni_read.handler({ action: 'buzz_info' });
  assert.equal(info.isError, true);
  assert.match(info.content[0].text, /requires pinId/);
  assert.equal(calls.fetchJson.length, 0);
});

test('buzz_search and buzz_info hit the show.now endpoints', async () => {
  const { calls, byName } = makeHarness();
  await byName.omni_read.handler({ action: 'buzz_search', key: 'meta id' });
  const searchUrl = new URL(calls.fetchJson[0]);
  assert.equal(searchUrl.origin + searchUrl.pathname, 'https://show.now/man/social/buzz/search');
  assert.equal(searchUrl.searchParams.get('key'), 'meta id');
  await byName.omni_read.handler({ action: 'buzz_info', pinId: 'txid1i0' });
  const infoUrl = new URL(calls.fetchJson[1]);
  assert.equal(infoUrl.origin + infoUrl.pathname, 'https://show.now/man/social/buzz/info');
  assert.equal(infoUrl.searchParams.get('pinId'), 'txid1i0');
});

test('notifications keeps the backend "notifcation" typo and requires address', async () => {
  const { calls, byName } = makeHarness();
  const missing = await byName.omni_read.handler({ action: 'notifications' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /requires address/);
  await byName.omni_read.handler({ action: 'notifications', address: '1Boat', size: 20, lastId: '1773555167558' });
  const url = new URL(calls.fetchJson[0]);
  assert.equal(url.origin + url.pathname, 'https://manapi.metaid.io/api/notifcation/list');
  assert.equal(url.searchParams.get('address'), '1Boat');
  assert.equal(url.searchParams.get('size'), '20');
  assert.equal(url.searchParams.get('lastId'), '1773555167558');
});

test('followers/following hit man.metaid.io with followDetail=true and cursor default 0', async () => {
  const { calls, byName } = makeHarness();
  await byName.omni_read.handler({ action: 'followers', metaid: 'm1' });
  const followersUrl = new URL(calls.fetchJson[0]);
  assert.equal(followersUrl.origin + followersUrl.pathname, 'https://man.metaid.io/api/metaid/followerList/m1');
  assert.equal(followersUrl.searchParams.get('cursor'), '0');
  assert.equal(followersUrl.searchParams.get('followDetail'), 'true');
  await byName.omni_read.handler({ action: 'following', metaid: 'm1', cursor: '5', size: 10 });
  const followingUrl = new URL(calls.fetchJson[1]);
  assert.equal(followingUrl.origin + followingUrl.pathname, 'https://man.metaid.io/api/metaid/followingList/m1');
  assert.equal(followingUrl.searchParams.get('cursor'), '5');
  assert.equal(followingUrl.searchParams.get('size'), '10');
  const missing = await byName.omni_read.handler({ action: 'followers' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /requires metaid/);
});

test('pin and pin_version build manapi URLs', async () => {
  const { calls, byName } = makeHarness();
  await byName.omni_read.handler({ action: 'pin', pinId: 'txid1i0' });
  assert.equal(calls.fetchJson[0], 'https://manapi.metaid.io/api/pin/txid1i0');
  await byName.omni_read.handler({ action: 'pin_version', pinId: 'txid1i0', ver: 2 });
  assert.equal(calls.fetchJson[1], 'https://manapi.metaid.io/api/pin/ver/txid1i0/2');
  const missingVer = await byName.omni_read.handler({ action: 'pin_version', pinId: 'txid1i0' });
  assert.equal(missingVer.isError, true);
  assert.match(missingVer.content[0].text, /requires ver/);
});

test('paged lists (pin_list, metaid_list, block_list, mempool_list) forward page/size', async () => {
  const { calls, byName } = makeHarness();
  for (const [action, segment] of [
    ['pin_list', 'pin'],
    ['metaid_list', 'metaid'],
    ['block_list', 'block'],
    ['mempool_list', 'mempool'],
  ]) {
    await byName.omni_read.handler({ action, page: 2, size: 5 });
  }
  assert.deepEqual(
    calls.fetchJson,
    [
      'https://manapi.metaid.io/api/pin/list?page=2&size=5',
      'https://manapi.metaid.io/api/metaid/list?page=2&size=5',
      'https://manapi.metaid.io/api/block/list?page=2&size=5',
      'https://manapi.metaid.io/api/mempool/list?page=2&size=5',
    ],
  );
});

test('pins_by_path requires path and encodes it as a query param', async () => {
  const { calls, byName } = makeHarness();
  const missing = await byName.omni_read.handler({ action: 'pins_by_path' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /requires path/);
  await byName.omni_read.handler({ action: 'pins_by_path', path: '/protocols/simplebuzz', size: 20 });
  const url = new URL(calls.fetchJson[0]);
  assert.equal(url.origin + url.pathname, 'https://manapi.metaid.io/api/pin/path/list');
  assert.equal(url.searchParams.get('path'), '/protocols/simplebuzz');
  assert.equal(url.searchParams.get('size'), '20');
});

test('pins_by_path rejects size outside 1-100', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.omni_read.handler({ action: 'pins_by_path', path: '/p', size: 101 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /between 1 and 100/);
  assert.equal(calls.fetchJson.length, 0);
});

test('pins_by_metaid / pins_by_address build path-segment URLs with optional filters', async () => {
  const { calls, byName } = makeHarness();
  await byName.omni_read.handler({
    action: 'pins_by_metaid', metaid: 'm1', path: '/protocols/simplebuzz', size: 10, cursor: 'c1',
  });
  const byMetaid = new URL(calls.fetchJson[0]);
  assert.equal(byMetaid.origin + byMetaid.pathname, 'https://manapi.metaid.io/api/metaid/pin/list/m1');
  assert.equal(byMetaid.searchParams.get('path'), '/protocols/simplebuzz');
  assert.equal(byMetaid.searchParams.get('cursor'), 'c1');

  const missingPath = await byName.omni_read.handler({ action: 'pins_by_address', address: '1Boat' });
  assert.equal(missingPath.isError, true);
  assert.match(missingPath.content[0].text, /requires path/);

  await byName.omni_read.handler({ action: 'pins_by_address', address: '1Boat', path: '/protocols/simplebuzz' });
  const byAddress = new URL(calls.fetchJson[1]);
  assert.equal(byAddress.origin + byAddress.pathname, 'https://manapi.metaid.io/api/address/pin/list/1Boat');
  assert.equal(byAddress.searchParams.get('path'), '/protocols/simplebuzz');
});

test('pin_content returns the raw body via fetchText, not JSON', async () => {
  const { calls, byName } = makeHarness({ fetchTextResult: '{"hello":"world"}' });
  const result = await byName.omni_read.handler({ action: 'pin_content', pinId: 'txid1i0' });
  assert.equal(calls.fetchText[0], 'https://manapi.metaid.io/content/txid1i0');
  assert.equal(calls.fetchJson.length, 0);
  assert.equal(result.content[0].text, '{"hello":"world"}');
});

test('file_info and file_latest hit the metafile-indexer files endpoints', async () => {
  const { calls, byName } = makeHarness();
  await byName.omni_read.handler({ action: 'file_info', pinId: 'txid1i0' });
  assert.equal(calls.fetchJson[0], 'https://file.metaid.io/metafile-indexer/api/v1/files/txid1i0');
  await byName.omni_read.handler({ action: 'file_latest', firstPinId: 'txid0i0' });
  assert.equal(calls.fetchJson[1], 'https://file.metaid.io/metafile-indexer/api/v1/files/latest/txid0i0');
  const missing = await byName.omni_read.handler({ action: 'file_latest' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /requires firstPinId/);
});

test('files_by_creator and files_by_metaid forward cursor/size', async () => {
  const { calls, byName } = makeHarness();
  await byName.omni_read.handler({ action: 'files_by_creator', address: '1Boat', size: 20 });
  const creator = new URL(calls.fetchJson[0]);
  assert.equal(creator.origin + creator.pathname, 'https://file.metaid.io/metafile-indexer/api/v1/files/creator/1Boat');
  assert.equal(creator.searchParams.get('size'), '20');
  await byName.omni_read.handler({ action: 'files_by_metaid', metaid: 'm1', cursor: 'c9' });
  const byMetaid = new URL(calls.fetchJson[1]);
  assert.equal(byMetaid.origin + byMetaid.pathname, 'https://file.metaid.io/metafile-indexer/api/v1/files/metaid/m1');
  assert.equal(byMetaid.searchParams.get('cursor'), 'c9');
});

test('files_by_extension uses the metaid variant when metaid is given', async () => {
  const { calls, byName } = makeHarness();
  const missing = await byName.omni_read.handler({ action: 'files_by_extension' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /requires extension/);

  await byName.omni_read.handler({ action: 'files_by_extension', extension: '.jpg', size: 20 });
  const plain = new URL(calls.fetchJson[0]);
  assert.equal(plain.origin + plain.pathname, 'https://file.metaid.io/metafile-indexer/api/v1/files/extension');
  assert.equal(plain.searchParams.get('extension'), '.jpg');

  await byName.omni_read.handler({ action: 'files_by_extension', extension: '.png', metaid: 'm1' });
  const withMetaid = new URL(calls.fetchJson[1]);
  assert.equal(
    withMetaid.origin + withMetaid.pathname,
    'https://file.metaid.io/metafile-indexer/api/v1/files/metaid/m1/extension',
  );
  assert.equal(withMetaid.searchParams.get('extension'), '.png');
});

test('indexer_status, indexer_stats, and global_counts hit their endpoints', async () => {
  const { calls, byName } = makeHarness();
  await byName.omni_read.handler({ action: 'indexer_status' });
  await byName.omni_read.handler({ action: 'indexer_stats' });
  await byName.omni_read.handler({ action: 'global_counts' });
  assert.deepEqual(calls.fetchJson, [
    'https://file.metaid.io/metafile-indexer/api/v1/status',
    'https://file.metaid.io/metafile-indexer/api/v1/stats',
    'https://manapi.metaid.io/debug/count',
  ]);
});

test('results are pretty-printed JSON', async () => {
  const { byName } = makeHarness({ fetchJsonResult: { code: 0, data: { name: 'alice' } } });
  const result = await byName.omni_read.handler({ action: 'indexer_status' });
  assert.equal(result.content[0].text, JSON.stringify({ code: 0, data: { name: 'alice' } }, null, 2));
});

test('oversized results are truncated with a narrowing note', async () => {
  const big = { data: 'x'.repeat(30000) };
  const { byName } = makeHarness({ fetchJsonResult: big });
  const result = await byName.omni_read.handler({ action: 'indexer_stats' });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /\(truncated, narrow the query with cursor\/size\)/);
  assert.ok(result.content[0].text.length < 30000);
});

test('fetch failures surface as an error result without throwing', async () => {
  const { byName } = makeHarness({ fetchJsonError: new Error('HTTP 502') });
  const result = await byName.omni_read.handler({ action: 'indexer_status' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /omni_read indexer_status failed: HTTP 502/);
});

test('pin_content fetchText failures surface as an error result', async () => {
  const { byName } = makeHarness({ fetchTextError: new Error('HTTP 404') });
  const result = await byName.omni_read.handler({ action: 'pin_content', pinId: 'missingi0' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /omni_read pin_content failed: HTTP 404/);
});
