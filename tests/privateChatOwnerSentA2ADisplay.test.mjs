/**
 * Owner-composer A2A display: a private-chat simplemsg the local human owner
 * sent from the A2A session composer (signed by the user-identity wallet) is
 * recorded as an INCOMING peer turn in the local bot's session, dedupes
 * against the daemon's later chain sync of the same pin, and must not trip
 * the retransmission guard that would otherwise suppress the bot's reply.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCoworkStore,
  createSqliteStore,
} from './memoryTestUtils.mjs';

let recordOwnerSentPrivateChatA2AMessage;
let isRepeatPrivateChatInboundMessage;
try {
  ({
    recordOwnerSentPrivateChatA2AMessage,
    isRepeatPrivateChatInboundMessage,
  } = await import('../dist-electron/main/services/privateChatDaemon.js'));
} catch {
  ({
    recordOwnerSentPrivateChatA2AMessage,
    isRepeatPrivateChatInboundMessage,
  } = await import('../dist-electron/main/services/privateChatDaemon.js'));
}

const LOCAL_METABOT_ID = 7;
const OWNER_GLOBAL_META_ID = 'idq1owner';
const EXTERNAL_CONVERSATION_ID = `metaweb-private:${OWNER_GLOBAL_META_ID}`;
const TXID = 'ab'.repeat(32);
const PIN_ID = `${TXID}i0`;
const RETRANSMITTED_TXID = 'cd'.repeat(32);
const RETRANSMITTED_PIN_ID = `${RETRANSMITTED_TXID}i0`;

function setupSession(coworkStore) {
  const session = coworkStore.createSession(
    'Owner chat',
    '/tmp',
    '',
    'local',
    [],
    LOCAL_METABOT_ID,
    'a2a',
    OWNER_GLOBAL_META_ID,
    'Owner',
    null,
  );
  coworkStore.upsertConversationMapping({
    channel: 'metaweb_private',
    externalConversationId: EXTERNAL_CONVERSATION_ID,
    metabotId: LOCAL_METABOT_ID,
    coworkSessionId: session.id,
    metadataJson: JSON.stringify({ peerGlobalMetaId: OWNER_GLOBAL_META_ID }),
  });
  return session;
}

function createHarness() {
  const emitted = [];
  return {
    emitted,
    emitToRenderer: (channel, data) => emitted.push({ channel, data }),
  };
}

test('recordOwnerSentPrivateChatA2AMessage shows the owner message as an incoming peer turn', async () => {
  const sqlite = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(sqlite.db);
    const session = setupSession(coworkStore);
    const harness = createHarness();

    const result = recordOwnerSentPrivateChatA2AMessage({
      coworkStore,
      sessionId: session.id,
      externalConversationId: EXTERNAL_CONVERSATION_ID,
      metabotId: LOCAL_METABOT_ID,
      ownerGlobalMetaId: OWNER_GLOBAL_META_ID,
      ownerName: 'The Owner',
      ownerAvatar: null,
      content: 'hello bot',
      chain: { txids: [TXID], pinId: PIN_ID },
      emitToRenderer: harness.emitToRenderer,
    });

    assert.ok(result);
    assert.equal(result.duplicate, false);
    assert.ok(result.message);

    const stored = coworkStore.getSession(session.id);
    assert.equal(stored.messages.length, 1);

    const message = stored.messages[0];
    assert.equal(message.id, result.message.id);
    assert.equal(message.type, 'user');
    assert.equal(message.content, 'hello bot');
    assert.equal(message.metadata.sourceChannel, 'metaweb_private');
    assert.equal(message.metadata.externalConversationId, EXTERNAL_CONVERSATION_ID);
    assert.equal(message.metadata.direction, 'incoming');
    assert.equal(message.metadata.senderGlobalMetaId, OWNER_GLOBAL_META_ID);
    assert.equal(message.metadata.senderName, 'The Owner');
    assert.equal(message.metadata.simplemsgKind, 'private_chat');
    assert.equal(message.metadata.ownerSent, true);
    assert.equal(message.metadata.txid, TXID);
    assert.equal(message.metadata.pinId, PIN_ID);
    assert.equal(message.metadata.suppressRunningStatus, true);

    assert.deepEqual(
      harness.emitted.map((entry) => entry.channel),
      ['cowork:stream:message'],
    );
    assert.equal(harness.emitted[0].data.sessionId, session.id);
  } finally {
    sqlite.cleanup();
  }
});

test('recordOwnerSentPrivateChatA2AMessage dedupes when the same pin syncs back', async () => {
  const sqlite = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(sqlite.db);
    const session = setupSession(coworkStore);

    const first = recordOwnerSentPrivateChatA2AMessage({
      coworkStore,
      sessionId: session.id,
      externalConversationId: EXTERNAL_CONVERSATION_ID,
      metabotId: LOCAL_METABOT_ID,
      ownerGlobalMetaId: OWNER_GLOBAL_META_ID,
      content: 'hello bot',
      chain: { txids: [TXID], pinId: PIN_ID },
    });
    assert.ok(first);
    assert.equal(first.duplicate, false);

    // The daemon's chain sync picks the same pin up later: the optimistic
    // copy is reused, no second bubble.
    const echo = recordOwnerSentPrivateChatA2AMessage({
      coworkStore,
      sessionId: session.id,
      externalConversationId: EXTERNAL_CONVERSATION_ID,
      metabotId: LOCAL_METABOT_ID,
      ownerGlobalMetaId: OWNER_GLOBAL_META_ID,
      content: 'hello bot',
      chain: { txids: [TXID], pinId: PIN_ID },
    });

    assert.ok(echo);
    assert.equal(echo.duplicate, true);
    assert.equal(echo.message.id, first.message.id);
    assert.equal(coworkStore.getSession(session.id).messages.length, 1);
  } finally {
    sqlite.cleanup();
  }
});

test('retransmission guard ignores the locally recorded copy of the same chain message', async () => {
  const sqlite = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(sqlite.db);
    const session = setupSession(coworkStore);

    const recorded = recordOwnerSentPrivateChatA2AMessage({
      coworkStore,
      sessionId: session.id,
      externalConversationId: EXTERNAL_CONVERSATION_ID,
      metabotId: LOCAL_METABOT_ID,
      ownerGlobalMetaId: OWNER_GLOBAL_META_ID,
      content: 'hello bot',
      chain: { txids: [TXID], pinId: PIN_ID },
    });
    assert.ok(recorded);

    const messages = coworkStore.getSession(session.id).messages;

    // Without the exclusion the optimistic copy looks like a repeat — the
    // legacy behavior that would have suppressed the bot's reply.
    assert.equal(
      isRepeatPrivateChatInboundMessage({ messages, plaintext: 'hello bot' }),
      true,
    );

    // Excluding the row's own chain identity: this is the SAME message, so
    // the reply turn must proceed.
    assert.equal(
      isRepeatPrivateChatInboundMessage({
        messages,
        plaintext: 'hello bot',
        excludeChainRow: { pin_id: PIN_ID, tx_id: TXID },
      }),
      false,
    );

    // A genuinely different pin carrying the same text is still a
    // retransmission and stays suppressed.
    assert.equal(
      isRepeatPrivateChatInboundMessage({
        messages,
        plaintext: 'hello bot',
        excludeChainRow: { pin_id: RETRANSMITTED_PIN_ID, tx_id: RETRANSMITTED_TXID },
      }),
      true,
    );
  } finally {
    sqlite.cleanup();
  }
});
