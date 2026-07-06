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
  assert.match(source, /metaid:\/\//);
  assert.match(source, /\.eth/);
  assert.match(source, /scripts\/index\.js/);
  assert.match(source, /IDBots_RPC_URL|IDBOTS_RPC_URL/);
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
});

test('browser-open script rejects missing or unsupported targets instead of guessing', () => {
  assert.ok(existsSync(scriptPath), 'SKILLs/metabot-browser-open/scripts/index.js should exist');
  const { normalizeBrowserOpenTarget } = require(scriptFilePath);

  assert.equal(normalizeBrowserOpenTarget('打开一下').success, false);
  assert.equal(normalizeBrowserOpenTarget('https://example.com').success, false);
});
