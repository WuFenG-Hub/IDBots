import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// H-64 腿 B (wake re-drive identifiability): the wake scheduler re-drives a
// silent conversation's row by flipping it back to unprocessed. The re-driven
// row then re-enters the inbound path (ECDH ready + presentation) exactly like
// a true new peer message. The fix hands a wake disposition — the ORIGINAL
// message id + a re-served bit — from the dispatch point down to the
// presentation layer, so handler and UI can tell "re-served old message"
// apart from "true new inbound". These tests pin that contract:
//   1. a re-drive that actually re-presents the row carries
//      privateChatReServed + privateChatReServedForMessageId;
//   2. a true new inbound never carries them;
//   3. the existing presentation is never retroactively marked;
//   4. the [NO_REPLY] -> wake -> fired -> re-drive flow itself is unchanged.

let startPrivateChatDaemon;
let stopPrivateChatDaemon;
let buildPrivateChatA2AWakeNotice;
let nextPrivateChatA2AWakeAt;
let setPrivateChatA2AWakeDelaysForTests;
let PRIVATE_CHAT_A2A_DEFAULT_WAKE_DELAYS_MS;
({
  startPrivateChatDaemon,
  stopPrivateChatDaemon,
  buildPrivateChatA2AWakeNotice,
  nextPrivateChatA2AWakeAt,
  setPrivateChatA2AWakeDelaysForTests,
  PRIVATE_CHAT_A2A_DEFAULT_WAKE_DELAYS_MS,
} = await import('../dist-electron/main/services/privateChatDaemon.js'));

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function createPeerPublicKey() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh.getPublicKey('hex', 'uncompressed');
}

function createWakeDispositionHarness() {
  // The row id mirrors the incident log (`Wake 1 fired … re-driving message
  // 21856`): the disposition must carry THIS id to the presentation layer.
  const row = {
    id: 21856,
    pin_id: 'incoming-pin-wake-disposition-1',
    tx_id: 'b'.repeat(64),
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
    getRecentA2AThreadMessages(sessionId, limit = 400) {
      return this.getRecentPrivateA2AMessages(sessionId, limit);
    },
    listA2AConversationEpisodes() {
      return [];
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
  return {
    db,
    row,
    coworkStore,
    metabotStore,
    metabot,
    session,
    externalConversationId,
    inboundBubbles: () => session.messages.filter((message) => (
      message.type === 'user'
      && message.metadata?.sourceChannel === 'metaweb_private'
    )),
  };
}

async function waitFor(predicate, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('timed out waiting for private chat daemon test condition');
}

function startDispositionHarnessDaemon(harness, logs, skillTurnImpl) {
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

// Full flow: true new inbound -> silent [NO_REPLY] -> wake armed -> wake fires
// and re-drives the row -> the re-drive re-presents the row (the session no
// longer holds the original bubble — the session-scoped dedup guard misses,
// exactly the production triple-display precondition) -> the re-presented
// inbound carries the wake disposition (re-served bit + original message id).
test('wake re-drive presents the re-served row with the original message id; a true new inbound does not carry it', async () => {
  setPrivateChatA2AWakeDelaysForTests([300]);
  const harness = createWakeDispositionHarness();
  const logs = [];
  let firstInboundBubble = null;
  const handle = startDispositionHarnessDaemon(harness, logs, (params, call, coworkStore) => {
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
    // True new inbound: the first presentation must look like one.
    await waitFor(() => harness.inboundBubbles().length === 1, 20_000);
    firstInboundBubble = { ...harness.inboundBubbles()[0], metadata: { ...harness.inboundBubbles()[0].metadata } };
    await waitFor(() => logs.some((message) => message.includes('Wake 1 scheduled')), 20_000);
    // Simulate the session-scoped dedup miss (episode rollover / mapping
    // repair put the conversation tail into a different session shape): the
    // re-drive will no longer find the original bubble and will re-present.
    harness.session.messages = harness.session.messages.filter(
      (message) => message.id !== firstInboundBubble.id
    );
    await waitFor(() => logs.some((message) => message.includes('Wake 1 fired')), 20_000);
    await waitFor(() => logs.some((message) => message.includes('Replied to')), 20_000);
    // The delivered reply ends the episode: no further turns may run.
    await new Promise((resolve) => setTimeout(resolve, 7_000));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
    setPrivateChatA2AWakeDelaysForTests(PRIVATE_CHAT_A2A_DEFAULT_WAKE_DELAYS_MS);
  }

  // True new inbound: no disposition bits.
  assert.ok(firstInboundBubble, 'the original inbound bubble was captured');
  assert.notEqual(firstInboundBubble.metadata?.privateChatReServed, true, 'a true new inbound must not carry the re-served bit');
  assert.equal(firstInboundBubble.metadata?.privateChatReServedForMessageId, undefined);

  // Exactly one re-presented inbound bubble, carrying the disposition.
  const rePresented = harness.inboundBubbles();
  assert.equal(rePresented.length, 1, 'the re-drive re-presented exactly one inbound bubble');
  assert.equal(rePresented[0].content, harness.row.content);
  assert.equal(rePresented[0].metadata?.privateChatReServed, true, 'the re-served bit must reach the presentation layer');
  assert.equal(
    rePresented[0].metadata?.privateChatReServedForMessageId,
    String(harness.row.id),
    'the original private_chat_messages row id must ride along with the re-served bit'
  );

  // The wake turn itself is unchanged: wake notice in the system prompt.
  assert.equal(handle.skillTurnCalls.length, 2, 'exactly one wake turn should follow the silent decision');
  assert.ok(!handle.skillTurnCalls[0].systemPrompt.includes('Host Wake Check'), 'original turn has no wake notice');
  assert.ok(handle.skillTurnCalls[1].systemPrompt.includes('Host Wake Check'), 'wake turn carries the wake notice');
  assert.equal(harness.row.is_processed, 1);
  assert.equal(handle.createPinCount, 1, 'the owed reply is delivered on-chain');
  const delivered = harness.session.messages.find(
    (message) => message.content === 'Verification complete — here is the full reply I owed you.'
  );
  assert.equal(delivered?.metadata?.privateChatDeliveryStatus, 'sent');
});

// The decided fix forbids retroactive marking: when the original bubble is
// still in the session, the dedup guard suppresses the re-presentation and the
// EXISTING bubble must stay untouched. The silent re-drive also still re-arms
// the wake ladder (900s/7200s semantics unchanged, shrunk here for tests).
test('wake re-drive never retroactively marks the existing presentation and still re-arms while silent', async () => {
  setPrivateChatA2AWakeDelaysForTests([300, 300]);
  const harness = createWakeDispositionHarness();
  const logs = [];
  const handle = startDispositionHarnessDaemon(harness, logs, (params, call, coworkStore) => {
    const persisted = coworkStore.addMessage(params.sessionId, {
      type: 'assistant',
      content: '[NO_REPLY]',
      metadata: { isStreaming: false, isFinal: true },
    });
    return { replyText: '[NO_REPLY]', assistantMessageId: persisted.id };
  });

  try {
    await waitFor(() => logs.some((message) => message.includes('Wake budget exhausted')), 30_000);
    // No further wake may fire after exhaustion.
    await new Promise((resolve) => setTimeout(resolve, 7_000));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
    setPrivateChatA2AWakeDelaysForTests(PRIVATE_CHAT_A2A_DEFAULT_WAKE_DELAYS_MS);
  }

  // The single original inbound bubble is never duplicated nor re-marked.
  const bubbles = harness.inboundBubbles();
  assert.equal(bubbles.length, 1, 'the dedup guard keeps the re-drive from duplicating the inbound bubble');
  assert.notEqual(bubbles[0].metadata?.privateChatReServed, true, 'the original presentation must not be retroactively marked');
  assert.equal(bubbles[0].metadata?.privateChatReServedForMessageId, undefined);

  // Silent re-drive chain unchanged: original turn + 2 wake fires, re-arm
  // ladder walked to exhaustion, nothing delivered on-chain.
  assert.equal(handle.skillTurnCalls.length, 3, 'original turn + 2 wake fires, then stop');
  const wakeTurns = handle.skillTurnCalls.filter((params) => params.systemPrompt.includes('Host Wake Check'));
  assert.equal(wakeTurns.length, 2);
  assert.ok(logs.some((message) => message.includes('Wake 2 scheduled')), 'a silent wake turn still re-arms the ladder');
  assert.equal(harness.row.is_processed, 1);
  assert.equal(handle.createPinCount, 0, 'a permanently silent conversation delivers nothing on-chain');
});
