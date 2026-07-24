import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const skillDir = new URL('../SKILLs/metabot-browser-open/', import.meta.url);
const skillPath = new URL('SKILL.md', skillDir);
const scriptPath = new URL('scripts/index.js', skillDir);
const scriptFilePath = fileURLToPath(scriptPath);

const PIN_ID = '6d30862cc1c974b2c5ffd26a54a8ba75ff49ce8ddbe1b25d18cad5916aea3069i0';

test('metabot-browser-open skill is installed with Browser routing guidance', () => {
  assert.ok(existsSync(skillPath), 'SKILLs/metabot-browser-open/SKILL.md should exist');
  const source = readFileSync(skillPath, 'utf8');

  assert.match(source, /^name:\s*metabot-browser-open/m);
  assert.match(source, /metaapp:\/\//);
  assert.match(source, /pin:\/\//);
  assert.match(source, /map:\/\//);
  assert.match(source, /metafile:\/\//);
  assert.match(source, /metaid:\/\//);
  assert.match(source, /\.eth/);
  assert.match(source, /scripts\/index\.js/);
  assert.match(source, /IDBots_RPC_URL|IDBOTS_RPC_URL/);
  assert.match(source, /get-active-tab/);
  assert.match(source, /open-tab/);
  assert.match(source, /switch-tab/);
  assert.match(source, /close-tab/);
});

test('browser-open script normalizes supported user requests into Browser URIs', () => {
  assert.ok(existsSync(scriptPath), 'SKILLs/metabot-browser-open/scripts/index.js should exist');
  const { normalizeBrowserOpenTarget } = require(scriptFilePath);

  assert.equal(
    normalizeBrowserOpenTarget(`打开 metaapp://${PIN_ID}`).uri,
    `metaapp://${PIN_ID}`,
  );
  assert.equal(
    normalizeBrowserOpenTarget(`显示${PIN_ID}`).uri,
    `pin://${PIN_ID}`,
  );
  assert.equal(
    normalizeBrowserOpenTarget(`打开应用 ${PIN_ID}`).uri,
    `metaapp://${PIN_ID}`,
  );
  assert.equal(
    normalizeBrowserOpenTarget('跳转到 sunnyfung.eth').uri,
    'metaid://sunnyfung.eth',
  );
  assert.equal(
    normalizeBrowserOpenTarget('打开 idq14hmv23j5fnlx4ccnmvlyldjd38xjsechzwg9xz 的主页').uri,
    'metaid://idq14hmv23j5fnlx4ccnmvlyldjd38xjsechzwg9xz',
  );
  assert.equal(
    normalizeBrowserOpenTarget('map://simplebuzz/pin/abc123i0').uri,
    'map://simplebuzz/pin/abc123i0',
  );
  assert.equal(
    normalizeBrowserOpenTarget(`metafile://${PIN_ID}`).uri,
    `metafile://${PIN_ID}`,
  );
});

test('browser-open script rejects missing or unsupported targets instead of guessing', () => {
  assert.ok(existsSync(scriptPath), 'SKILLs/metabot-browser-open/scripts/index.js should exist');
  const { normalizeBrowserOpenTarget } = require(scriptFilePath);

  assert.equal(normalizeBrowserOpenTarget('打开一下').success, false);
  assert.equal(normalizeBrowserOpenTarget('https://example.com').success, false);
});

test('browser-open script maps explicit and natural-language tab requests', () => {
  const { normalizeBrowserCommand } = require(scriptFilePath);

  assert.deepEqual(
    normalizeBrowserCommand({
      payload: { uri: `metaapp://${PIN_ID}` },
      action: 'open-tab',
    }),
    { success: true, action: 'open-tab', uri: `metaapp://${PIN_ID}` },
  );
  assert.equal(
    normalizeBrowserCommand({ payload: `新 tab 打开 metafile://${PIN_ID}` }).action,
    'open-tab',
  );
  assert.deepEqual(
    normalizeBrowserCommand({ payload: '当前 tab 的 URI 是什么' }),
    { success: true, action: 'get-active-tab' },
  );
  assert.deepEqual(
    normalizeBrowserCommand({ payload: { action: 'switch-tab', tabId: 7 } }),
    { success: true, action: 'switch-tab', tabId: 7 },
  );
});

test('browser-open script sends tab actions to the local tab bridge route', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          success: true,
          result: {
            action: 'get-active-tab',
            tabs: [{ id: 1, uri: 'metaid://idq1alice', title: 'Alice', isActive: true }],
            activeTab: { id: 1, uri: 'metaid://idq1alice', title: 'Alice', isActive: true },
          },
        };
      },
    };
  };

  try {
    const { openBotBrowser } = require(scriptFilePath);
    const result = await openBotBrowser({
      payload: { action: 'get-active-tab' },
      actorId: '',
      dryRun: false,
    }, { IDBOTS_RPC_URL: 'http://127.0.0.1:39999' });

    assert.equal(requests[0].url, 'http://127.0.0.1:39999/api/idbots/bot-browser/tabs');
    assert.deepEqual(requests[0].body, {
      action: 'get-active-tab',
    });
    assert.equal(result.activeTab.uri, 'metaid://idq1alice');
  } finally {
    global.fetch = originalFetch;
  }
});
