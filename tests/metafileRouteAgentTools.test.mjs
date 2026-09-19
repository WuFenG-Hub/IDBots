import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  extractProbePinId,
  sniffMagicKind,
  probeRoute,
  verdictFromProbes,
  buildMetafileRouteAgentTools,
} = require('../dist-electron/main/libs/metafileRouteAgentTools.js');

const PIN = `${'ab'.repeat(32)}i0`;

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

function fakeResponse({ status = 200, headers = {}, bodyHead = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]) } = {}) {
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body: status >= 200 && status < 300 ? new ReadableStream({
      start(controller) { controller.enqueue(bodyHead); /* leave open; reader.cancel() ends it */ },
    }) : null,
  };
}

test('probeRoute: ok probe reads head + magic; failure probe carries the error', async () => {
  const ok = await probeRoute('accelerate', `https://x/accelerate/${PIN}`, async () => fakeResponse({
    headers: { 'content-type': 'image/png', 'content-length': '281235' },
  }));
  assert.equal(ok.ok, true);
  assert.equal(ok.httpStatus, 200);
  assert.equal(ok.magic, 'png');
  assert.equal(ok.receivedBytes, 5);
  assert.equal(ok.declaredLength, 281235);

  const fail = await probeRoute('direct', `https://x/content/${PIN}`, async () => {
    throw new Error('tls handshake failed (curl 35)');
  });
  assert.equal(fail.ok, false);
  assert.equal(fail.error, 'tls handshake failed (curl 35)');
});

test('probeRoute: a 307 exposes the redirect target without following', async () => {
  const result = await probeRoute('accelerate', `https://x/accelerate/${PIN}`, async () => fakeResponse({
    status: 307,
    headers: { location: 'https://oss.example/bucket/file.png' },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 307);
  assert.equal(result.redirectedTo, 'https://oss.example/bucket/file.png');
});

test('verdictFromProbes: the GT#90 signature is named explicitly', () => {
  const okProbe = { ok: true, route: 'direct', url: 'u', httpStatus: 200, redirectedTo: null, contentType: 'image/png', declaredLength: 1, receivedBytes: 5, magic: 'png', elapsedMs: 1, error: null };
  const failProbe = { ok: false, route: 'accelerate', url: 'u', httpStatus: 500, redirectedTo: null, contentType: null, declaredLength: null, receivedBytes: 0, magic: null, elapsedMs: 1, error: 'boom' };
  assert.match(verdictFromProbes(failProbe, okProbe), /RENDER-PATH DEGRADED \(the GT#90 signature\)/);
  assert.match(verdictFromProbes(okProbe, okProbe), /HEALTHY/);
  assert.match(verdictFromProbes(failProbe, failProbe), /UNREACHABLE on both/);
  assert.match(verdictFromProbes(okProbe, failProbe), /PARTIAL/);
});

test('buildMetafileRouteAgentTools: the tool renders a two-route verdict report', async () => {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url) => {
    calls.push(url);
    n += 1;
    return n === 1
      ? fakeResponse({ status: 307, headers: { location: 'https://oss/b.png' } })   // accelerate: broken redirect
      : fakeResponse({ headers: { 'content-type': 'image/png' } });                 // direct: healthy
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
  assert.match(text, /metafile route check for/);
  assert.match(text, /- accelerate /);
  assert.match(text, /- direct /);
  assert.match(text, /VERDICT: RENDER-PATH DEGRADED/);
  assert.equal(calls.length, 2, 'both routes probed in one call');

  const bad = await tools[0].handler({ uri: 'https://example.com/pic.png' });
  assert.equal(bad.isError, true, 'non-metafile input is rejected with guidance');
});
