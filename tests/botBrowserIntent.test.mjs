import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBotPageBrowserUri,
  buildLocalMetabotActorId,
  buildMetaAppBrowserUri,
  normalizeBrowserGlobalMetaId,
  parseLocalMetabotActorId,
  selectDefaultBrowserMetabot,
  sortMetabotsForBrowser,
} from '../src/renderer/features/botBrowser/botBrowserIntent.js';

test('normalizeBrowserGlobalMetaId trims string values and rejects non-strings', () => {
  assert.equal(normalizeBrowserGlobalMetaId('  idq123  '), 'idq123');
  assert.equal(normalizeBrowserGlobalMetaId('  IDQ1ABC  '), 'idq1abc');
  assert.equal(normalizeBrowserGlobalMetaId('metaid://idq1abc'), '');
  assert.equal(normalizeBrowserGlobalMetaId('abc'), '');
  assert.equal(normalizeBrowserGlobalMetaId(''), '');
  assert.equal(normalizeBrowserGlobalMetaId(null), '');
  assert.equal(normalizeBrowserGlobalMetaId(7), '');
});

test('buildBotPageBrowserUri builds metaid uri and returns empty for unusable values', () => {
  assert.equal(buildBotPageBrowserUri('idq123'), 'metaid://idq123');
  assert.equal(buildBotPageBrowserUri(' IDQ1ABC '), 'metaid://idq1abc');
  assert.equal(buildBotPageBrowserUri('metaid://idq1abc'), '');
  assert.equal(buildBotPageBrowserUri('   '), '');
  assert.equal(buildBotPageBrowserUri(null), '');
});

test('buildMetaAppBrowserUri builds metaapp uri', () => {
  assert.equal(buildMetaAppBrowserUri('abc123i0'), 'metaapp://abc123i0');
  assert.equal(buildMetaAppBrowserUri(' ABC123I0 '), 'metaapp://abc123i0');
  assert.equal(buildMetaAppBrowserUri('   '), '');
});

test('buildLocalMetabotActorId and parseLocalMetabotActorId round-trip valid ids', () => {
  assert.equal(buildLocalMetabotActorId(7), 'idbots-metabot-7');
  assert.equal(buildLocalMetabotActorId('12'), 'idbots-metabot-12');
  assert.equal(buildLocalMetabotActorId(0), '');
  assert.equal(buildLocalMetabotActorId('12abc'), '');
  assert.equal(buildLocalMetabotActorId('7.9'), '');
  assert.equal(parseLocalMetabotActorId('idbots-metabot-7'), 7);
  assert.equal(parseLocalMetabotActorId('  idbots-metabot-12  '), 12);
  assert.equal(parseLocalMetabotActorId('idbots-metabot-0'), null);
  assert.equal(parseLocalMetabotActorId('not-an-actor'), null);
});

test('sortMetabotsForBrowser sorts by created_at then id', () => {
  const sorted = sortMetabotsForBrowser([
    { id: 5, created_at: 20 },
    { id: 2, created_at: 10 },
    { id: 1, created_at: 10 },
    { id: 4, created_at: 30 },
  ]);

  assert.deepEqual(
    sorted.map((metabot) => metabot.id),
    [1, 2, 5, 4],
  );
});

test('selectDefaultBrowserMetabot skips entries without usable globalmetaid', () => {
  const selected = selectDefaultBrowserMetabot([
    { id: 1, created_at: 10, globalmetaid: '   ' },
    { id: 3, created_at: 15, globalmetaid: 'abc' },
    { id: 2, created_at: 12, globalmetaid: null },
    { id: 4, created_at: 9, globalmetaid: 7 },
    { id: 5, created_at: 16, globalmetaid: 'metaid://idq1abc' },
    { id: 6, created_at: 17, globalmetaid: 'IDQ1ABC' },
  ]);

  assert.deepEqual(selected, { id: 6, created_at: 17, globalmetaid: 'IDQ1ABC' });
});
