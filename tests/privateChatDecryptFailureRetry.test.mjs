import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const { startPrivateChatDaemon, stopPrivateChatDaemon } = await import(
  '../dist-electron/main/services/privateChatDaemon.js'
);
const { ecdhEncrypt } = await import('../dist-electron/main/services/metaWebCrypto.js');

function waitFor(predicate, timeoutMs = 15_000) {
  return (async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail('timed out waiting for private chat daemon test condition');
  })();
}

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function createPeerPublicKey() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh.getPublicKey('hex', 'uncompressed');
}

function createUndecryptableRowHarness() {
  // Encrypted with a shared secret the local wallet cannot derive from the
  // peer chat pubkey, so both daemon secret variants fail by construction.
  const wrongSecret = 'e'.repeat(64);
  const ciphertext = ecdhEncrypt('peer message from an incompatible sender', wrongSecret);
  const row = {
    id: 1,
    pin_id: 'incoming-pin-decrypt-retry-1',
    tx_id: 'a'.repeat(64),
    from_metaid: 'peer-metaid',
    from_global_metaid: 'peer-global',
    from_name: 'Peer Bot',
    from_avatar: null,
    from_chat_pubkey: createPeerPublicKey(),
    to_metaid: 'local-metaid',
    to_global_metaid: 'local-global',
    content: ciphertext,
    encryption: null,
    reply_pin: '',
    raw_data: null,
    is_processed: 0,
  };
  const columns = [
    'id', 'pin_id', 'tx_id', 'from_metaid', 'from_global_metaid', 'from_name',
    'from_avatar', 'from_chat_pubkey', 'to_metaid', 'to_global_metaid',
    'content', 'encryption', 'reply_pin', 'raw_data',
  ];
  const externalConversationId = 'metaweb-private:peer-global';
  const session = {
    id: 'session-private-1',
    sessionType: 'a2a',
    metabotId: 1,
    peerGlobalMetaId: 'peer-global',
    messages: [],
  };
  const mapping = {
    channel: 'metaweb_private',
    externalConversationId,
    metabotId: 1,
    coworkSessionId: session.id,
    metadataJson: JSON.stringify({ peerGlobalMetaId: 'peer-global' }),
  };
  const metabot = {
    id: 1,
    name: 'Local Bot',
    enabled: true,
    metaid: 'local-metaid',
    globalmetaid: 'local-global',
    allow_chat_skills: ['metaid-master-wiki'],
  };
  const state = { processedUpdates: 0 };
  const db = {
    exec(sql) {
      if (/FROM private_chat_messages WHERE is_processed = 0/i.test(sql)) {
        return row.is_processed
          ? []
          : [{ columns, values: [columns.map((column) => row[column])] }];
      }
      return [{ columns: ['found'], values: [] }];
    },
    run(sql) {
      if (/UPDATE private_chat_messages SET is_processed = 1 WHERE id = \?/i.test(sql)) {
        state.processedUpdates += 1;
        row.is_processed = 1;
      }
    },
  };
  const coworkStore = {
    getConversationMapping(channel, conversationId, metabotId) {
      return channel === 'metaweb_private' && conversationId === externalConversationId && metabotId === 1
        ? mapping
        : null;
    },
    getSession(sessionId) {
      return sessionId === session.id ? session : null;
    },
    getSessionWithoutMessages(sessionId) {
      return sessionId === session.id ? session : null;
    },
    getSessionMessagesMatchingMetadataValues() {
      return [];
    },
    getRecentA2AThreadMessages(sessionId, limit) {
      return this.getRecentPrivateA2AMessages(sessionId, limit);
    },
    listA2AConversationEpisodes() {
      return [];
    },
    getRecentPrivateA2AMessages() {
      return [];
    },
    getMessageById() {
      return null;
    },
    getConversationSourceContextBySession() {
      return { sourceChannel: 'metaweb_private', externalConversationId };
    },
    isSessionArchived() {
      return false;
    },
    unarchiveSession() {},
    registerA2AEpisode() {},
    isDelegationBlocking() {
      return false;
    },
    setDelegationBlocking() {},
    updateSession() {},
    upsertConversationMapping() {},
    touchConversationMapping() {},
    deleteConversationMapping() {},
    createSession() {
      session.messages.push({ id: 'msg-created-1' });
      return { id: 'session-created-1', messages: [] };
    },
    findOrderSessionByOrderPinId() {
      return null;
    },
    findOrderSessionByOrderTxid() {
      return null;
    },
    findOrderSessionByPeer() {
      return null;
    },
    hasPriorPrivateA2AOutboundMessage() {
      return false;
    },
    ensureCanonicalPeerSessionShape() {
      return true;
    },
    addMessage(sessionId, message) {
      const created = {
        id: `msg-${session.messages.length + 1}`,
        timestamp: 1_770_000_000_000 + session.messages.length,
        ...message,
      };
      session.messages.push(created);
      return created;
    },
    updateMessage() {},
    updateConversationMappingMetadata() {},
    getConfig() {
      return { workingDirectory: '/tmp/idbots-test' };
    },
    getMemoryBackend() {
      return {
        getEffectiveMemoryPolicyForMetabot() {
          return { memoryEnabled: false };
        },
      };
    },
  };
  const metabotStore = {
    getMetabotByGlobalMetaId(globalMetaId) {
      return globalMetaId === metabot.globalmetaid ? metabot : null;
    },
    getMetabotById() {
      return null;
    },
    getMetabotWalletByMetabotId(id) {
      assert.equal(id, metabot.id);
      return { mnemonic: TEST_MNEMONIC, path: "m/44'/10001'/0'/0/0" };
    },
  };
  return { db, row, coworkStore, metabotStore, metabot, session, ciphertext, state };
}

// 2026-09-20 audit shape: a peer private message whose ciphertext cannot be
// decrypted with either shared-secret variant (sha256/raw) used to be silently
// consumed — markProcessed kept the ciphertext but is_processed = 1 meant the
// daemon never retried it and no conversation was ever created. The daemon
// must keep such rows unprocessed, skip the repeated decrypt work while the
// daemon runs, and retry them on the next daemon start.
test('daemon keeps an undecryptable private message unprocessed and retries it after restart', async () => {
  const { db, row, coworkStore, metabotStore, session, ciphertext, state } = createUndecryptableRowHarness();
  const logs = [];
  const startedAt = Date.now();
  let createPinCount = 0;
  let skillTurnCalls = 0;
  const decryptFailureLogs = () => logs.filter((message) => message.includes('decrypt failed for both'));

  const startDaemon = () => {
    startPrivateChatDaemon(
      db,
      () => {},
      coworkStore,
      metabotStore,
      { on() {}, off() {} },
      async () => {
        createPinCount += 1;
        return { txids: ['t'.repeat(64)], pinId: 'p'.repeat(64) + 'i0' };
      },
      (message) => logs.push(message),
      null,
      undefined,
      undefined,
      () => ({ respondToStrangerPrivateChats: true }),
      undefined,
      undefined,
      undefined,
      async () => ({ prompt: null, activeSkillIds: [] }),
      async () => {
        skillTurnCalls += 1;
        return { replyText: 'should never run for an undecryptable row', assistantMessageId: null };
      },
      async () => '需要查询，请稍等。'
    );
  };

  startDaemon();
  try {
    await waitFor(() => decryptFailureLogs().length >= 1, 20_000);
    // Core stop-loss: the row must stay unprocessed so the ciphertext survives
    // for a later retry instead of being silently consumed.
    assert.equal(row.is_processed, 0);
    assert.equal(state.processedUpdates, 0, 'markProcessed must never run for an undecryptable row');
    assert.equal(createPinCount, 0, 'no reply may be attempted for an undecryptable row');
    assert.equal(session.messages.length, 0, 'no conversation may be created for an undecryptable row');

    // The poll loop re-drives the same row every 5s; after two more tick
    // boundaries the failure must have been logged exactly once (the in-run
    // skip guard prevents repeated ECDH/decrypt work and log spam).
    await waitFor(() => Date.now() - startedAt >= 11_000, 20_000);
    assert.equal(decryptFailureLogs().length, 1, 'the failure must not repeat within one daemon run');
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }

  // Restart: stop clears the in-run skip state, so the daemon retries the row
  // once more — this is the recovery path an app update relies on.
  startDaemon();
  try {
    await waitFor(() => decryptFailureLogs().length >= 2, 20_000);
    assert.equal(row.is_processed, 0, 'the row must still be retryable after the restart');
    assert.equal(state.processedUpdates, 0);
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }

  assert.equal(skillTurnCalls, 0);
  assert.equal(state.processedUpdates, 0);
  assert.equal(row.content, ciphertext, 'the stored ciphertext must be left intact');
});
