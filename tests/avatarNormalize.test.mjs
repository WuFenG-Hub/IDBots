import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const {
  AVATAR_MAX_BYTES,
  describeAvatarFailure,
  isAvatarNormalizeFailure,
  isValidAvatarDataUrl,
  normalizeAvatarToDataUrl,
  sniffImageMimeFromBytes,
} = await import('../dist-electron/main/utils/avatarNormalize.js');

// The canonical validator the sync path uses; the normalizer must keep an
// already-valid data URL compatible with it.
const { parseDataUrlAvatar } = await import('../dist-electron/main/services/metaidCore.js');

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_PNG_PATH = path.join(projectRoot, 'build', 'icons', 'png', '16x16.png');
const REAL_PNG = fs.readFileSync(REAL_PNG_PATH);
const REAL_PNG_DATA_URL = `data:image/png;base64,${REAL_PNG.toString('base64')}`;

/** Start a throwaway local http server; always torn down, incl. open sockets. */
async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

// ---------------------------------------------------------------------------
// data: URLs — pass through / reject
// ---------------------------------------------------------------------------

test('data URL: a valid supported image data URL is returned unchanged', async () => {
  const result = await normalizeAvatarToDataUrl(REAL_PNG_DATA_URL);
  assert.equal(isAvatarNormalizeFailure(result), false);
  assert.equal(result.source, 'data-url');
  assert.equal(result.dataUrl, REAL_PNG_DATA_URL);
  assert.equal(result.mime, 'image/png');
  assert.equal(result.bytes, REAL_PNG.length);
});

test('data URL: trims surrounding whitespace before passing through', async () => {
  const result = await normalizeAvatarToDataUrl(`  ${REAL_PNG_DATA_URL}\n`);
  assert.equal(isAvatarNormalizeFailure(result), false);
  assert.equal(result.dataUrl, REAL_PNG_DATA_URL);
});

test('data URL: unsupported MIME is rejected as invalid-data-url', async () => {
  const result = await normalizeAvatarToDataUrl('data:text/plain;base64,aGVsbG8=');
  assert.equal(isAvatarNormalizeFailure(result), true);
  assert.equal(result.reason, 'invalid-data-url');
});

test('data URL: malformed base64 is rejected as invalid-data-url', async () => {
  const result = await normalizeAvatarToDataUrl('data:image/png;base64,not valid base64');
  assert.equal(isAvatarNormalizeFailure(result), true);
  assert.equal(result.reason, 'invalid-data-url');
});

test('empty / unknown source is rejected with a structured reason (never throws)', async () => {
  for (const value of ['', '   ', null, undefined, 'relative/path.png', 'metafile://abc']) {
    const result = await normalizeAvatarToDataUrl(value);
    assert.equal(isAvatarNormalizeFailure(result), true, `expected failure for ${JSON.stringify(value)}`);
    assert.ok(['empty', 'unsupported-scheme'].includes(result.reason));
  }
});

// ---------------------------------------------------------------------------
// http(s) — success + every failure mode
// ---------------------------------------------------------------------------

test('http(s): downloads a real PNG and returns the canonical data URL', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(REAL_PNG);
    },
    async (base) => {
      const result = await normalizeAvatarToDataUrl(`${base}/avatar.png`);
      assert.equal(isAvatarNormalizeFailure(result), false);
      assert.equal(result.source, 'http-url');
      assert.equal(result.mime, 'image/png');
      assert.equal(result.bytes, REAL_PNG.length);
      assert.equal(result.dataUrl, REAL_PNG_DATA_URL);
      // Must satisfy the pre-existing validator the sync path applies.
      assert.notEqual(parseDataUrlAvatar(result.dataUrl), null);
    },
  );
});

test('http(s): a lying Content-Type is ignored — magic bytes decide', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(REAL_PNG);
    },
    async (base) => {
      const result = await normalizeAvatarToDataUrl(`${base}/avatar`);
      assert.equal(isAvatarNormalizeFailure(result), false);
      assert.equal(result.mime, 'image/png');
      assert.equal(result.dataUrl, REAL_PNG_DATA_URL);
    },
  );
});

test('http(s): a non-image response degrades to non-image', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>not an image</body></html>');
    },
    async (base) => {
      const result = await normalizeAvatarToDataUrl(`${base}/page.html`);
      assert.equal(isAvatarNormalizeFailure(result), true);
      assert.equal(result.reason, 'non-image');
      assert.match(result.detail, /not a PNG\/JPEG\/WebP\/GIF image/);
    },
  );
});

test('http(s): a 404 degrades to fetch-failed', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('missing');
    },
    async (base) => {
      const result = await normalizeAvatarToDataUrl(`${base}/missing.png`);
      assert.equal(isAvatarNormalizeFailure(result), true);
      assert.equal(result.reason, 'fetch-failed');
      assert.match(result.detail, /HTTP 404/);
    },
  );
});

test('http(s): an oversized body degrades to too-large', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(REAL_PNG);
    },
    async (base) => {
      const result = await normalizeAvatarToDataUrl(`${base}/big.png`, { maxBytes: 100 });
      assert.equal(isAvatarNormalizeFailure(result), true);
      assert.equal(result.reason, 'too-large');
    },
  );
});

test('http(s): an over-cap Content-Length is rejected before the body is read', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(AVATAR_MAX_BYTES + 1) });
      res.end(REAL_PNG);
    },
    async (base) => {
      const result = await normalizeAvatarToDataUrl(`${base}/huge.png`);
      assert.equal(isAvatarNormalizeFailure(result), true);
      assert.equal(result.reason, 'too-large');
    },
  );
});

test('http(s): an empty body degrades to empty-body', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end();
    },
    async (base) => {
      const result = await normalizeAvatarToDataUrl(`${base}/empty.png`);
      assert.equal(isAvatarNormalizeFailure(result), true);
      assert.equal(result.reason, 'empty-body');
    },
  );
});

test('http(s): an unresponsive server degrades to fetch-timeout', async () => {
  await withServer(
    (req, res) => {
      // Never respond; the client-side timeout must fire.
      setTimeout(() => res.end(REAL_PNG), 10_000);
    },
    async (base) => {
      const result = await normalizeAvatarToDataUrl(`${base}/slow.png`, { timeoutMs: 100 });
      assert.equal(isAvatarNormalizeFailure(result), true);
      assert.equal(result.reason, 'fetch-timeout');
      assert.match(result.detail, /Timed out after 100ms/);
    },
  );
});

test('http(s): an unreachable URL degrades to fetch-failed (no throw)', async () => {
  // Bind a port then close it so the connect is refused deterministically.
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));

  const result = await normalizeAvatarToDataUrl(`http://127.0.0.1:${port}/avatar.png`, { timeoutMs: 1000 });
  assert.equal(isAvatarNormalizeFailure(result), true);
  assert.equal(result.reason, 'fetch-failed');
});

// ---------------------------------------------------------------------------
// local files
// ---------------------------------------------------------------------------

test('local file: an absolute path to a real image is read and converted', async () => {
  const result = await normalizeAvatarToDataUrl(REAL_PNG_PATH);
  assert.equal(isAvatarNormalizeFailure(result), false);
  assert.equal(result.source, 'local-file');
  assert.equal(result.mime, 'image/png');
  assert.equal(result.bytes, REAL_PNG.length);
  assert.equal(result.dataUrl, REAL_PNG_DATA_URL);
  assert.notEqual(parseDataUrlAvatar(result.dataUrl), null);
});

test('local file: a relative path is refused (unsupported-scheme)', async () => {
  const result = await normalizeAvatarToDataUrl('build/icons/png/16x16.png');
  assert.equal(isAvatarNormalizeFailure(result), true);
  assert.equal(result.reason, 'unsupported-scheme');
});

test('local file: a missing absolute path degrades to read-failed', async () => {
  const result = await normalizeAvatarToDataUrl(path.join(projectRoot, 'does-not-exist-avatar.png'));
  assert.equal(isAvatarNormalizeFailure(result), true);
  assert.equal(result.reason, 'read-failed');
});

test('local file: a non-image absolute path degrades to non-image', async () => {
  const result = await normalizeAvatarToDataUrl(path.join(projectRoot, 'package.json'));
  assert.equal(isAvatarNormalizeFailure(result), true);
  assert.equal(result.reason, 'non-image');
});

test('local file: an over-cap file degrades to too-large', async () => {
  const result = await normalizeAvatarToDataUrl(REAL_PNG_PATH, { maxBytes: 100 });
  assert.equal(isAvatarNormalizeFailure(result), true);
  assert.equal(result.reason, 'too-large');
});

// ---------------------------------------------------------------------------
// magic-byte sniffer
// ---------------------------------------------------------------------------

test('sniffImageMimeFromBytes identifies the four supported formats and rejects others', () => {
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
  const webp = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x10, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'ascii'),
    Buffer.from('VP8 ', 'ascii'),
  ]);
  assert.equal(sniffImageMimeFromBytes(REAL_PNG), 'image/png');
  assert.equal(sniffImageMimeFromBytes(jpeg), 'image/jpeg');
  assert.equal(sniffImageMimeFromBytes(gif), 'image/gif');
  assert.equal(sniffImageMimeFromBytes(webp), 'image/webp');
  assert.equal(sniffImageMimeFromBytes(Buffer.from('RIFFxxxxNOPE', 'ascii')), null);
  assert.equal(sniffImageMimeFromBytes(Buffer.from('<!doctype html>', 'ascii')), null);
  assert.equal(sniffImageMimeFromBytes(Buffer.alloc(0)), null);
});

// ---------------------------------------------------------------------------
// cross-check: the local validator must agree with the canonical one
// ---------------------------------------------------------------------------

test('isValidAvatarDataUrl agrees with parseDataUrlAvatar on a corpus', () => {
  const canonicalJpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]).toString('base64')}`;
  const corpus = [
    REAL_PNG_DATA_URL,
    canonicalJpeg,
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'data:text/plain;base64,aGVsbG8=',
    'data:image/png;base64,not valid base64',
    'data:image/png;base64,',
    'data:image/png;base64,iVBOR',
    'data:image/svg+xml;base64,PHN2Zy8+',
    'data:image/png;base64,AAAA===',
    'not-a-data-url',
    '',
  ];
  for (const value of corpus) {
    assert.equal(
      isValidAvatarDataUrl(value),
      parseDataUrlAvatar(value) !== null,
      `validator mismatch for ${JSON.stringify(value)}`,
    );
  }
});

test('describeAvatarFailure renders both outcomes without throwing', async () => {
  const ok = await normalizeAvatarToDataUrl(REAL_PNG_DATA_URL);
  assert.match(describeAvatarFailure(ok), /normalized to a image\/png data URL/);
  const bad = await normalizeAvatarToDataUrl('data:text/plain;base64,aGVsbG8=');
  assert.match(describeAvatarFailure(bad), /invalid-data-url/);
});
