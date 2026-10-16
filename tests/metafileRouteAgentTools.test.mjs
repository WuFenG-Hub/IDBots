import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  extractProbePinId,
  sniffMagicKind,
  isIndexerNotFoundEnvelope,
  probeRoute,
  verdictFromProbes,
  buildMetafileRouteAgentTools,
} = require('../dist-electron/main/libs/metafileRouteAgentTools.js');

const PIN = `${'ab'.repeat(32)}i0`;
const MP4_HEAD = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]);
const NOT_FOUND_BODY = new TextEncoder().encode(
  '{"code":40400,"message":"file not found","processingTime":0,"data":null}'
);

test('extractProbePinId: metafile://, pin://, bare pinId, and rejects junk', () => {
  assert.equal(extractProbePinId(`metafile://${PIN}`), PIN);
  assert.equal(extractProbePinId(PIN), PIN);
  assert.equal(extractProbePinId(''), null);
  assert.equal(extractProbePinId('not-a-pin'), null);
  assert.equal(extractProbePinId('https://example.com/x'), null);
});

test('sniffMagicKind: png/jpeg/zip/mp4 magic detection', () => {
  assert.equal(sniffMagicKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), 'png');
  assert.equal(sniffMagicKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
  assert.equal(sniffMagicKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])), 'zip');
  assert.equal(sniffMagicKind(new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])), 'mp4');
  assert.equal(sniffMagicKind(new Uint8Array([0x00, 0x01, 0x02, 0x03])), null);
});

test('isIndexerNotFoundEnvelope: the 40400 JSON body is not a payload', () => {
  assert.equal(isIndexerNotFoundEnvelope(NOT_FOUND_BODY), true);
  assert.equal(isIndexerNotFoundEnvelope(MP4_HEAD), false);
  assert.equal(isIndexerNotFoundEnvelope(new Uint8Array(0)), false);
});

function fakeResponse({ status = 200, headers = {}, bodyHead = PNG_HEAD } = {}) {
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body: status >= 200 && status < 300 ? new ReadableStream({
      start(controller) { controller.enqueue(bodyHead); /* leave open; reader.cancel() ends it */ },
    }) : null,
  };
}

test('probeRoute: ok probe reads head + magic; transport failure carries the error', async () => {
  const ok = await probeRoute('accelerate', `https://x/accelerate/${PIN}`, async () => fakeResponse({
    headers: { 'content-type': 'image/png', 'content-length': '281235' },
  }));
  assert.equal(ok.ok, true);
  assert.equal(ok.state, 'ok');
  assert.equal(ok.httpStatus, 200);
  assert.equal(ok.magic, 'png');
  assert.equal(ok.receivedBytes, 5);
  assert.equal(ok.declaredLength, 281235);

  const fail = await probeRoute('direct', `https://x/content/${PIN}`, async () => {
    throw new Error('tls handshake failed (curl 35)');
  });
  assert.equal(fail.ok, false);
  assert.equal(fail.state, 'unreachable');
  assert.equal(fail.error, 'tls handshake failed (curl 35)');
});

test('probeRoute: with following disabled a 3xx is redirect-not-followed, never a failure', async () => {
  const result = await probeRoute('accelerate', `https://x/accelerate/${PIN}`, async () => fakeResponse({
    status: 307,
    headers: { location: 'https://oss.example/bucket/file.png' },
  }), { maxRedirects: 0 });
  assert.equal(result.state, 'redirect-not-followed');
  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 307);
  assert.equal(result.redirectedTo, 'https://oss.example/bucket/file.png');
  assert.deepEqual(result.redirectChain, []);
});

test('probeRoute: REGRESSION — follows 307 to the OSS origin and reads real bytes', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url === 'https://acc/pin') return fakeResponse({ status: 307, headers: { location: 'https://oss.example/pin.mp4' } });
    if (url === 'https://oss.example/pin.mp4') {
      return fakeResponse({ status: 206, headers: { 'content-type': 'video/mp4;binary', 'content-length': '3754505' }, bodyHead: MP4_HEAD });
    }
    throw new Error(`unexpected url ${url}`);
  };
  const result = await probeRoute('accelerate', 'https://acc/pin', fetchImpl);
  // The accelerate route's healthy shape IS "307 -> OSS"; the probe must read the
  // terminal bytes and call it healthy, not stop at the 307 and cry broken.
  assert.equal(result.state, 'ok');
  assert.equal(result.ok, true);
  assert.equal(result.httpStatus, 206);
  assert.equal(result.magic, 'mp4');
  assert.equal(result.redirectedTo, 'https://oss.example/pin.mp4');
  assert.deepEqual(result.redirectChain, ['https://oss.example/pin.mp4']);
  assert.deepEqual(seen, ['https://acc/pin', 'https://oss.example/pin.mp4']);
});

test('probeRoute: a terminal 200 carrying the indexer 40400 envelope is bytes-unavailable', async () => {
  const result = await probeRoute('direct', `https://x/content/${PIN}`, async () => fakeResponse({
    headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': '72' },
    bodyHead: NOT_FOUND_BODY,
  }));
  assert.equal(result.state, 'bytes-unavailable');
  assert.equal(result.ok, false);
  assert.equal(result.receivedBytes, 72);
  assert.equal(result.indexerNotFound, true);
});

test('probeRoute: a terminal HTTP error is unreachable', async () => {
  const result = await probeRoute('direct', `https://x/content/${PIN}`, async () => fakeResponse({ status: 503 }));
  assert.equal(result.state, 'unreachable');
  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 503);
});

function probe(overrides = {}) {
  return {
    route: 'direct', url: 'u', state: 'ok', ok: true, httpStatus: 200, redirectedTo: null,
    redirectChain: [], finalUrl: 'u', contentType: 'image/png', declaredLength: 1,
    receivedBytes: 5, magic: 'png', indexerNotFound: false, elapsedMs: 1, error: null,
    ...overrides,
  };
}

test('verdictFromProbes: the four route outcomes are named explicitly', () => {
  const ok = probe();
  const broken = probe({ state: 'unreachable', ok: false, httpStatus: 500, receivedBytes: 0, magic: null, error: 'boom' });
  const empty = probe({ state: 'bytes-unavailable', ok: false, receivedBytes: 72, magic: null, indexerNotFound: true });
  const unfollowed = probe({ state: 'redirect-not-followed', ok: false, httpStatus: 307, receivedBytes: 0, magic: null });

  assert.match(verdictFromProbes(ok, ok), /HEALTHY/);
  assert.match(verdictFromProbes(broken, ok), /RENDER-PATH DEGRADED \(the GT#90 signature\)/);
  assert.match(verdictFromProbes(ok, broken), /PARTIAL/);
  assert.match(verdictFromProbes(broken, broken), /UNREACHABLE on both/);
  assert.match(verdictFromProbes(empty, empty), /UNREACHABLE on both/);
});

test('verdictFromProbes: an unfollowed redirect is INCONCLUSIVE, never DEGRADED', () => {
  const ok = probe();
  const unfollowed = probe({ route: 'accelerate', state: 'redirect-not-followed', ok: false, httpStatus: 307, receivedBytes: 0, magic: null });
  const text = verdictFromProbes(unfollowed, ok);
  assert.match(text, /INCONCLUSIVE/);
  assert.doesNotMatch(text, /DEGRADED/);
  assert.doesNotMatch(text, /render broken/);
});

test('buildMetafileRouteAgentTools: a healthy accelerate 307→OSS pin reports HEALTHY', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/accelerate/')) return fakeResponse({ status: 307, headers: { location: 'https://oss/pin.mp4' } });
    if (url.startsWith('https://oss/')) return fakeResponse({ status: 206, headers: { 'content-type': 'video/mp4;binary' }, bodyHead: MP4_HEAD });
    return fakeResponse({ headers: { 'content-type': 'image/png' } }); // direct
  };
  const tools = buildMetafileRouteAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    fetchImpl,
  });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'check_metafile_route');
  const result = await tools[0].handler({ uri: `metafile://${PIN}` });
  assert.equal(result.isError, undefined);
  const text = result.content[0].text;
  assert.match(text, /VERDICT: HEALTHY/);
  assert.doesNotMatch(text, /DEGRADED/);
  assert.doesNotMatch(text, /render broken/);
  assert.match(text, /state: route healthy/);
  assert.match(text, /redirect chain: https:\/\/oss\/pin\.mp4/);

  const bad = await tools[0].handler({ uri: 'https://example.com/pic.png' });
  assert.equal(bad.isError, true, 'non-metafile input is rejected with guidance');
});

test('buildMetafileRouteAgentTools: a never-published pin (200 + 40400 both routes) reports UNREACHABLE', async () => {
  const tools = buildMetafileRouteAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    fetchImpl: async () => fakeResponse({
      headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': '72' },
      bodyHead: NOT_FOUND_BODY,
    }),
  });
  const text = (await tools[0].handler({ uri: `metafile://${PIN}` })).content[0].text;
  assert.match(text, /VERDICT: UNREACHABLE on both content routes/);
  assert.doesNotMatch(text, /HEALTHY/);
  assert.match(text, /state: no-bytes/);
});

test('buildMetafileRouteAgentTools: a redirect the probe cannot resolve is INCONCLUSIVE', async () => {
  const tools = buildMetafileRouteAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    fetchImpl: async (url) => ((url.includes('/accelerate/') || url.startsWith('https://oss/'))
      ? fakeResponse({ status: 307, headers: { location: 'https://oss/loop' } })   // never resolves within the hop budget
      : fakeResponse({ headers: { 'content-type': 'image/png' } })),
  });
  const text = (await tools[0].handler({ uri: `metafile://${PIN}` })).content[0].text;
  assert.match(text, /VERDICT: INCONCLUSIVE/);
  assert.doesNotMatch(text, /DEGRADED/);
  assert.match(text, /state: redirect-not-followed/);
});
