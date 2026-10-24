import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBrowserRuntimeActors,
  humanIdentityToBrowserActor,
  isUsableHumanIdentity,
  metabotToBrowserActor,
  metabotsToBrowserActors,
  selectDefaultBrowserActor,
  selectDefaultBrowserRuntimeActor,
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
    capabilities: ['private-chat'],
    localMetabotId: 1,
  });
});

test('metabotToBrowserActor uses Bot wording for unnamed actor fallback labels', () => {
  const actor = metabotToBrowserActor(createMetabot({ id: 9, name: '   ' }));

  assert.equal(actor.label, 'Bot 9');
  assert.doesNotMatch(actor.label, /MetaBot/i);
});

test('metabotToBrowserActor only exposes capabilities backed by trusted actions', () => {
  const actor = metabotToBrowserActor(createMetabot());

  assert.deepEqual(actor.capabilities, ['private-chat']);
  assert.equal(actor.capabilities.includes('message-view'), false);
  assert.equal(actor.capabilities.includes('profile-management'), false);
  assert.equal(actor.capabilities.includes('chat-configuration'), false);
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
    capabilities: ['private-chat'],
    localMetabotId: 2,
  });
});

// ---------------------------------------------------------------------------
// Human account Actor (motion-video preference loop, idbots-account kind)
// ---------------------------------------------------------------------------

const HUMAN = {
  label: ' Sunny ',
  globalMetaId: ' IDQ1HUMAN ',
  avatar: ' data:image/png;base64,zz ',
  signingAvailable: true,
};

test('humanIdentityToBrowserActor maps the sanitized identity to an idbots-account actor', () => {
  const actor = humanIdentityToBrowserActor(HUMAN);
  assert.deepEqual(actor, {
    id: 'idbots-account-1',
    label: 'Sunny · Account',
    kind: 'idbots-account',
    globalMetaId: 'idq1human',
    avatar: 'data:image/png;base64,zz',
    isDefault: false,
    capabilities: [],
  });
});

test('humanIdentityToBrowserActor never carries secret or wallet material', () => {
  const actor = humanIdentityToBrowserActor({
    ...HUMAN,
    mnemonic: 'word word word',
    mvc_address: 'mvc-addr',
    public_key: 'pk',
    path: "m/44'/10001'/0'/0/0",
    rawRow: { any: 'thing' },
  });
  const serialized = JSON.stringify(actor);
  for (const secret of ['mnemonic', 'mvc_address', 'public_key', 'path', 'rawRow', 'word word']) {
    assert.ok(!serialized.includes(secret), `actor must not carry ${secret}`);
  }
});

test('humanIdentityToBrowserActor drops identities without a usable globalmetaid', () => {
  assert.equal(humanIdentityToBrowserActor(null), null);
  assert.equal(humanIdentityToBrowserActor({ label: 'x', globalMetaId: 'metaid://idq1x' }), null);
  assert.equal(humanIdentityToBrowserActor({ label: 'x', globalMetaId: 'abc' }), null);
});

test('buildBrowserRuntimeActors lists the human first and dedups bots sharing its globalmetaid', () => {
  const actors = buildBrowserRuntimeActors(
    [
      createMetabot({ id: 1, created_at: 10, globalmetaid: 'idq111' }),
      createMetabot({ id: 2, created_at: 20, globalmetaid: 'IDQ1HUMAN' }),
    ],
    HUMAN,
  );
  assert.deepEqual(
    actors.map((actor) => actor.id),
    ['idbots-account-1', 'idbots-metabot-1'],
  );
  assert.equal(actors[0].kind, 'idbots-account');
  assert.equal(actors[1].kind, 'idbots-agent');
});

test('selectDefaultBrowserRuntimeActor preserves the Bot default when Bots exist', () => {
  const actor = selectDefaultBrowserRuntimeActor(
    [createMetabot({ id: 1, created_at: 10, globalmetaid: 'idq111' })],
    HUMAN,
  );
  assert.equal(actor.id, 'idbots-metabot-1');
  assert.equal(actor.kind, 'idbots-agent');
});

test('selectDefaultBrowserRuntimeActor falls back to a usable human identity with no Bots', () => {
  const actor = selectDefaultBrowserRuntimeActor([], HUMAN);
  assert.equal(actor.id, 'idbots-account-1');
  assert.equal(actor.kind, 'idbots-account');
});

test('a visible-but-locked human identity is never the default', () => {
  const actor = selectDefaultBrowserRuntimeActor([], { ...HUMAN, signingAvailable: false });
  assert.equal(actor, null);
});

test('isUsableHumanIdentity requires the signing flag', () => {
  assert.equal(isUsableHumanIdentity(HUMAN), true);
  assert.equal(isUsableHumanIdentity({ ...HUMAN, signingAvailable: false }), false);
  assert.equal(isUsableHumanIdentity(null), false);
});
