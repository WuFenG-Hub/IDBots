import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCoworkStore,
  createSqliteStore,
} from './memoryTestUtils.mjs';

let recordOutgoingPrivateChatA2ADisplay;
let appendPrivateChatA2AMessage;
try {
  ({
    recordOutgoingPrivateChatA2ADisplay,
    appendPrivateChatA2AMessage,
  } = await import('../dist-electron/main/services/privateChatDaemon.js'));
} catch {
  ({
    recordOutgoingPrivateChatA2ADisplay,
    appendPrivateChatA2AMessage,
  } = await import('../dist-electron/services/privateChatDaemon.js'));
}

const LOCAL_METABOT_ID = 11;
const LOCAL_GLOBAL_META_ID = 'idq1heallocal';
const PEER_GLOBAL_META_ID = 'idq1healpeer';

const getMetabotById = (id) => (id === LOCAL_METABOT_ID ? {
  id,
  name: 'Healer',
  globalmetaid: LOCAL_GLOBAL_META_ID,
} : null);

const txid = (seed) => seed.padEnd(64, '0').slice(0, 64);

function recordOutgoing(coworkStore, emitToRenderer, seed, content = 'hello again') {
  return recordOutgoingPrivateChatA2ADisplay({
    coworkStore,
    getMetabotById,
    metabotId: LOCAL_METABOT_ID,
    peerGlobalMetaId: PEER_GLOBAL_META_ID,
    content,
    chain: { txId: txid(seed), pinId: `${txid(seed)}i0` },
    ...(emitToRenderer ? { emitToRenderer } : undefined),
  });
}

test('new outgoing activity heals an A2A session resting on a stale error status', async () => {
  const sqlite = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(sqlite.db);

    const first = recordOutgoing(coworkStore, null, 'aa');
    assert.ok(first);

    coworkStore.updateSession(first.sessionId, { status: 'error' });
    assert.equal(coworkStore.getSession(first.sessionId).status, 'error');

    const emitted = [];
    const healed = recordOutgoing(
      coworkStore,
      (channel, data) => emitted.push({ channel, data }),
      'bb',
    );
    assert.ok(healed);
    assert.equal(healed.duplicate, false);

    // The stale error is gone: the banner follows session status.
    assert.equal(coworkStore.getSession(first.sessionId).status, 'completed');
    const completeEvents = emitted.filter(
      (entry) => entry.channel === 'cowork:stream:complete' && entry.data.sessionId === first.sessionId,
    );
    assert.equal(completeEvents.length, 1);
  } finally {
    sqlite.cleanup();
  }
});

test('non-error statuses are never touched by the heal', async () => {
  const sqlite = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(sqlite.db);

    const first = recordOutgoing(coworkStore, null, 'cc');
    assert.ok(first);

    for (const status of ['running', 'idle', 'completed', 'stopped']) {
      coworkStore.updateSession(first.sessionId, { status });
      const next = recordOutgoing(coworkStore, null, `dd${status}`);
      assert.ok(next);
      assert.equal(
        coworkStore.getSession(first.sessionId).status,
        status,
        `status ${status} must survive a new message`,
      );
    }
  } finally {
    sqlite.cleanup();
  }
});

test('standard cowork sessions resting on error are never healed via the A2A append path', async () => {
  const sqlite = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(sqlite.db);
    const session = coworkStore.createSession(
      'standard',
      process.cwd(),
      '',
      'local',
      [],
      null,
      'standard',
    );

    coworkStore.updateSession(session.id, { status: 'error' });

    appendPrivateChatA2AMessage({
      coworkStore,
      sessionId: session.id,
      externalConversationId: `metaweb-private:${PEER_GLOBAL_META_ID}`,
      type: 'assistant',
      content: 'should not heal',
    });

    assert.equal(coworkStore.getSession(session.id).status, 'error');
  } finally {
    sqlite.cleanup();
  }
});

test('duplicate outgoing rows (no new transcript activity) do not heal', async () => {
  const sqlite = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(sqlite.db);

    const first = recordOutgoing(coworkStore, null, 'ee');
    assert.ok(first);

    coworkStore.updateSession(first.sessionId, { status: 'error' });

    const echo = recordOutgoing(coworkStore, null, 'ee');
    assert.equal(echo.duplicate, true);
    assert.equal(coworkStore.getSession(first.sessionId).status, 'error');
  } finally {
    sqlite.cleanup();
  }
});

test('incoming A2A messages heal too (appendPrivateChatA2AMessage user path)', async () => {
  const sqlite = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(sqlite.db);

    const first = recordOutgoing(coworkStore, null, 'ff');
    assert.ok(first);

    coworkStore.updateSession(first.sessionId, { status: 'error' });

    appendPrivateChatA2AMessage({
      coworkStore,
      sessionId: first.sessionId,
      externalConversationId: first.externalConversationId,
      type: 'user',
      content: 'peer says hi',
      senderGlobalMetaId: PEER_GLOBAL_META_ID,
    });

    assert.equal(coworkStore.getSession(first.sessionId).status, 'completed');
  } finally {
    sqlite.cleanup();
  }
});
