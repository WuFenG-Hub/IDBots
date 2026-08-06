import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createLegacyMemoryDb } from './memoryTestUtils.mjs';

let MetaIDExperienceStore;
let recordMetaIDPrivateA2AExperience;
let recordMetaIDServiceOrderExperience;
let recordMetaIDGroupTaskExperience;
try {
  ({ MetaIDExperienceStore } = await import('../dist-electron/main/metaidExperienceStore.js'));
  ({
    recordMetaIDPrivateA2AExperience,
    recordMetaIDServiceOrderExperience,
    recordMetaIDGroupTaskExperience,
  } = await import('../dist-electron/main/services/metaidExperienceRecorder.js'));
} catch {
  ({ MetaIDExperienceStore } = await import('../dist-electron/metaidExperienceStore.js'));
  ({
    recordMetaIDPrivateA2AExperience,
    recordMetaIDServiceOrderExperience,
    recordMetaIDGroupTaskExperience,
  } = await import('../dist-electron/services/metaidExperienceRecorder.js'));
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

test('service order recorder keeps lifecycle events in one owner-scoped episode', async () => {
  const { store } = await createRecorder();
  const order = {
    id: 'order-1',
    role: 'buyer',
    localMetabotId: 1,
    counterpartyGlobalMetaid: PEER,
    servicePinId: 'service-pin-1',
    orderPinId: 'order-pin-1',
    serviceName: 'Review service',
    paymentTxid: 'payment-tx-1',
    paymentChain: 'mvc',
    paymentAmount: '1',
    paymentCurrency: 'SPACE',
    settlementKind: 'native',
    mrc20Ticker: null,
    mrc20Id: null,
    paymentCommitTxid: null,
    orderMessagePinId: 'order-message-pin-1',
    orderMessageTxid: 'order-message-tx-1',
    coworkSessionId: 'order-session-1',
    status: 'awaiting_first_response',
    firstResponseDeadlineAt: 100,
    deliveryDeadlineAt: 200,
    firstResponseAt: null,
    deliveryMessagePinId: null,
    deliveredAt: null,
    ratingRequestedAt: null,
    ratingDeadlineAt: null,
    orderEndMessagePinId: null,
    orderEndedAt: null,
    orderEndReason: null,
    failedAt: null,
    failureReason: null,
    refundRequestPinId: null,
    refundFinalizePinId: null,
    refundTxid: null,
    refundRequestedAt: null,
    refundCompletedAt: null,
    refundApplyRetryCount: 0,
    nextRetryAt: null,
    createdAt: 800,
    updatedAt: 800,
  };
  const created = recordMetaIDServiceOrderExperience({
    store,
    ownerGlobalMetaID: OWNER,
    order,
    event: 'created',
    occurredAt: 800,
  });
  assert.ok(created);
  assert.equal(created.episode.episodeType, 'service_order');
  assert.equal(created.evidence.pinId, 'order-pin-1');
  assert.equal(created.evidence.publisherGlobalMetaID, OWNER);

  const delivered = recordMetaIDServiceOrderExperience({
    store,
    ownerGlobalMetaID: OWNER,
    order: { ...order, status: 'rating_pending', deliveryMessagePinId: 'delivery-pin-1', updatedAt: 900 },
    event: 'delivered',
    occurredAt: 900,
  });
  assert.equal(delivered.episode.id, created.episode.id);
  assert.equal(delivered.evidence.publisherGlobalMetaID, PEER);
  assert.equal(delivered.evidence.messageId, null);
  assert.equal(store.listEvidence(created.episode.id).length, 2);
  assert.deepEqual(store.listEpisodes({ ownerGlobalMetaID: OWNER, subjectGlobalMetaID: PEER }).map((episode) => episode.id), [created.episode.id]);
});

test('group task recorder uses one episode per local observer and dedupes chain messages', async () => {
  const { store } = await createRecorder();
  const input = {
    store,
    ownerGlobalMetaID: OWNER,
    taskId: 42,
    groupId: 'group-42',
    sessionId: 'group-session-42',
    message: {
      id: 7,
      pinId: 'group-pin-7',
      txId: 'group-tx-7',
      senderGlobalMetaID: PEER,
      senderMetaID: 'peer-metaid',
      content: 'The first deliverable is ready.',
      occurredAt: 700,
    },
    participants: [
      { globalMetaID: OWNER, role: 'chair' },
      { globalMetaID: PEER, role: 'worker' },
    ],
  };
  const first = recordMetaIDGroupTaskExperience(input);
  assert.ok(first);
  assert.equal(first.episode.taskId, '42');
  assert.equal(first.evidence.publisherGlobalMetaID, PEER);
  assert.equal(store.listParticipants(first.episode.id).length, 3);
  const duplicate = recordMetaIDGroupTaskExperience(input);
  assert.equal(duplicate.evidence.id, first.evidence.id);
  assert.equal(store.listEvidence(first.episode.id).length, 1);
});
