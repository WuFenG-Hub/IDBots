import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IDBOTS_ACCOUNT_ACTOR_ID,
  buildBrowserActors,
  metabotToBrowserActor,
  metabotsToBrowserActors,
  selectDefaultBrowserActor,
  userIdentityToBrowserActor,
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

function createUserIdentity(overrides = {}) {
  return {
    globalmetaid: ' IDP1HUMAN ',
    name: ' Sunny ',
    avatar: 'data:image/png;base64,AAAA',
    // Fields that must never surface in a runtime Actor.
    mnemonic: 'never leak me',
    path: "m/44'/10001'/0'/0/0",
    mvc_address: 'mvc-address',
    public_key: 'public-key',
    ...overrides,
  };
}

test('userIdentityToBrowserActor maps the human identity to idbots-account without secrets', () => {
  const actor = userIdentityToBrowserActor(createUserIdentity());

  assert.equal(actor.id, IDBOTS_ACCOUNT_ACTOR_ID);
  assert.equal(actor.kind, 'idbots-account');
  assert.equal(actor.globalMetaId, 'idp1human');
  assert.equal(actor.label, 'Sunny');
  assert.deepEqual(actor.capabilities, []);
  assert.equal(JSON.stringify(actor).includes('never leak me'), false);
  assert.equal(JSON.stringify(actor).includes("m/44'/10001"), false);
  assert.equal(JSON.stringify(actor).includes('mvc-address'), false);
});

test('userIdentityToBrowserActor omits an unregistered human identity', () => {
  assert.equal(userIdentityToBrowserActor(null), null);
  assert.equal(userIdentityToBrowserActor({ globalmetaid: null, name: 'Sunny' }), null);
  assert.equal(userIdentityToBrowserActor({ globalmetaid: 'not-a-metaid', name: 'Sunny' }), null);
});

test('buildBrowserActors lists the human identity first and keeps the Bot default', () => {
  const actors = buildBrowserActors(
    [createMetabot({ id: 2, created_at: 20, globalmetaid: 'idq1bbb' }), createMetabot()],
    createUserIdentity(),
  );

  assert.deepEqual(
    actors.map((actor) => actor.id),
    [IDBOTS_ACCOUNT_ACTOR_ID, 'idbots-metabot-1', 'idbots-metabot-2'],
  );
  assert.equal(actors[0].isDefault, false);
  assert.equal(actors.find((actor) => actor.id === 'idbots-metabot-1').isDefault, true);
});

test('buildBrowserActors keeps bot-only runtimes unchanged', () => {
  const actors = buildBrowserActors([createMetabot()], null);
  assert.deepEqual(
    actors.map((actor) => actor.id),
    ['idbots-metabot-1'],
  );
});

test('selectDefaultBrowserActor falls back to the human identity only without Bots', () => {
  const human = selectDefaultBrowserActor([], createUserIdentity());
  assert.equal(human.id, IDBOTS_ACCOUNT_ACTOR_ID);
  assert.equal(human.isDefault, true);

  const bot = selectDefaultBrowserActor([createMetabot()], createUserIdentity());
  assert.equal(bot.id, 'idbots-metabot-1');
});
