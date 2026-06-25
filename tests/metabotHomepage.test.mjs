import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const {
  serializeMetabotHomepagePayload,
  buildMetafileHomepage,
  buildMetaappHomepage,
  parseHomepage,
  homepageEquals,
} = require('../dist-electron/main/services/metabotHomepage.js');

test('serializeMetabotHomepagePayload produces compact JSON', () => {
  const hp = buildMetafileHomepage({ pinId: 'abc123', contentType: 'text/html' });
  const out = serializeMetabotHomepagePayload(hp);
  assert.deepEqual(JSON.parse(out), { uri: 'metafile://abc123', renderer: 'auto', contentType: 'text/html' });
});

test('buildMetaappHomepage strips metaapp:// prefix and sets vnd.metaapp', () => {
  const hp = buildMetaappHomepage('metaapp://xyz789');
  assert.equal(hp.uri, 'metaapp://xyz789');
  assert.equal(hp.renderer, 'metaapp');
  assert.equal(hp.contentType, 'application/vnd.metaapp');
});

test('buildMetaappHomepage throws on whitespace or embedded ://', () => {
  assert.throws(() => buildMetaappHomepage('a b'), /without spaces/i);
  assert.throws(() => buildMetaappHomepage('http://x'), /without spaces|pin/i);
});

test('parseHomepage returns null for null/empty and object for valid JSON', () => {
  assert.equal(parseHomepage(null), null);
  assert.equal(parseHomepage(''), null);
  assert.equal(parseHomepage('not json'), null);
  const parsed = parseHomepage('{"uri":"metaapp://a","renderer":"metaapp","contentType":"application/vnd.metaapp"}');
  assert.deepEqual(parsed, { uri: 'metaapp://a', renderer: 'metaapp', contentType: 'application/vnd.metaapp' });
});

test('parseHomepage rejects invalid uri scheme', () => {
  assert.equal(parseHomepage('{"uri":"http://x","renderer":"auto","contentType":"text/html"}'), null);
});

test('homepageEquals treats null===null and detects field changes', () => {
  assert.equal(homepageEquals(null, null), true);
  const a = buildMetaappHomepage('p1');
  assert.equal(homepageEquals(a, buildMetaappHomepage('p1')), true);
  assert.equal(homepageEquals(a, buildMetaappHomepage('p2')), false);
  assert.equal(homepageEquals(a, null), false);
});

test('serialize empty for default (null)', () => {
  assert.equal(serializeMetabotHomepagePayload(null), '');
});
