import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import AdmZip from 'adm-zip';

import { createBotBrowserMetaAppCacheService } from '../src/main/services/botBrowserMetaAppCacheService.ts';
import {
  assertMetaAppZipDownloadIntegrity,
  assertZipArchiveIntegrity,
} from '../src/main/libs/metaAppZipDownload.ts';

function createMetaAppZip() {
  const zip = new AdmZip();
  zip.addFile('index.html', Buffer.from('<!doctype html><html><body>MetaAPP OK</body></html>', 'utf8'));
  zip.addFile('assets/app.js', Buffer.from('window.__metaAppLoaded = true;', 'utf8'));
  return zip.toBuffer();
}

test('Bot Browser MetaApp cache resolver downloads, caches, and serves a MetaAPP preview', async () => {
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'idbots-bot-browser-cache-'));
  const metaAppPinId = 'c06b7a2db6efa241560a2356e9966cf9758dae3ec9c795f614a652b113e30329i0';
  const codePinId = '7086cf5272192d32e888a7675ceaada6a86cbcf5cf936355c36c2f0fed538352i0';
  const zipBuffer = createMetaAppZip();
  const requestedUrls = [];
  const service = createBotBrowserMetaAppCacheService({
    cacheRoot,
    fetch: async (url) => {
      requestedUrls.push(String(url));
      if (String(url).endsWith(`/pin/${metaAppPinId}`)) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            pin: {
              path: '/protocols/metaapp',
              ownerGlobalMetaId: 'idq1publisher',
              timestamp: 1_700_000_000,
              contentSummary: JSON.stringify({
                title: 'Eric Homepage',
                appName: 'eric-homepage',
                runtime: 'browser',
                version: '1.0.0',
                indexFile: 'index.html',
                contentType: 'application/zip',
                codeType: 'application/zip',
                content: `metafile://${codePinId}.zip`,
              }),
            },
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url).includes(codePinId)) {
        return new Response(zipBuffer, {
          status: 200,
          headers: { 'content-type': 'application/zip' },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });

  try {
    const resolved = await service.resolveMetaAppPin(metaAppPinId);

    assert.equal(resolved.ok, true);
    assert.equal(resolved.data.contentType, 'text/html');
    assert.match(resolved.data.runUrl, /^http:\/\/127\.0\.0\.1:\d+\/browser-cache\/metaapp-preview\//);
    assert.equal(resolved.data.localUiUrl, resolved.data.runUrl);

    const preview = await fetch(resolved.data.runUrl);
    assert.equal(preview.status, 200);
    assert.match(await preview.text(), /MetaAPP OK/);

    const stats = await service.getCache();
    assert.equal(stats.ok, true);
    assert.equal(stats.data.cacheRoot, cacheRoot);
    assert.equal(stats.data.artifactCount, 1);
    assert.equal(stats.data.pinRecordCount, 1);
    assert.equal(stats.data.activePreviewSessionCount, 1);
    assert.equal(stats.data.artifacts[0].metaAppPinId, metaAppPinId);
    assert.ok(requestedUrls.some((url) => url.includes(`/pin/${metaAppPinId}`)));
    assert.ok(requestedUrls.some((url) => url.includes(codePinId)));

    const cleared = await service.clearCache({ all: true });
    assert.equal(cleared.ok, true);
    assert.deepEqual(cleared.data, { clearedArtifacts: 1, clearedPinRecords: 1 });

    const emptyStats = await service.getCache();
    assert.equal(emptyStats.ok, true);
    assert.equal(emptyStats.data.artifactCount, 0);
    assert.equal(emptyStats.data.pinRecordCount, 0);
    assert.equal(emptyStats.data.activePreviewSessionCount, 0);
  } finally {
    await service.stop();
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test('Bot Browser MetaApp cache rejects a truncated download and writes nothing to cache', async () => {
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'idbots-bot-browser-cache-'));
  const metaAppPinId = 'c06b7a2db6efa241560a2356e9966cf9758dae3ec9c795f614a652b113e30329i0';
  const codePinId = '7086cf5272192d32e888a7675ceaada6a86cbcf5cf936355c36c2f0fed538352i0';
  const zipBuffer = createMetaAppZip();
  const service = createBotBrowserMetaAppCacheService({
    cacheRoot,
    fetch: async (url) => {
      if (String(url).endsWith(`/pin/${metaAppPinId}`)) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            pin: {
              path: '/protocols/metaapp',
              ownerGlobalMetaId: 'idq1publisher',
              timestamp: 1_700_000_000,
              contentSummary: JSON.stringify({
                title: 'Truncated App',
                appName: 'truncated-app',
                runtime: 'browser',
                version: '1.0.0',
                indexFile: 'index.html',
                contentType: 'application/zip',
                codeType: 'application/zip',
                content: `metafile://${codePinId}.zip`,
              }),
            },
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url).includes(codePinId)) {
        return new Response(zipBuffer.subarray(0, 64), {
          status: 200,
          headers: {
            'content-type': 'application/zip',
            'content-length': String(zipBuffer.length),
          },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });

  try {
    const resolved = await service.resolveMetaAppPin(metaAppPinId);
    assert.equal(resolved.ok, false);
    assert.equal(resolved.code, 'browser_resolve_failed');
    assert.match(resolved.message, /was truncated \(received 64 of \d+ bytes\)/);

    const stats = await service.getCache();
    assert.equal(stats.ok, true);
    assert.equal(stats.data.artifactCount, 0);
    assert.equal(stats.data.pinRecordCount, 0);
    assert.equal(stats.data.activePreviewSessionCount, 0);
  } finally {
    await service.stop();
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test('Bot Browser MetaApp cache follows 307 redirects when the fetch impl does not', async () => {
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'idbots-bot-browser-cache-'));
  const metaAppPinId = 'c06b7a2db6efa241560a2356e9966cf9758dae3ec9c795f614a652b113e30329i0';
  const codePinId = '7086cf5272192d32e888a7675ceaada6a86cbcf5cf936355c36c2f0fed538352i0';
  const zipBuffer = createMetaAppZip();
  const ossUrl = `https://metafs.oss-cn-beijing.aliyuncs.com/indexer/mvc/${codePinId}.zip`;
  const requestedUrls = [];
  const service = createBotBrowserMetaAppCacheService({
    cacheRoot,
    fetch: async (url) => {
      requestedUrls.push(String(url));
      if (String(url).endsWith(`/pin/${metaAppPinId}`)) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            pin: {
              path: '/protocols/metaapp',
              ownerGlobalMetaId: 'idq1publisher',
              timestamp: 1_700_000_000,
              contentSummary: JSON.stringify({
                title: 'Redirect App',
                appName: 'redirect-app',
                runtime: 'browser',
                version: '1.0.0',
                indexFile: 'index.html',
                contentType: 'application/zip',
                codeType: 'application/zip',
                content: `metafile://${codePinId}.zip`,
              }),
            },
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url) === ossUrl) {
        return new Response(zipBuffer, {
          status: 200,
          headers: { 'content-type': 'application/zip' },
        });
      }
      if (String(url).includes(codePinId)) {
        return new Response(null, {
          status: 307,
          headers: { location: ossUrl },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });

  try {
    const resolved = await service.resolveMetaAppPin(metaAppPinId);
    assert.equal(resolved.ok, true);
    assert.match(resolved.data.runUrl, /^http:\/\/127\.0\.0\.1:\d+\/browser-cache\/metaapp-preview\//);
    assert.ok(requestedUrls.includes(ossUrl), 'redirect Location should be followed');

    const stats = await service.getCache();
    assert.equal(stats.ok, true);
    assert.equal(stats.data.artifactCount, 1);
    assert.equal(stats.data.pinRecordCount, 1);
  } finally {
    await service.stop();
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test('Bot Browser MetaApp cache rejects a zip missing its EOCD and writes nothing to cache', async () => {
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'idbots-bot-browser-cache-'));
  const metaAppPinId = 'c06b7a2db6efa241560a2356e9966cf9758dae3ec9c795f614a652b113e30329i0';
  const codePinId = '7086cf5272192d32e888a7675ceaada6a86cbcf5cf936355c36c2f0fed538352i0';
  const zipBuffer = createMetaAppZip();
  const service = createBotBrowserMetaAppCacheService({
    cacheRoot,
    fetch: async (url) => {
      if (String(url).endsWith(`/pin/${metaAppPinId}`)) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            pin: {
              path: '/protocols/metaapp',
              ownerGlobalMetaId: 'idq1publisher',
              timestamp: 1_700_000_000,
              contentSummary: JSON.stringify({
                title: 'No EOCD App',
                appName: 'no-eocd-app',
                runtime: 'browser',
                version: '1.0.0',
                indexFile: 'index.html',
                contentType: 'application/zip',
                codeType: 'application/zip',
                content: `metafile://${codePinId}.zip`,
              }),
            },
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url).includes(codePinId)) {
        return new Response(zipBuffer.subarray(0, zipBuffer.length - 22), {
          status: 200,
          headers: { 'content-type': 'application/zip' },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });

  try {
    const resolved = await service.resolveMetaAppPin(metaAppPinId);
    assert.equal(resolved.ok, false);
    assert.equal(resolved.code, 'browser_resolve_failed');
    assert.match(resolved.message, /missing end-of-central-directory record/);

    const stats = await service.getCache();
    assert.equal(stats.ok, true);
    assert.equal(stats.data.artifactCount, 0);
    assert.equal(stats.data.pinRecordCount, 0);
  } finally {
    await service.stop();
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test('valid MetaApp zip passes integrity with a matching Content-Length', () => {
  const zipBuffer = createMetaAppZip();
  assert.doesNotThrow(() => {
    assertMetaAppZipDownloadIntegrity(zipBuffer, {
      headers: { get: (name) => (name === 'content-length' ? String(zipBuffer.length) : null) },
    });
  });
});

test('valid MetaApp zip passes integrity without Content-Length (magic + EOCD check)', () => {
  const zipBuffer = createMetaAppZip();
  assert.doesNotThrow(() => {
    assertMetaAppZipDownloadIntegrity(zipBuffer, {
      headers: { get: () => null },
    });
  });
});

test('Content-Length mismatch is reported as a truncated download', () => {
  const zipBuffer = createMetaAppZip();
  const truncated = zipBuffer.subarray(0, 64);
  assert.throws(
    () => {
      assertMetaAppZipDownloadIntegrity(truncated, {
        headers: { get: (name) => (name === 'content-length' ? String(zipBuffer.length) : null) },
      });
    },
    /was truncated \(received 64 of \d+ bytes\)/,
  );
});

test('missing EOCD is reported as a truncated download when no Content-Length is declared', () => {
  const zipBuffer = createMetaAppZip();
  const truncated = zipBuffer.subarray(0, zipBuffer.length - 22);
  assert.throws(
    () => {
      assertMetaAppZipDownloadIntegrity(truncated, {
        headers: { get: () => null },
      });
    },
    /missing end-of-central-directory record/,
  );
});

test('non-zip response body is rejected by the PK magic check', () => {
  const html = Buffer.from('<!doctype html><html><body>error</body></html>', 'utf8');
  assert.throws(
    () => {
      assertMetaAppZipDownloadIntegrity(html, {
        headers: { get: (name) => (name === 'content-length' ? String(html.length) : null) },
      });
    },
    /not a valid ZIP archive \(missing PK\\x03\\x04 header\)/,
  );
});

test('fake EOCD bytes inside payload data do not pass the bounds check', () => {
  const zipBuffer = createMetaAppZip();
  const fakeEocd = Buffer.alloc(22);
  fakeEocd.writeUInt32LE(0x06054b50, 0); // PK\x05\x06
  fakeEocd.writeUInt32LE(0xffffffff, 12); // central directory size
  fakeEocd.writeUInt32LE(0xffffffff, 16); // central directory offset
  const forged = Buffer.concat([zipBuffer.subarray(0, zipBuffer.length - 22), fakeEocd]);
  assert.throws(
    () => assertZipArchiveIntegrity(forged),
    /missing end-of-central-directory record/,
  );
});

test('invalid Content-Length header is rejected', () => {
  const zipBuffer = createMetaAppZip();
  assert.throws(
    () => {
      assertMetaAppZipDownloadIntegrity(zipBuffer, {
        headers: { get: () => 'not-a-number' },
      });
    },
    /content-length is invalid/,
  );
});
