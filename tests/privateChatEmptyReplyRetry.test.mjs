import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

let startPrivateChatDaemon;
let stopPrivateChatDaemon;
let buildPrivateChatEmptyReplyRetryNotice;
try {
  ({
    startPrivateChatDaemon,
    stopPrivateChatDaemon,
    buildPrivateChatEmptyReplyRetryNotice,
  } = await import('../dist-electron/main/services/privateChatDaemon.js'));
} catch {
  ({
    startPrivateChatDaemon,
    stopPrivateChatDaemon,
    buildPrivateChatEmptyReplyRetryNotice,
  } = await import('../dist-electron/main/services/privateChatDaemon.js'));
}

test('empty-reply retry notice names the attempt, the deliverable shape, and the sentinel exit', () => {
  const notice = buildPrivateChatEmptyReplyRetryNotice(2);
  assert.ok(notice.includes('attempt 2'), 'notice should name the attempt');
  assert.ok(notice.includes('outside any thinking block'), 'notice should require final text outside thinking');
  assert.ok(notice.includes('[NO_REPLY]'), 'notice should offer the sentinel as the legal silent exit');
  // Degenerate attempt numbers fall back to 1 instead of leaking NaN.
  assert.ok(buildPrivateChatEmptyReplyRetryNotice(Number.NaN).includes('attempt 1'));
});

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function createPeerPublicKey() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh.getPublicKey('hex', 'uncompressed');
}

function createEmptyReplyDaemonHarness() {
  const row = {
    id: 1,
    pin_id: 'incoming-pin-empty-retry-1',
    tx_id: 'a'.repeat(64),
    from_metaid: 'peer-metaid',
    from_global_metaid: 'peer-global',
    from_name: 'Peer Bot',
    from_avatar: null,
    from_chat_pubkey: createPeerPublicKey(),
    to_metaid: 'local-metaid',
    to_global_metaid: 'local-global',
    content: 'The verification anchors are ready — please confirm the six tallies.',
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
  return { db, row, coworkStore, metabotStore, metabot, session };
}

async function waitFor(predicate, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('timed out waiting for private chat daemon test condition');
}

// 2026-09-16 stall shape: the first turn completes normally but the model
// emitted reasoning only (no final text), which used to be silently dropped
// with markProcessed — the peer then waited forever. The daemon must keep the
// row unprocessed, surface a retry notice, and re-run the turn with the host
// protocol notice appended to the system prompt.
test('daemon retries a reasoning-only turn and delivers the retried reply', async () => {
  const { db, row, coworkStore, metabotStore, session } = createEmptyReplyDaemonHarness();
  const logs = [];
  let createPinCount = 0;
  let skillTurnCalls = 0;
  const seenSystemPrompts = [];

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
    async () => ({
      prompt: '<available_skills><skill><id>metaid-master-wiki</id></skill></available_skills>',
      activeSkillIds: ['metaid-master-wiki'],
    }),
    async (params) => {
      skillTurnCalls += 1;
      seenSystemPrompts.push(params.systemPrompt);
      if (skillTurnCalls === 1) {
        // Reasoning-only completion: the whole draft stays inside a thinking
        // bubble and extractFinalAssistantReply correctly returns ''.
        coworkStore.addMessage(params.sessionId, {
          type: 'assistant',
          content: 'draft of the full answer, never emitted as final text',
          metadata: { isThinking: true, isStreaming: false, isFinal: true },
        });
        return { replyText: '', assistantMessageId: null };
      }
      const persisted = coworkStore.addMessage(params.sessionId, {
        type: 'assistant',
        content: 'Confirmed: all six tallies check out.',
        metadata: { isStreaming: false, isFinal: true },
      });
      return { replyText: 'Confirmed: all six tallies check out.', assistantMessageId: persisted.id };
    },
    async () => '我需要查询一下，请稍等。'
  );

  try {
    await waitFor(() => logs.some((message) => message.includes('without final reply text')), 20_000);
    // The peer message must stay unprocessed and a host notice bubble must be
    // visible in the session while the retry is pending.
    assert.equal(row.is_processed, 0);
    assert.ok(
      session.messages.some((message) => message.metadata?.privateChatReplyRetryNotice === true),
      'a host retry-notice bubble should be persisted for owner visibility'
    );
    assert.equal(createPinCount, 0);

    // Backoff for the first retry is 15s; the retried turn should then run
    // with the protocol notice and deliver on-chain.
    await waitFor(() => logs.some((message) => message.includes('Replied to')), 60_000);
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }

  assert.equal(skillTurnCalls, 2);
  assert.ok(!seenSystemPrompts[0].includes('Host Retry Notice'), 'first attempt uses the plain prompt');
  assert.ok(seenSystemPrompts[1].includes('Host Retry Notice'), 'retry appends the host protocol notice');
  assert.ok(seenSystemPrompts[1].includes('outside any thinking block'));
  assert.equal(row.is_processed, 1);
  assert.equal(createPinCount, 1);
  const delivered = session.messages.find((message) => message.content === 'Confirmed: all six tallies check out.');
  assert.equal(delivered?.metadata?.privateChatDeliveryStatus, 'sent');
});
