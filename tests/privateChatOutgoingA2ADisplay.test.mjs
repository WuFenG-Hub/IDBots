import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCoworkStore,
  createSqliteStore,
} from './memoryTestUtils.mjs';

let recordOutgoingPrivateChatA2ADisplay;
try {
  ({
    recordOutgoingPrivateChatA2ADisplay,
  } = await import('../dist-electron/main/services/privateChatDaemon.js'));
} catch {
  ({
    recordOutgoingPrivateChatA2ADisplay,
  } = await import('../dist-electron/services/privateChatDaemon.js'));
}

const LOCAL_METABOT_ID = 7;
const LOCAL_GLOBAL_META_ID = 'idq1local';
const PEER_GLOBAL_META_ID = 'idq1peer';
const TXID = 'cd9f6e01' + '0'.repeat(56);

const getMetabotById = (id) => (id === LOCAL_METABOT_ID ? {
  id,
  name: 'Lucy',
  globalmetaid: LOCAL_GLOBAL_META_ID,
} : null);

function createHarness() {
  const emitted = [];
  return {
    emitted,
    emitToRenderer: (channel, data) => emitted.push({ channel, data }),
  };
}

test('recordOutgoingPrivateChatA2ADisplay creates the A2A session and shows the sent message', async () => {
  const sqlite = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(sqlite.db);
    const harness = createHarness();

    const result = recordOutgoingPrivateChatA2ADisplay({
      coworkStore,
      getMetabotById,
      metabotId: LOCAL_METABOT_ID,
      peerGlobalMetaId: PEER_GLOBAL_META_ID,
      content: 'hi',
      chain: { txId: TXID, pinId: `${TXID}i0` },
      emitToRenderer: harness.emitToRenderer,
    });

    assert.ok(result);
    assert.equal(result.duplicate, false);
    assert.equal(result.externalConversationId, `metaweb-private:${PEER_GLOBAL_META_ID}`);
    assert.ok(result.message);

    const session = coworkStore.getSession(result.sessionId);
    assert.equal(session.sessionType, 'a2a');
    assert.equal(session.metabotId, LOCAL_METABOT_ID);
    assert.equal(session.peerGlobalMetaId, PEER_GLOBAL_META_ID);
    assert.equal(session.messages.length, 1);

    const message = session.messages[0];
    assert.equal(message.type, 'assistant');
    assert.equal(message.content, 'hi');
    assert.equal(message.metadata.sourceChannel, 'metaweb_private');
    assert.equal(message.metadata.externalConversationId, `metaweb-private:${PEER_GLOBAL_META_ID}`);
    assert.equal(message.metadata.direction, 'outgoing');
    assert.equal(message.metadata.simplemsgKind, 'private_chat');
    assert.equal(message.metadata.txid, TXID);
    assert.equal(message.metadata.pinId, `${TXID}i0`);

    const mapping = coworkStore.getConversationMapping(
      'metaweb_private',
      `metaweb-private:${PEER_GLOBAL_META_ID}`,
      LOCAL_METABOT_ID,
    );
    assert.equal(mapping?.coworkSessionId, result.sessionId);

    assert.deepEqual(
      harness.emitted.map((entry) => entry.channel),
      ['cowork:stream:message'],
    );
    assert.equal(harness.emitted[0].data.sessionId, result.sessionId);
  } finally {
    sqlite.cleanup();
  }
});

test('recordOutgoingPrivateChatA2ADisplay dedupes the socket echo by chain identity', async () => {
  const sqlite = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(sqlite.db);

    const first = recordOutgoingPrivateChatA2ADisplay({
      coworkStore,
      getMetabotById,
      metabotId: LOCAL_METABOT_ID,
      peerGlobalMetaId: PEER_GLOBAL_META_ID,
      content: 'hi',
      chain: { txId: TXID, pinId: `${TXID}i0` },
    });
    assert.ok(first);

    // The same pin comes back through the listener/history path.
    const echo = recordOutgoingPrivateChatA2ADisplay({
      coworkStore,
      getMetabotById,
      metabotId: LOCAL_METABOT_ID,
      peerGlobalMetaId: PEER_GLOBAL_META_ID,
      content: 'hi',
      chain: { txId: TXID, pinId: `${TXID}i0` },
    });

    assert.ok(echo);
    assert.equal(echo.duplicate, true);
    assert.equal(echo.message, null);
    assert.equal(coworkStore.getSession(first.sessionId).messages.length, 1);
  } finally {
    sqlite.cleanup();
  }
});

test('recordOutgoingPrivateChatA2ADisplay matches chain identity inside txids arrays', async () => {
  const sqlite = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(sqlite.db);

    const first = recordOutgoingPrivateChatA2ADisplay({
      coworkStore,
      getMetabotById,
      metabotId: LOCAL_METABOT_ID,
      peerGlobalMetaId: PEER_GLOBAL_META_ID,
      content: 'hi',
      chain: { txids: [TXID] },
    });
    assert.ok(first);

    const echo = recordOutgoingPrivateChatA2ADisplay({
      coworkStore,
      getMetabotById,
      metabotId: LOCAL_METABOT_ID,
      peerGlobalMetaId: PEER_GLOBAL_META_ID,
      content: 'hi',
      chain: { txId: TXID },
    });

    assert.equal(echo.duplicate, true);
    assert.equal(coworkStore.getSession(first.sessionId).messages.length, 1);
  } finally {
    sqlite.cleanup();
  }
});

test('recordOutgoingPrivateChatA2ADisplay ignores empty content', async () => {
  const sqlite = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(sqlite.db);

    const result = recordOutgoingPrivateChatA2ADisplay({
      coworkStore,
      getMetabotById,
      metabotId: LOCAL_METABOT_ID,
      peerGlobalMetaId: PEER_GLOBAL_META_ID,
      content: '   ',
      chain: { txId: TXID },
    });

    assert.equal(result, null);
    const mapping = coworkStore.getConversationMapping(
      'metaweb_private',
      `metaweb-private:${PEER_GLOBAL_META_ID}`,
      LOCAL_METABOT_ID,
    );
    assert.equal(mapping, null);
  } finally {
    sqlite.cleanup();
  }
});
