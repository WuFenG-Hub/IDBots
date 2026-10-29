import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createLegacyMemoryDb } from './memoryTestUtils.mjs';

// Opt-in end-to-end wiring test against a LOCAL metaso-p2p social harness
// (real social + block aggregators, real routes, synthetic seeded data).
// Run it with the S4 friend harness:
//   FRIEND_HARNESS_URL=http://127.0.0.1:48787 node --test tests/friendWiringIntegration.test.mjs
// Without the env var the suite skips — CI stays green without a harness.
const HARNESS_URL = process.env.FRIEND_HARNESS_URL?.trim() || '';
const skip = !HARNESS_URL;

const require = Module.createRequire(import.meta.url);
const { MetasoFriendRelationshipProvider } = require('../dist-electron/main/services/friendRelationshipService.js');
const { MetaIDRelationshipResolver } = require('../dist-electron/main/services/metaidRelationshipResolver.js');
const {
  buildFriendAgentTools,
  createMetasoFriendControl,
} = require('../dist-electron/main/libs/friendAgentTools.js');
let MetaIDCognitionContextService;
let MetaIDExperienceStore;
let MetaIDImpressionStore;
try {
  ({ MetaIDCognitionContextService } = require('../dist-electron/main/services/metaidCognitionContext.js'));
  ({ MetaIDExperienceStore } = require('../dist-electron/main/metaidExperienceStore.js'));
  ({ MetaIDImpressionStore } = require('../dist-electron/main/metaidImpressionStore.js'));
} catch {
  ({ MetaIDCognitionContextService } = await import('../dist-electron/main/services/metaidCognitionContext.js'));
  ({ MetaIDExperienceStore } = await import('../dist-electron/main/metaidExperienceStore.js'));
  ({ MetaIDImpressionStore } = await import('../dist-electron/main/metaidImpressionStore.js'));
}

async function fetchHarnessIds() {
  const response = await fetch(`${HARNESS_URL}/harness/ids`);
  if (!response.ok) throw new Error(`harness /ids HTTP ${response.status}`);
  const body = await response.json();
  return body.identities;
}

function buildCognitionService(db, provider) {
  const experience = new MetaIDExperienceStore(db, () => {}, () => 1_800_000_000_000);
  const impressions = new MetaIDImpressionStore(db, () => {}, () => 1_800_000_000_000);
  const resolver = new MetaIDRelationshipResolver({
    listMetabots: () => [],
    friendProvider: provider,
    now: () => 1_800_000_000_000,
  });
  return new MetaIDCognitionContextService({
    experienceStore: experience,
    impressionStore: impressions,
    relationshipResolver: resolver,
  });
}

test('wiring end-to-end against the local metaso-p2p social harness', { skip }, async () => {
  const identities = await fetchHarnessIds();
  const self = identities.self.globalMetaId;

  const provider = new MetasoFriendRelationshipProvider({ baseUrl: HARNESS_URL, timeoutMs: 3_000 });
  const db = await createLegacyMemoryDb();
  try {
    const service = buildCognitionService(db, provider);

    // ① friend (mutual follow): confirmed + no-block flags render.
    const friendBlock = await service.buildPromptBlock({
      observerGlobalMetaID: self,
      subjectGlobalMetaID: identities.alice.globalMetaId,
    });
    assert.match(friendBlock, /friend current state: confirmed \(authoritative source=friend_api\)/);
    assert.match(friendBlock, /block current state: you block this peer=false; this peer blocks you=false/);

    // ② single-sided follower (bob → self) and following (self → carol):
    //    not_confirmed with honest direction flags.
    const followerBlock = await service.buildPromptBlock({
      observerGlobalMetaID: self,
      subjectGlobalMetaID: identities.bob.globalMetaId,
    });
    assert.match(followerBlock, /friend current state: not_confirmed/);
    const followerFact = followerBlock.match(/block current state: ([^\n]+)/);
    assert.ok(followerFact, 'follower block-state line renders');
    assert.match(followerFact[1], /you block this peer=false/);

    const followingBlock = await service.buildPromptBlock({
      observerGlobalMetaID: self,
      subjectGlobalMetaID: identities.carol.globalMetaId,
    });
    assert.match(followingBlock, /friend current state: not_confirmed/);

    // ③ stranger (dave, no edges): not_confirmed.
    const strangerBlock = await service.buildPromptBlock({
      observerGlobalMetaID: self,
      subjectGlobalMetaID: identities.dave.globalMetaId,
    });
    assert.match(strangerBlock, /friend current state: not_confirmed/);

    // ④ blocked (self blocks eve): not_confirmed + blocking=true renders.
    const blockedBlock = await service.buildPromptBlock({
      observerGlobalMetaID: self,
      subjectGlobalMetaID: identities.eve.globalMetaId,
    });
    assert.match(blockedBlock, /friend current state: not_confirmed/);
    assert.match(blockedBlock, /you block this peer=true; this peer blocks you=false/);
  } finally {
    db.close();
  }

  // ⑤ Tools through the same control main.ts mounts.
  const control = createMetasoFriendControl({ baseUrl: HARNESS_URL });
  const tools = buildFriendAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, handler }),
    control,
    getSelfGlobalMetaId: () => self,
  });
  const byName = Object.fromEntries(tools.map((entry) => [entry.name, entry]));

  const eveCheck = await byName.check_peer_relationship.handler({ peer: `metaid://${identities.eve.globalMetaId}` });
  assert.equal(eveCheck.isError, undefined);
  const eveText = eveCheck.content[0].text;
  assert.match(eveText, /relation: blocked \(a block is active in at least one direction\)/);
  assert.match(eveText, /blocking \(you block peer\): true/);
  assert.match(eveText, /A block is active/);

  const aliceCheck = await byName.check_peer_relationship.handler({ peer: identities.alice.globalMetaId });
  const aliceText = aliceCheck.content[0].text;
  assert.match(aliceText, /relation: friend \(mutual follow\)/);
  assert.match(aliceText, /direct point-to-point asset transfers are acceptable/i);

  const bobCheck = await byName.check_peer_relationship.handler({ peer: identities.bob.globalMetaId });
  assert.match(bobCheck.content[0].text, /relation: follower \(they follow you; you do not follow them\)/);

  const friendsList = await byName.list_social_connections.handler({ list: 'friends' });
  const friendsText = friendsList.content[0].text;
  assert.match(friendsText, /\[alice-bot\]\(metaid:\/\/[a-z0-9]+\)/);
  assert.match(friendsText, /1 friends \(mutual follows\)/);

  const blockedList = await byName.list_social_connections.handler({ list: 'blocked' });
  const blockedText = blockedList.content[0].text;
  assert.match(blockedText, /\[eve-bot\]\(metaid:\/\/[a-z0-9]+\)/);
  assert.match(blockedText, /block pin: block-self-eve:i0/);

  const followersList = await byName.list_social_connections.handler({ list: 'followers' });
  assert.match(followersList.content[0].text, /alice-bot/);
  assert.match(followersList.content[0].text, /bob-bot/);

  const emptyList = await byName.list_social_connections.handler({ list: 'following' });
  // self→carol is the only following edge... carol-bot must appear.
  assert.match(emptyList.content[0].text, /carol-bot/);
});

test('unreachable aggregation degrades to unknown without breaking resolution', { skip }, async () => {
  const identities = await fetchHarnessIds();
  const deadProvider = new MetasoFriendRelationshipProvider({
    // Nothing listens here: connection refused → provider throws → resolver folds unknown.
    baseUrl: 'http://127.0.0.1:1',
    timeoutMs: 1_000,
  });
  const db = await createLegacyMemoryDb();
  try {
    const service = buildCognitionService(db, deadProvider);
    const rendered = await service.buildPromptBlock({
      observerGlobalMetaID: identities.self.globalMetaId,
      subjectGlobalMetaID: identities.dave.globalMetaId,
    });
    assert.match(rendered, /<metaid_cognition_context/);
    assert.doesNotMatch(rendered, /friend current state/);
    assert.doesNotMatch(rendered, /block current state/);
  } finally {
    db.close();
  }
});
