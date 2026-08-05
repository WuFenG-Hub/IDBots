import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const {
  parseMetaAppPreviewId,
  parseLocalMetaAppServerAppId,
  readRendererFromEnvelope,
  resolveMetaAppSourceByRenderUrl,
} = require('../dist-electron/main/services/botBrowserSourceLocator.js');

test('parseMetaAppPreviewId extracts the preview id from cache preview URLs', () => {
  assert.equal(
    parseMetaAppPreviewId('http://127.0.0.1:9123/browser-cache/metaapp-preview/local-preview-abc/index.html'),
    'local-preview-abc',
  );
  assert.equal(parseMetaAppPreviewId('http://127.0.0.1:9123/my-app/index.html'), null);
  assert.equal(parseMetaAppPreviewId('https://example.com/app/'), null);
});

test('parseLocalMetaAppServerAppId extracts the first path segment on loopback hosts only', () => {
  assert.equal(parseLocalMetaAppServerAppId('http://127.0.0.1:8899/my-app/dist/index.html'), 'my-app');
  assert.equal(parseLocalMetaAppServerAppId('http://localhost:8899/my-app/'), 'my-app');
  // The cache preview server shares the loopback host; its namespace must not be read as an app id.
  assert.equal(parseLocalMetaAppServerAppId('http://127.0.0.1:8899/browser-cache/metaapp-preview/x/index.html'), null);
  assert.equal(parseLocalMetaAppServerAppId('https://openagentinternet.org/browser/metaapp/abc'), null);
  assert.equal(parseLocalMetaAppServerAppId('http://127.0.0.1:8899/'), null);
});

test('readRendererFromEnvelope defensively reads renderer type and url', () => {
  assert.deepEqual(
    readRendererFromEnvelope({ renderer: { type: 'html-iframe', url: 'http://127.0.0.1/x/' } }),
    { type: 'html-iframe', url: 'http://127.0.0.1/x/' },
  );
  assert.deepEqual(readRendererFromEnvelope({ renderer: { type: 'pdf' } }), { type: 'pdf', url: undefined });
  assert.deepEqual(readRendererFromEnvelope(null), {});
  assert.deepEqual(readRendererFromEnvelope({}), {});
  assert.deepEqual(readRendererFromEnvelope({ renderer: 'nope' }), {});
});

test('resolveMetaAppSourceByRenderUrl prefers preview sessions over the local server namespace', async () => {
  const preview = await resolveMetaAppSourceByRenderUrl({
    renderUrl: 'http://127.0.0.1:9123/browser-cache/metaapp-preview/p-1/index.html',
    listMetaApps: () => [],
    getPreviewSessionArtifactDir: async (id) => (
      id === 'p-1' ? { artifactDir: '/cache/artifacts/p-1', indexFile: 'index.html' } : null
    ),
  });
  assert.deepEqual(preview, { dir: '/cache/artifacts/p-1', indexFile: 'index.html', title: '' });

  const local = await resolveMetaAppSourceByRenderUrl({
    renderUrl: 'http://127.0.0.1:8899/game-app/index.html',
    listMetaApps: () => [{ id: 'game-app', appRoot: '/METAAPPs/game-app', entry: 'index.html', name: 'Game App' }],
    getPreviewSessionArtifactDir: async () => null,
  });
  assert.deepEqual(local, { dir: '/METAAPPs/game-app', indexFile: 'index.html', title: 'Game App' });

  const unknown = await resolveMetaAppSourceByRenderUrl({
    renderUrl: 'https://example.com/remote/index.html',
    listMetaApps: () => [],
    getPreviewSessionArtifactDir: async () => null,
  });
  assert.equal(unknown, null);
});
