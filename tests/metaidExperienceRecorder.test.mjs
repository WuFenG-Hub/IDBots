import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createLegacyMemoryDb } from './memoryTestUtils.mjs';

let MetaIDExperienceStore;
let recordMetaIDPrivateA2AExperience;
try {
  ({ MetaIDExperienceStore } = await import('../dist-electron/main/metaidExperienceStore.js'));
  ({ recordMetaIDPrivateA2AExperience } = await import('../dist-electron/main/services/metaidExperienceRecorder.js'));
} catch {
  ({ MetaIDExperienceStore } = await import('../dist-electron/metaidExperienceStore.js'));
  ({ recordMetaIDPrivateA2AExperience } = await import('../dist-electron/services/metaidExperienceRecorder.js'));
}

const OWNER = 'idq1owner';
const PEER = 'idq1peer';

async function createRecorder() {
  const db = await createLegacyMemoryDb();
  const store = new MetaIDExperienceStore(db, () => {}, () => 1000);
  return { db, store };
}

test('private A2A recorder stores both participants and publisher-scoped evidence', async () => {
  const { store } = await createRecorder();
  const first = recordMetaIDPrivateA2AExperience({
    store,
    ownerGlobalMetaID: OWNER.toUpperCase(),
    peerGlobalMetaID: ` ${PEER} `,
    externalConversationId: 'a2a-conversation-1',
    sessionId: 'session-1',
    direction: 'incoming',
    content: '  Please review this implementation.  ',
    messageId: 'message-1',
    pinId: 'pin-1',
    occurredAt: 900,
    sourceMetadata: { txId: 'tx-1', pinId: 'pin-1' },
  });

  assert.ok(first);
  assert.equal(first.episode.ownerGlobalMetaID, OWNER);
  assert.equal(first.episode.externalConversationId, 'a2a-conversation-1');
  assert.deepEqual(
    store.listParticipants(first.episode.id).map((participant) => [participant.globalMetaID, participant.role]),
    [[OWNER, 'recipient'], [PEER, 'sender']],
  );
  assert.equal(first.evidence.publisherGlobalMetaID, PEER);
  assert.equal(
    first.evidence.contentHash,
    createHash('sha256').update('Please review this implementation.', 'utf8').digest('hex'),
  );
  assert.equal(first.evidence.metadata.rawText, undefined);

  const duplicate = recordMetaIDPrivateA2AExperience({
    store,
    ownerGlobalMetaID: OWNER,
    peerGlobalMetaID: PEER,
    externalConversationId: 'a2a-conversation-1',
    direction: 'incoming',
    content: 'Please review this implementation.',
    messageId: 'message-1',
    pinId: 'pin-1',
  });
  assert.equal(duplicate.evidence.id, first.evidence.id);
  assert.equal(store.listEvidence(first.episode.id).length, 1);
});

test('outgoing replies use the referenced inbound pin as their idempotency key', async () => {
  const { store } = await createRecorder();
  const outgoing = recordMetaIDPrivateA2AExperience({
    store,
    ownerGlobalMetaID: OWNER,
    peerGlobalMetaID: PEER,
    externalConversationId: 'a2a-conversation-2',
    direction: 'outgoing',
    content: 'I will take a look.',
    messageId: 'assistant-1',
    replyToPinId: 'inbound-pin-1',
  });
  assert.ok(outgoing);
  assert.equal(outgoing.evidence.sourceKey, 'reply:inbound-pin-1');
  assert.equal(outgoing.evidence.publisherGlobalMetaID, OWNER);
  assert.equal(outgoing.evidence.pinId, null);
});

test('transport no-ops, self messages, and malformed identities are not experiences', async () => {
  const { store } = await createRecorder();
  for (const content of ['', 'ping', 'pong', 'bye', 'thinking...', '…']) {
    assert.equal(recordMetaIDPrivateA2AExperience({
      store,
      ownerGlobalMetaID: OWNER,
      peerGlobalMetaID: PEER,
      externalConversationId: 'a2a-conversation-3',
      direction: 'incoming',
      content,
      pinId: `pin-${content || 'empty'}`,
    }), null);
  }
  assert.equal(recordMetaIDPrivateA2AExperience({
    store,
    ownerGlobalMetaID: OWNER,
    peerGlobalMetaID: OWNER,
    externalConversationId: 'a2a-conversation-3',
    direction: 'incoming',
    content: 'self message',
    pinId: 'self-pin',
  }), null);
  assert.equal(recordMetaIDPrivateA2AExperience({
    store,
    ownerGlobalMetaID: 'legacy-owner',
    peerGlobalMetaID: PEER,
    externalConversationId: 'a2a-conversation-3',
    direction: 'incoming',
    content: 'unknown sender',
    pinId: 'bad-pin',
  }), null);
});
