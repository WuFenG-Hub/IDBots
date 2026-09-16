import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

let startPrivateChatDaemon;
let stopPrivateChatDaemon;
let buildPrivateChatA2AWakeNotice;
let nextPrivateChatA2AWakeAt;
let setPrivateChatA2AWakeDelaysForTests;
let PRIVATE_CHAT_A2A_DEFAULT_WAKE_DELAYS_MS;
try {
  ({
    startPrivateChatDaemon,
    stopPrivateChatDaemon,
    buildPrivateChatA2AWakeNotice,
    nextPrivateChatA2AWakeAt,
    setPrivateChatA2AWakeDelaysForTests,
    PRIVATE_CHAT_A2A_DEFAULT_WAKE_DELAYS_MS,
  } = await import('../dist-electron/main/services/privateChatDaemon.js'));
} catch {
  ({
    startPrivateChatDaemon,
    stopPrivateChatDaemon,
    buildPrivateChatA2AWakeNotice,
    nextPrivateChatA2AWakeAt,
    setPrivateChatA2AWakeDelaysForTests,
    PRIVATE_CHAT_A2A_DEFAULT_WAKE_DELAYS_MS,
  } = await import('../dist-electron/main/services/privateChatDaemon.js'));
}

test('wake notice explains the timer, the owed-reply option, and the exits', () => {
  const notice = buildPrivateChatA2AWakeNotice(2);
  assert.ok(notice.includes('Host Wake Check 2'), 'notice should name the fire');
  assert.ok(notice.includes('no new peer message arrived'));
  assert.ok(notice.includes('deliver it now as your final text'));
  assert.ok(notice.includes('"bye"'));
  assert.ok(notice.includes('[NO_REPLY]'));
  assert.ok(buildPrivateChatA2AWakeNotice(Number.NaN).includes('Host Wake Check 1'));
});

test('wake schedule is bounded by its delay ladder', () => {
  const now = Date.now();
  assert.equal(nextPrivateChatA2AWakeAt(0, now), now + PRIVATE_CHAT_A2A_DEFAULT_WAKE_DELAYS_MS[0]);
  assert.equal(nextPrivateChatA2AWakeAt(1, now), now + PRIVATE_CHAT_A2A_DEFAULT_WAKE_DELAYS_MS[1]);
  assert.equal(
    nextPrivateChatA2AWakeAt(PRIVATE_CHAT_A2A_DEFAULT_WAKE_DELAYS_MS.length, now),
    null,
    'budget exhausted after one fire per ladder step'
  );
  try {
    setPrivateChatA2AWakeDelaysForTests([100, 200]);
    assert.equal(nextPrivateChatA2AWakeAt(1, now), now + 200);
    assert.equal(nextPrivateChatA2AWakeAt(2, now), null);
    // Non-positive entries are dropped from the test override.
    setPrivateChatA2AWakeDelaysForTests([100, -5]);
    assert.equal(nextPrivateChatA2AWakeAt(1, now), null);
  } finally {
    setPrivateChatA2AWakeDelaysForTests(PRIVATE_CHAT_A2A_DEFAULT_WAKE_DELAYS_MS);
  }
});

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function createPeerPublicKey() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh.getPublicKey('hex', 'uncompressed');
}

function createWakeDaemonHarness() {
  const row = {
    id: 1,
    pin_id: 'incoming-pin-wake-1',
    tx_id: 'a'.repeat(64),
    from_metaid: 'peer-metaid',
    from_global_metaid: 'peer-global',
    from_name: 'Peer Bot',
    from_avatar: null,
    from_chat_pubkey: createPeerPublicKey(),
    to_metaid: 'local-metaid',
    to_global_metaid: 'local-global',
    content: 'The verification anchors are ready — I will wait silently for your complete reply.',
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
    messages: [
      // Established conversation: a prior delivered outbound so the daemon
      // treats this peer as one we are actively talking to (wake arming
      // requires prior local outbound).
      {
        id: 'msg-seed-outbound',
        timestamp: 1_770_000_000_000,
        type: 'assistant',
        content: 'Received — give me a moment to verify these points and I will come back with the complete reply.',
        metadata: {
          sourceChannel: 'metaweb_private',
          externalConversationId,
          direction: 'outgoing',
          privateChatDeliveryStatus: 'sent',
        },
      },
    ],
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
  const db = {
    exec(sql) {
      if (/FROM private_chat_messages WHERE is_processed = 0/i.test(sql)) {
        return row.is_processed
          ? []
          : [{ columns, values: [columns.map((column) => row[column])] }];
      }
      return [{ columns: ['found'], values: [] }];
    },
    run(sql, params) {
      if (/UPDATE private_chat_messages SET is_processed = 1 WHERE id = \?/i.test(sql)) {
        row.is_processed = 1;
        assert.deepEqual(params, [row.id]);
      } else if (/UPDATE private_chat_messages SET is_processed = 0 WHERE id = \?/i.test(sql)) {
        row.is_processed = 0;
        assert.deepEqual(params, [row.id]);
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
    getSessionMessagesMatchingMetadataValues(sessionId, values, limit = 50) {
      const needles = (Array.isArray(values) ? values : [values])
        .map((value) => String(value ?? '').trim())
        .filter(Boolean);
      if (needles.length === 0) return [];
      return session.messages
        .filter((message) => needles.some((needle) => JSON.stringify(message.metadata ?? {}).includes(needle)))
        .reverse()
        .slice(0, limit);
    },
    getRecentPrivateA2AMessages(sessionId, requestedLimit = 100) {
      const limit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(1000, Math.floor(requestedLimit)))
        : 100;
      return session.messages
        .filter((message) => (
          (message.type === 'user' || message.type === 'assistant')
          && message.metadata?.sourceChannel === 'metaweb_private'
          && message.metadata?.orderExecutionTrace !== true
        ))
        .slice(-limit);
    },
    getMessageById(sessionId, messageId) {
      return session.messages.find((message) => message.id === messageId) ?? null;
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
    updateSession(sessionId, updates) {
      if (sessionId === session.id) Object.assign(session, updates);
    },
    upsertConversationMapping() {},
    touchConversationMapping() {},
    deleteConversationMapping() {},
    createSession() {
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
    hasPriorPrivateA2AOutboundMessage(sessionId) {
      return session.messages.some((message) => (
        message.type === 'assistant'
        && message.metadata?.sourceChannel === 'metaweb_private'
        && String(message.content ?? '').trim() !== ''
      ));
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
    updateMessage(sessionId, messageId, updates) {
      const message = session.messages.find((item) => item.id === messageId);
      if (message) Object.assign(message, updates);
    },
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
  return { db, row, coworkStore, metabotStore, metabot, session, externalConversationId };
}

async function waitFor(predicate, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('timed out waiting for private chat daemon test condition');
}

function startWakeHarnessDaemon(harness, logs, skillTurnImpl) {
  let createPinCount = 0;
  const skillTurnCalls = [];
  startPrivateChatDaemon(
    harness.db,
    () => {},
    harness.coworkStore,
    harness.metabotStore,
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
    async () => ({
      prompt: '<available_skills><skill><id>metaid-master-wiki</id></skill></available_skills>',
      activeSkillIds: ['metaid-master-wiki'],
    }),
    async (params) => {
      skillTurnCalls.push(params);
      return skillTurnImpl(params, skillTurnCalls.length, harness.coworkStore);
    },
    async () => '我需要查询一下，请稍等。'
  );
  return {
    get createPinCount() {
      return createPinCount;
    },
    skillTurnCalls,
  };
}

// 2026-09-16 deadlock shape: our bot promised a deferred answer, the peer's
// latest message says they will wait silently, and the model answers with
// [NO_REPLY]. Without a wake the conversation dies; with it, the host
// re-drives the same row on a timer and the model delivers the owed reply.
test('wake re-drives a silent decision and delivers the owed reply', async () => {
  setPrivateChatA2AWakeDelaysForTests([300]);
  const harness = createWakeDaemonHarness();
  const logs = [];
  const handle = startWakeHarnessDaemon(harness, logs, (params, call, coworkStore) => {
    if (call === 1) {
      coworkStore.addMessage(params.sessionId, {
        type: 'assistant',
        content: '[NO_REPLY]',
        metadata: { isStreaming: false, isFinal: true },
      });
      return { replyText: '[NO_REPLY]', assistantMessageId: null };
    }
    const persisted = coworkStore.addMessage(params.sessionId, {
      type: 'assistant',
      content: 'Verification complete — here is the full reply I owed you.',
      metadata: { isStreaming: false, isFinal: true },
    });
    return { replyText: 'Verification complete — here is the full reply I owed you.', assistantMessageId: persisted.id };
  });

  try {
    await waitFor(() => logs.some((message) => message.includes('Wake 1 scheduled')), 20_000);
    await waitFor(() => logs.some((message) => message.includes('Wake 1 fired')), 20_000);
    await waitFor(() => logs.some((message) => message.includes('Replied to')), 20_000);
    // The delivered reply cancels the wake: no further turns may run.
    await new Promise((resolve) => setTimeout(resolve, 7_000));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
    setPrivateChatA2AWakeDelaysForTests(PRIVATE_CHAT_A2A_DEFAULT_WAKE_DELAYS_MS);
  }

  assert.equal(handle.skillTurnCalls.length, 2, 'exactly one wake turn should follow the silent decision');
  assert.ok(!handle.skillTurnCalls[0].systemPrompt.includes('Host Wake Check'), 'original turn has no wake notice');
  assert.ok(handle.skillTurnCalls[1].systemPrompt.includes('Host Wake Check'), 'wake turn carries the wake notice');
  assert.ok(handle.skillTurnCalls[1].systemPrompt.includes('no new peer message arrived'));
  assert.equal(harness.row.is_processed, 1);
  assert.equal(handle.createPinCount, 1);
  assert.ok(
    harness.session.messages.some((message) => message.metadata?.privateChatWakeNotice === true),
    'a host wake bubble should be persisted for owner visibility'
  );
  const delivered = harness.session.messages.find(
    (message) => message.content === 'Verification complete — here is the full reply I owed you.'
  );
  assert.equal(delivered?.metadata?.privateChatDeliveryStatus, 'sent');
});

// A conversation that stays silent through every wake must stop after the
// budget is exhausted instead of polling the model forever.
test('wake budget is exhausted after the configured fires', async () => {
  setPrivateChatA2AWakeDelaysForTests([300, 300, 300]);
  const harness = createWakeDaemonHarness();
  const logs = [];
  const handle = startWakeHarnessDaemon(harness, logs, (params, call, coworkStore) => {
    const persisted = coworkStore.addMessage(params.sessionId, {
      type: 'assistant',
      content: '[NO_REPLY]',
      metadata: { isStreaming: false, isFinal: true },
    });
    return { replyText: '[NO_REPLY]', assistantMessageId: persisted.id };
  });

  try {
    await waitFor(() => logs.some((message) => message.includes('Wake budget exhausted')), 60_000);
    // No further wake may fire after exhaustion.
    await new Promise((resolve) => setTimeout(resolve, 7_000));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
    setPrivateChatA2AWakeDelaysForTests(PRIVATE_CHAT_A2A_DEFAULT_WAKE_DELAYS_MS);
  }

  assert.equal(handle.skillTurnCalls.length, 4, 'original turn + 3 wake fires, then stop');
  assert.equal(harness.row.is_processed, 1);
  assert.equal(handle.createPinCount, 0, 'a permanently silent conversation delivers nothing on-chain');
  const wakeTurns = handle.skillTurnCalls.filter((params) => params.systemPrompt.includes('Host Wake Check'));
  assert.equal(wakeTurns.length, 3);
});
