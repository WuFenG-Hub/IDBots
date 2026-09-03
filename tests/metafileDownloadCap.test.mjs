// release-review P2: downloadMetafileBytes maxBytes cap — the deliverable
// content-hash backfill used to buffer the whole metafile before measuring it
// against the 25 MB cap. The cap must abort BEFORE reading (Content-Length
// pre-check) and DURING reading (streamed cancel for lying/absent lengths).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { downloadMetafileBytes } = require('../dist-electron/main/libs/metafileDownload.js');

test('maxBytes: an over-cap Content-Length aborts before any body byte is read', async () => {
  let cancelled = false;
  let arrayBufferCalled = false;
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (name) => (name.toLowerCase() === 'content-length' ? '999999999' : null) },
    body: { cancel: async () => { cancelled = true; } },
    arrayBuffer: async () => {
      arrayBufferCalled = true;
      return new ArrayBuffer(8);
    },
  });
  await assert.rejects(
    downloadMetafileBytes('https://example.com/huge.bin', { fetchImpl, maxBytes: 25 * 1024 * 1024 }),
    /content-length 999999999 exceeds/,
  );
  assert.ok(cancelled, 'the body stream is cancelled');
  assert.equal(arrayBufferCalled, false, 'no body byte is buffered');
});

test('maxBytes: a body that exceeds the cap despite no Content-Length is cancelled mid-stream', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('a'.repeat(10)));
      controller.enqueue(encoder.encode('b'.repeat(10)));
      controller.enqueue(encoder.encode('c'.repeat(10)));
    },
  });
  const response = new Response(stream, { headers: { 'content-type': 'text/plain' } });
  const fetchImpl = async () => response;
  await assert.rejects(
    downloadMetafileBytes('https://example.com/lying.bin', { fetchImpl, maxBytes: 15 }),
    /exceeded the 15-byte cap/,
  );
});

test('maxBytes: an under-cap body downloads unchanged (and no cap keeps legacy behavior)', async () => {
  const ok = new Response('hello world', { headers: { 'content-type': 'text/plain' } });
  const capped = await downloadMetafileBytes('https://example.com/small.txt', {
    fetchImpl: async () => ok,
    maxBytes: 1024,
  });
  assert.equal(capped.buffer.toString(), 'hello world');
  assert.equal(capped.contentType, 'text/plain');

  const uncapped = new Response('still fine', { headers: { 'content-type': 'text/plain' } });
  const legacy = await downloadMetafileBytes('https://example.com/nocap.txt', {
    fetchImpl: async () => uncapped,
  });
  assert.equal(legacy.buffer.toString(), 'still fine');
});
