import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import AdmZip from 'adm-zip';

import { createBotBrowserMetaAppCacheService } from '../src/main/services/botBrowserMetaAppCacheService.ts';

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
