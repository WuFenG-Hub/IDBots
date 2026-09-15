import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

let startPrivateChatDaemon;
let stopPrivateChatDaemon;
let PRIVATE_CHAT_NO_REPLY_SENTINEL;
let isPrivateChatNoReplySentinel;
let shouldSkipPrivateChatAutoReplyText;
let extractFinalAssistantReply;
let shouldHideA2AInternalMessage;
try {
  ({
    startPrivateChatDaemon,
    stopPrivateChatDaemon,
    PRIVATE_CHAT_NO_REPLY_SENTINEL,
    isPrivateChatNoReplySentinel,
    shouldSkipPrivateChatAutoReplyText,
  } = await import('../dist-electron/main/services/privateChatDaemon.js'));
  ({ extractFinalAssistantReply } = await import('../dist-electron/main/services/orchestratorCoworkBridge.js'));
  ({ shouldHideA2AInternalMessage } = await import('../dist-electron/main/shared/a2aInternalMessageFilter.js'));
} catch {
  ({
    startPrivateChatDaemon,
    stopPrivateChatDaemon,
    PRIVATE_CHAT_NO_REPLY_SENTINEL,
    isPrivateChatNoReplySentinel,
    shouldSkipPrivateChatAutoReplyText,
  } = await import('../dist-electron/main/services/privateChatDaemon.js'));
  ({ extractFinalAssistantReply } = await import('../dist-electron/main/services/orchestratorCoworkBridge.js'));
  ({ shouldHideA2AInternalMessage } = await import('../dist-electron/main/shared/a2aInternalMessageFilter.js'));
}

test('sentinel matches exact tag with cosmetic wrapping only', () => {
  assert.equal(PRIVATE_CHAT_NO_REPLY_SENTINEL, '[NO_REPLY]');
  assert.equal(isPrivateChatNoReplySentinel('[NO_REPLY]'), true);
  assert.equal(isPrivateChatNoReplySentinel('  [NO_REPLY]  '), true);
  assert.equal(isPrivateChatNoReplySentinel('[no_reply]'), true);
  assert.equal(isPrivateChatNoReplySentinel('`[NO_REPLY]`'), true);
  assert.equal(isPrivateChatNoReplySentinel('“[NO_REPLY]”'), true);
  assert.equal(isPrivateChatNoReplySentinel('[NO_REPLY].'), true);
  assert.equal(isPrivateChatNoReplySentinel('[NO_REPLY]。'), true);
  assert.equal(isPrivateChatNoReplySentinel('[NO_REPLY]！'), true);
  // Anything with real content is a genuine reply — never silently dropped.
  assert.equal(isPrivateChatNoReplySentinel('[NO_REPLY] 好的，等我结果'), false);
  assert.equal(isPrivateChatNoReplySentinel('好的，[NO_REPLY]'), false);
  assert.equal(isPrivateChatNoReplySentinel('（保持静默。）'), false);
  assert.equal(isPrivateChatNoReplySentinel(''), false);
  assert.equal(isPrivateChatNoReplySentinel(null), false);
  assert.equal(isPrivateChatNoReplySentinel(undefined), false);
});

test('inbound sentinel from an unupgraded peer is skipped like a placeholder', () => {
  assert.equal(shouldSkipPrivateChatAutoReplyText('[NO_REPLY]'), true);
  assert.equal(shouldSkipPrivateChatAutoReplyText('[no_reply] '), true);
});

test('final-reply extraction returns the sentinel instead of walking back to earlier text', () => {
  // 2026-09-15 incident shape: an earlier decision-narration bubble, then the
  // model's final sentinel. The extractor must surface the sentinel (the
  // daemon then delivers nothing) — treating it as a "non-answer" would walk
  // backwards and broadcast the earlier internal note instead.
  const messages = [
    { id: 'm1', type: 'assistant', content: 'BOT-009 这条是工作中信号，无需回应，等他回来再接招。' },
    { id: 'm2', type: 'tool_use', content: 'Using tool: Read' },
    { id: 'm3', type: 'tool_result', content: 'ok' },
    { id: 'm4', type: 'assistant', content: '[NO_REPLY]' },
  ];
  const result = extractFinalAssistantReply(messages);
  assert.equal(result.replyText, '[NO_REPLY]');
  assert.equal(result.assistantMessageId, 'm4');
});

test('A2A view hides the persisted no-reply sentinel bubble', () => {
  const noReplyBubble = {
    type: 'assistant',
    content: '[NO_REPLY]',
    metadata: { privateChatNoReply: true, sourceChannel: 'metaweb_private' },
  };
  assert.equal(shouldHideA2AInternalMessage(noReplyBubble), true);
  // Untagged bubbles stay visible (no content heuristics on the render path).
  const deliveredBubble = {
    type: 'assistant',
    content: '（保持静默。）',
    metadata: { sourceChannel: 'metaweb_private', direction: 'outgoing' },
  };
  assert.equal(shouldHideA2AInternalMessage(deliveredBubble), false);
});

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function createPeerPublicKey() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh.getPublicKey('hex', 'uncompressed');
}

function createSentinelDaemonHarness() {
  const row = {
    id: 1,
    pin_id: 'incoming-pin-1',
    tx_id: 'a'.repeat(64),
    from_metaid: 'peer-metaid',
    from_global_metaid: 'peer-global',
    from_name: 'Peer Bot',
    from_avatar: null,
    from_chat_pubkey: createPeerPublicKey(),
    to_metaid: 'local-metaid',
    to_global_metaid: 'local-global',
    content: '（保持静默。）',
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

test('daemon delivers nothing for a sentinel reply and marks the turn silent', async () => {
  const { db, row, coworkStore, metabotStore, session } = createSentinelDaemonHarness();
  const logs = [];
  let createPinCount = 0;

  startPrivateChatDaemon(
    db,
    () => {},
    coworkStore,
    metabotStore,
    { on() {}, off() {} },
    async () => {
      createPinCount += 1;
      throw new Error('no on-chain pin should be created for a silent turn');
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
      // Mirror the real skill-turn bridge: the runner persists the model's
      // final text as an assistant bubble and returns it as the reply.
      const persisted = coworkStore.addMessage(params.sessionId, {
        type: 'assistant',
        content: '[NO_REPLY]',
        metadata: { isStreaming: false, isFinal: true },
      });
      return { replyText: '[NO_REPLY]', assistantMessageId: persisted.id };
    },
    async () => '我需要查询一下，请稍等。'
  );

  try {
    await waitFor(() => logs.some((message) => message.includes('chose silence')));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }

  assert.equal(row.is_processed, 1);
  assert.equal(createPinCount, 0);
  const outgoing = session.messages.filter((message) => message.metadata?.direction === 'outgoing');
  assert.equal(outgoing.length, 0);
  const sentinelBubble = session.messages.find((message) => message.content === '[NO_REPLY]');
  assert.equal(sentinelBubble?.metadata?.privateChatNoReply, true);
  assert.equal(sentinelBubble?.metadata?.privateChatDeliveryStatus, undefined);
});
