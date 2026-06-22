import assert from 'node:assert/strict';
import test from 'node:test';

import {
  metabotToBrowserActor,
  metabotsToBrowserActors,
  selectDefaultBrowserActor,
} from '../src/renderer/features/botBrowser/idbotsBrowserActorModel.js';

function createMetabot(overrides = {}) {
  return {
    id: 1,
    name: ' Alpha ',
    avatar: ' https://cdn.example/avatar.png ',
    globalmetaid: ' IDQ1ABC ',
    created_at: 10,
    ...overrides,
  };
}

test('metabotToBrowserActor converts a local IDBots bot to an ABC actor model', () => {
  const actor = metabotToBrowserActor(createMetabot(), 1);

  assert.deepEqual(actor, {
    id: 'idbots-metabot-1',
    label: 'Alpha',
    kind: 'idbots-agent',
    globalMetaId: 'idq1abc',
    avatar: 'https://cdn.example/avatar.png',
    isDefault: true,
    capabilities: ['private-chat', 'message-view', 'profile-management', 'chat-configuration'],
    localMetabotId: 1,
  });
});

test('metabotToBrowserActor uses Bot wording for unnamed actor fallback labels', () => {
  const actor = metabotToBrowserActor(createMetabot({ id: 9, name: '   ' }));

  assert.equal(actor.label, 'Bot 9');
  assert.doesNotMatch(actor.label, /MetaBot/i);
});

test('metabotsToBrowserActors drops actors without usable globalmetaid', () => {
  const actors = metabotsToBrowserActors([
    createMetabot({ id: 1, created_at: 10, globalmetaid: 'idq111' }),
    createMetabot({ id: 2, created_at: 20, globalmetaid: '   ' }),
    createMetabot({ id: 3, created_at: 30, globalmetaid: null }),
    createMetabot({ id: 4, created_at: 40, globalmetaid: 'abc' }),
    createMetabot({ id: 5, created_at: 50, globalmetaid: 'metaid://idq1abc' }),
  ]);

  assert.deepEqual(
    actors.map((actor) => actor.id),
    ['idbots-metabot-1'],
  );
});

test('selectDefaultBrowserActor follows the browser metabot sort rule', () => {
  const actor = selectDefaultBrowserActor([
    createMetabot({ id: 8, created_at: 30, globalmetaid: 'idq888' }),
    createMetabot({ id: 3, created_at: 10, globalmetaid: '   ' }),
    createMetabot({ id: 4, created_at: 20, globalmetaid: 'abc' }),
    createMetabot({ id: 2, created_at: 20, globalmetaid: 'IDQ1DEF' }),
  ]);

  assert.deepEqual(actor, {
    id: 'idbots-metabot-2',
    label: 'Alpha',
    kind: 'idbots-agent',
    globalMetaId: 'idq1def',
    avatar: 'https://cdn.example/avatar.png',
    isDefault: true,
    capabilities: ['private-chat', 'message-view', 'profile-management', 'chat-configuration'],
    localMetabotId: 2,
  });
});
