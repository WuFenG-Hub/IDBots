import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { HostLocationService } = require('../dist-electron/main/services/hostLocationService.js');

const BIGDATACLOUD_ZHONGSHAN = {
  latitude: 22.517,
  longitude: 113.392,
  countryName: '中国',
  principalSubdivision: '广东省',
  city: '中山市',
  locality: '中山市',
  localityInfo: {
    administrative: [
      { name: '中国', order: 2, adminLevel: 1 },
      { name: '广东省', order: 4, adminLevel: 2 },
      { name: '中山市', order: 7, adminLevel: 4 },
      { name: '东区街道', order: 8, adminLevel: 5 },
    ],
    informative: [
      { name: 'China Standard Time', order: 3 },
      { name: 'Asia/Shanghai', order: 5 },
    ],
  },
};

const IP_API_ZHONGSHAN = {
  status: 'success',
  country: '中国',
  regionName: '广东',
  city: '中山',
  district: '',
  lat: 22.5199,
  lon: 113.3944,
  timezone: 'Asia/Shanghai',
  query: '203.0.113.7',
};

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

/**
 * fetch fake driven by a list of responder rules. Every call is recorded;
 * rules match by URL substring, in order, with a per-rule responder.
 */
function makeFetchFake(rules) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const rule = rules.find((candidate) => String(url).includes(candidate.match));
    if (!rule) {
      throw new Error(`no rule for ${url}`);
    }
    return rule.respond();
  };
  return { calls, fetchImpl };
}

function makeService(fetchImpl, overrides = {}) {
  let clock = overrides.clock ?? 1_000_000;
  const service = new HostLocationService({
    fetchImpl,
    now: () => clock,
    getLanguage: () => overrides.language ?? 'zh',
    ...overrides.serviceOptions,
  });
  return {
    service,
    advanceClock: (ms) => { clock += ms; },
  };
}

test('BigDataCloud success maps fields, extracts the district below the city, and finds the timezone', async () => {
  const { calls, fetchImpl } = makeFetchFake([
    { match: 'bigdatacloud.net', respond: () => jsonResponse(BIGDATACLOUD_ZHONGSHAN) },
  ]);
  const { service } = makeService(fetchImpl);
  const result = await service.getCoarseLocation();
  assert.equal(result.granularity, 'coarse');
  assert.equal(result.source, 'ip');
  assert.equal(result.provider, 'bigdatacloud');
  assert.equal(result.country, '中国');
  assert.equal(result.region, '广东省');
  assert.equal(result.city, '中山市');
  // Deepest administrative entry below the city (order 8), not the city itself.
  assert.equal(result.district, '东区街道');
  assert.equal(result.latitude, 22.517);
  assert.equal(result.longitude, 113.392);
  assert.equal(result.timezone, 'Asia/Shanghai');
  assert.match(result.accuracyNote, /IP address/);
  assert.match(result.accuracyNote, /delivery/);
  assert.equal(result.fetchedAt, new Date(1_000_000).toISOString());
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /localityLanguage=zh/);
  assert.ok(!calls[0].url.includes('latitude='), 'coarse lookup must not pass coordinates');
});

test('a shallow BigDataCloud response does not mislabel the region as district', async () => {
  const shallow = {
    latitude: 37.7,
    longitude: -122.4,
    countryName: 'United States',
    principalSubdivision: 'California',
    city: 'San Francisco',
    localityInfo: {
      administrative: [
        { name: 'United States', order: 2 },
        { name: 'California', order: 4 },
        { name: 'San Francisco', order: 6 },
      ],
      informative: [],
    },
  };
  const { fetchImpl } = makeFetchFake([
    { match: 'bigdatacloud.net', respond: () => jsonResponse(shallow) },
  ]);
  const { service } = makeService(fetchImpl, { language: 'en' });
  const result = await service.getCoarseLocation();
  assert.equal(result.city, 'San Francisco');
  assert.equal(result.district, undefined);
  assert.equal(result.timezone, undefined);
});

test('falls back to ip-api.com when BigDataCloud fails, and passes lang=zh-CN', async () => {
  const { calls, fetchImpl } = makeFetchFake([
    { match: 'bigdatacloud.net', respond: () => jsonResponse({}, { ok: false, status: 502 }) },
    { match: 'ip-api.com', respond: () => jsonResponse(IP_API_ZHONGSHAN) },
  ]);
  const { service } = makeService(fetchImpl);
  const result = await service.getCoarseLocation();
  assert.equal(result.provider, 'ip-api.com');
  assert.equal(result.city, '中山');
  assert.equal(result.region, '广东');
  assert.equal(result.district, undefined, 'empty ip-api district string must not surface');
  assert.equal(result.timezone, 'Asia/Shanghai');
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.startsWith('http://ip-api.com/'), 'free tier is HTTP-only');
  assert.match(calls[1].url, /lang=zh-CN/);
});

test('a network error on BigDataCloud also triggers the ip-api fallback', async () => {
  const { fetchImpl } = makeFetchFake([
    { match: 'bigdatacloud.net', respond: () => { throw new Error('socket hang up'); } },
    { match: 'ip-api.com', respond: () => jsonResponse(IP_API_ZHONGSHAN) },
  ]);
  const { service } = makeService(fetchImpl);
  const result = await service.getCoarseLocation();
  assert.equal(result.provider, 'ip-api.com');
});

test('ip-api status != success is treated as failure and the both-fail error names both providers', async () => {
  const { fetchImpl } = makeFetchFake([
    { match: 'bigdatacloud.net', respond: () => { throw new Error('dns failed'); } },
    { match: 'ip-api.com', respond: () => jsonResponse({ status: 'fail', message: 'reserved range' }) },
  ]);
  const { service } = makeService(fetchImpl);
  await assert.rejects(
    () => service.getCoarseLocation(),
    /IP-based location lookup failed — BigDataCloud: dns failed; ip-api\.com: ip-api\.com reported status "fail": reserved range/,
  );
});

test('a BigDataCloud payload without coordinates is a parse failure (falls back)', async () => {
  const { fetchImpl } = makeFetchFake([
    { match: 'bigdatacloud.net', respond: () => jsonResponse({ countryName: '中国' }) },
    { match: 'ip-api.com', respond: () => jsonResponse(IP_API_ZHONGSHAN) },
  ]);
  const { service } = makeService(fetchImpl);
  const result = await service.getCoarseLocation();
  assert.equal(result.provider, 'ip-api.com');
});

test('coarse results are cached for the TTL — a second call does not refetch', async () => {
  const { calls, fetchImpl } = makeFetchFake([
    { match: 'bigdatacloud.net', respond: () => jsonResponse(BIGDATACLOUD_ZHONGSHAN) },
  ]);
  const { service, advanceClock } = makeService(fetchImpl);
  const first = await service.getCoarseLocation();
  advanceClock(60 * 60 * 1000); // 1h — inside the 6h TTL
  const second = await service.getCoarseLocation();
  assert.equal(calls.length, 1);
  assert.equal(second, first);
});

test('the coarse cache expires after the TTL and refetches', async () => {
  const { calls, fetchImpl } = makeFetchFake([
    { match: 'bigdatacloud.net', respond: () => jsonResponse(BIGDATACLOUD_ZHONGSHAN) },
  ]);
  const { service, advanceClock } = makeService(fetchImpl);
  await service.getCoarseLocation();
  advanceClock(6 * 60 * 60 * 1000 + 1);
  await service.getCoarseLocation();
  assert.equal(calls.length, 2);
});

test('reverseGeocode passes coordinates to BigDataCloud and reports accuracy', async () => {
  const { calls, fetchImpl } = makeFetchFake([
    { match: 'bigdatacloud.net', respond: () => jsonResponse(BIGDATACLOUD_ZHONGSHAN) },
  ]);
  const { service } = makeService(fetchImpl);
  const result = await service.reverseGeocode({ latitude: 22.51701, longitude: 113.39201, accuracyMeters: 42.4 });
  assert.equal(result.granularity, 'precise');
  assert.equal(result.source, 'system');
  assert.equal(result.provider, 'bigdatacloud');
  assert.equal(result.district, '东区街道');
  assert.equal(result.accuracyMeters, 42);
  assert.match(result.accuracyNote, /±42 m/);
  assert.match(result.accuracyNote, /NOT a confirmed delivery address/);
  assert.match(calls[0].url, /latitude=22\.51701/);
  assert.match(calls[0].url, /longitude=113\.39201/);
  assert.match(calls[0].url, /localityLanguage=zh/);
});

test('reverseGeocode caches by rounded coordinates for 5 minutes', async () => {
  const { calls, fetchImpl } = makeFetchFake([
    { match: 'bigdatacloud.net', respond: () => jsonResponse(BIGDATACLOUD_ZHONGSHAN) },
  ]);
  const { service, advanceClock } = makeService(fetchImpl);
  await service.reverseGeocode({ latitude: 22.517011, longitude: 113.392011 });
  // Same 4-decimal cache key — no refetch.
  await service.reverseGeocode({ latitude: 22.517014, longitude: 113.392014 });
  assert.equal(calls.length, 1);
  // A genuinely different fix refetches.
  await service.reverseGeocode({ latitude: 22.6, longitude: 113.5 });
  assert.equal(calls.length, 2);
  // ...and the first key expires after the short TTL.
  advanceClock(5 * 60 * 1000 + 1);
  await service.reverseGeocode({ latitude: 22.517011, longitude: 113.392011 });
  assert.equal(calls.length, 3);
});

test('reverseGeocode rejects invalid coordinates without fetching', async () => {
  const { calls, fetchImpl } = makeFetchFake([]);
  const { service } = makeService(fetchImpl);
  await assert.rejects(() => service.reverseGeocode({ latitude: NaN, longitude: 113 }), /Invalid system fix/);
  assert.equal(calls.length, 0);
});

test('language switches both providers to English', async () => {
  const { calls, fetchImpl } = makeFetchFake([
    {
      match: 'bigdatacloud.net',
      respond: () => jsonResponse({
        latitude: 37.7, longitude: -122.4, countryName: 'United States',
        principalSubdivision: 'California', city: 'San Francisco',
        localityInfo: { administrative: [], informative: [{ name: 'America/Los_Angeles' }] },
      }),
    },
    { match: 'ip-api.com', respond: () => jsonResponse({ ...IP_API_ZHONGSHAN, status: 'success' }) },
  ]);
  const { service } = makeService(fetchImpl, { language: 'en' });
  await service.getCoarseLocation();
  assert.match(calls[0].url, /localityLanguage=en/);
  await service.reverseGeocode({ latitude: 37.7, longitude: -122.4 });
  assert.match(calls[1].url, /localityLanguage=en/);
});
