import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

let startPrivateChatDaemon;
let stopPrivateChatDaemon;
try {
  ({
    startPrivateChatDaemon,
    stopPrivateChatDaemon,
  } = await import('../dist-electron/main/services/privateChatDaemon.js'));
} catch {
  ({
    startPrivateChatDaemon,
    stopPrivateChatDaemon,
  } = await import('../dist-electron/services/privateChatDaemon.js'));
}

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function createPeerPublicKey() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh.getPublicKey('hex', 'uncompressed');
}

function createPrivateChatDbHarness(overrides = {}) {
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
    content: 'pop机制是怎样？',
    encryption: null,
    reply_pin: '',
    raw_data: null,
    is_processed: 0,
    ...overrides,
  };
  const columns = [
    'id',
    'pin_id',
    'tx_id',
    'from_metaid',
    'from_global_metaid',
    'from_name',
    'from_avatar',
    'from_chat_pubkey',
    'to_metaid',
    'to_global_metaid',
    'content',
    'encryption',
    'reply_pin',
    'raw_data',
  ];
  return {
    row,
    db: {
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
          assert.deepEqual(params, [row.id]);
          row.is_processed = 1;
        }
      },
    },
  };
}

function createCoworkStoreHarness() {
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

  return {
    session,
    store: {
      getConversationMapping(channel, conversationId, metabotId) {
        if (
          channel === 'metaweb_private'
          && conversationId === externalConversationId
          && metabotId === 1
        ) {
          return mapping;
        }
        return null;
      },
      getSession(sessionId) {
        return sessionId === session.id ? session : null;
      },
      ensureCanonicalPeerSessionShape() {
        return true;
      },
      touchConversationMapping() {},
      deleteConversationMapping() {},
      addMessage(sessionId, message) {
        const created = {
          id: `msg-${session.messages.length + 1}`,
          timestamp: 1_770_000_000_000 + session.messages.length,
          ...message,
        };
        assert.equal(sessionId, session.id);
        session.messages.push(created);
        return created;
      },
      updateMessage(sessionId, messageId, updates) {
        assert.equal(sessionId, session.id);
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
    },
  };
}

function createMetabotStoreHarness() {
  const metabot = {
    id: 1,
    name: 'Local Bot',
    enabled: true,
    metaid: 'local-metaid',
    globalmetaid: 'local-global',
    allow_chat_skills: ['metaid-master-wiki'],
  };
  return {
    metabot,
    store: {
      getMetabotByGlobalMetaId(globalMetaId) {
        return globalMetaId === metabot.globalmetaid ? metabot : null;
      },
      getMetabotById() {
        return null;
      },
      getMetabotWalletByMetabotId(id) {
        assert.equal(id, metabot.id);
        return {
          mnemonic: TEST_MNEMONIC,
          path: "m/44'/10001'/0'/0/0",
        };
      },
    },
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

test('regular private chat skill failures keep the inbound message retryable until a reply is sent', async () => {
  const { db, row } = createPrivateChatDbHarness();
  const { store: coworkStore, session } = createCoworkStoreHarness();
  const { metabot, store: metabotStore } = createMetabotStoreHarness();
  const logs = [];
  let saveCount = 0;
  let createPinCount = 0;

  startPrivateChatDaemon(
    db,
    () => {
      saveCount += 1;
    },
    coworkStore,
    metabotStore,
    {
      on() {},
      off() {},
    },
    async (_metabotStore, metabotId, payload) => {
      assert.equal(metabotId, metabot.id);
      createPinCount += 1;
      assert.equal(payload.path, '/protocols/simplemsg');
      const txid = 'c'.repeat(64);
      return { txids: [txid], pinId: `${txid}i0` };
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
      assert.equal(typeof params.onSkillExecutionStart, 'function');
      await params.onSkillExecutionStart();
      throw new Error('Skill turn timed out after 120s');
    },
    async () => '我需要查询一下，请稍等。',
  );

  try {
    await waitFor(() => logs.some((message) => message.includes('LLM failed for message 1')));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }

  assert.equal(row.is_processed, 0);
  assert.equal(saveCount, 0);
  assert.equal(createPinCount, 1);
  const waitNotice = session.messages.find((message) => message.metadata?.privateChatSkillWaitNotice === true);
  assert.equal(waitNotice?.content, '我需要查询一下，请稍等。');
  assert.equal(waitNotice?.metadata?.privateChatDeliveryStatus, 'sent');
});

test('regular private chat broadcast failures keep the inbound skill reply retryable', async () => {
  const { db, row } = createPrivateChatDbHarness();
  const { store: coworkStore, session } = createCoworkStoreHarness();
  const { store: metabotStore } = createMetabotStoreHarness();
  const logs = [];
  let saveCount = 0;
  let createPinCount = 0;

  startPrivateChatDaemon(
    db,
    () => {
      saveCount += 1;
    },
    coworkStore,
    metabotStore,
    {
      on() {},
      off() {},
    },
    async () => {
      createPinCount += 1;
      if (createPinCount === 1) {
        const txid = 'd'.repeat(64);
        return { txids: [txid], pinId: `${txid}i0` };
      }
      throw new Error('simulated broadcast failure');
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
      assert.equal(typeof params.onSkillExecutionStart, 'function');
      await params.onSkillExecutionStart();
      return {
        replyText: 'PoP 的全称是 Proof of PIN',
        assistantMessageId: null,
      };
    },
    async () => '我需要查询一下，请稍等。',
  );

  try {
    await waitFor(() => logs.some((message) => message.includes('Failed to broadcast reply')));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }

  const assistantMessage = session.messages.find((message) => (
    message.type === 'assistant'
    && message.metadata?.privateChatSkillWaitNotice !== true
  ));
  assert.equal(row.is_processed, 0);
  assert.equal(saveCount, 0);
  assert.equal(createPinCount, 2);
  const waitNotice = session.messages.find((message) => message.metadata?.privateChatSkillWaitNotice === true);
  assert.equal(waitNotice?.metadata?.privateChatDeliveryStatus, 'sent');
  assert.equal(assistantMessage?.metadata?.privateChatDeliveryStatus, 'failed');
  assert.match(String(assistantMessage?.metadata?.privateChatDeliveryError || ''), /simulated broadcast failure/);
});

test('regular private chat replies emit markdown simplemsg payloads without changing the outer pin content type', async () => {
  const { db, row } = createPrivateChatDbHarness();
  const { store: coworkStore } = createCoworkStoreHarness();
  const { metabot, store: metabotStore } = createMetabotStoreHarness();
  const logs = [];
  const txid = 'b'.repeat(64);
  let saveCount = 0;
  let capturedCreatePinPayload = null;

  startPrivateChatDaemon(
    db,
    () => {
      saveCount += 1;
    },
    coworkStore,
    metabotStore,
    {
      on() {},
      off() {},
    },
    async (_metabotStore, metabotId, payload) => {
      assert.equal(metabotId, metabot.id);
      capturedCreatePinPayload = payload;
      return { txids: [txid], pinId: `${txid}i0` };
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
    async () => ({
      replyText: 'PoP 的全称是 **Proof of PIN**',
      assistantMessageId: null,
    }),
  );

  try {
    await waitFor(() => logs.some((message) => message.includes('Replied to')));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }

  assert.equal(row.is_processed, 1);
  assert.equal(saveCount, 1);
  assert.equal(capturedCreatePinPayload?.path, '/protocols/simplemsg');
  assert.equal(capturedCreatePinPayload?.contentType, 'application/json');

  const simplemsgPayload = JSON.parse(String(capturedCreatePinPayload?.payload || ''));
  assert.deepEqual(
    Object.keys(simplemsgPayload).sort(),
    ['content', 'contentType', 'encrypt', 'replyPin', 'timestamp', 'to'].sort(),
  );
  assert.equal(simplemsgPayload.to, 'peer-global');
  assert.equal(typeof simplemsgPayload.timestamp, 'number');
  assert.equal(typeof simplemsgPayload.content, 'string');
  assert.ok(simplemsgPayload.content.length > 0);
  assert.equal(simplemsgPayload.contentType, 'text/markdown');
  assert.equal(simplemsgPayload.encrypt, 'ecdh');
  assert.equal(simplemsgPayload.replyPin, '');
});

test('regular private chat does not send a wait notice when no local skill actually runs', async () => {
  const { db, row } = createPrivateChatDbHarness({
    pin_id: 'incoming-pin-gm',
    tx_id: '9'.repeat(64),
    content: 'gm',
  });
  const { store: coworkStore, session } = createCoworkStoreHarness();
  const { metabot, store: metabotStore } = createMetabotStoreHarness();
  const logs = [];
  const events = [];
  const capturedCreatePinPayloads = [];
  let saveCount = 0;

  startPrivateChatDaemon(
    db,
    () => {
      saveCount += 1;
    },
    coworkStore,
    metabotStore,
    {
      on() {},
      off() {},
    },
    async (_metabotStore, metabotId, payload) => {
      assert.equal(metabotId, metabot.id);
      events.push('createPin');
      capturedCreatePinPayloads.push(payload);
      const txid = `${capturedCreatePinPayloads.length}`.repeat(64).slice(0, 64);
      return { txids: [txid], pinId: `${txid}i0` };
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
      events.push('skill-runner');
      return {
        replyText: 'gm',
        assistantMessageId: null,
      };
    },
    async () => {
      events.push('notice-generated');
      return '我需要查询一下，请稍等。';
    },
  );

  try {
    await waitFor(() => logs.some((message) => message.includes('Replied to')));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }

  assert.equal(row.is_processed, 1);
  assert.equal(saveCount, 1);
  assert.deepEqual(events, ['skill-runner', 'createPin']);
  assert.equal(capturedCreatePinPayloads.length, 1);

  const assistantMessages = session.messages.filter((message) => message.type === 'assistant');
  assert.equal(assistantMessages.length, 1);
  assert.equal(assistantMessages[0].content, 'gm');
  assert.equal(assistantMessages.some((message) => message.metadata?.privateChatSkillWaitNotice === true), false);
});

test('regular private chat sends a wait notice before running a local chat skill', async () => {
  const { db, row } = createPrivateChatDbHarness();
  const { store: coworkStore, session } = createCoworkStoreHarness();
  const { metabot, store: metabotStore } = createMetabotStoreHarness();
  const logs = [];
  const events = [];
  const capturedCreatePinPayloads = [];
  let saveCount = 0;

  startPrivateChatDaemon(
    db,
    () => {
      saveCount += 1;
    },
    coworkStore,
    metabotStore,
    {
      on() {},
      off() {},
    },
    async (_metabotStore, metabotId, payload) => {
      assert.equal(metabotId, metabot.id);
      events.push('createPin');
      capturedCreatePinPayloads.push(payload);
      const txid = `${capturedCreatePinPayloads.length}`.repeat(64).slice(0, 64);
      return { txids: [txid], pinId: `${txid}i0` };
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
      events.push('skill-runner');
      assert.equal(typeof params.onSkillExecutionStart, 'function');
      await params.onSkillExecutionStart();
      events.push('skill-start');
      return {
        replyText: 'PoP 的全称是 Proof of PIN',
        assistantMessageId: null,
      };
    },
    async () => {
      events.push('notice-generated');
      return '我需要查询一下，请稍等。';
    },
  );

  try {
    await waitFor(() => logs.some((message) => message.includes('Replied to')));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }

  assert.equal(row.is_processed, 1);
  assert.equal(saveCount, 1);
  assert.deepEqual(events, ['skill-runner', 'notice-generated', 'createPin', 'skill-start', 'createPin']);
  assert.equal(capturedCreatePinPayloads.length, 2);
  assert.ok(capturedCreatePinPayloads.every((payload) => payload.path === '/protocols/simplemsg'));

  const assistantMessages = session.messages.filter((message) => message.type === 'assistant');
  assert.equal(assistantMessages.length, 2);
  assert.equal(assistantMessages[0].content, '我需要查询一下，请稍等。');
  assert.equal(assistantMessages[0].metadata?.privateChatSkillWaitNotice, true);
  assert.equal(assistantMessages[0].metadata?.privateChatDeliveryStatus, 'sent');
  assert.equal(assistantMessages[1].content, 'PoP 的全称是 Proof of PIN');
});

test('regular private chat skill turn consumes queued A2A guidance once', async () => {
  const { db, row } = createPrivateChatDbHarness({
    pin_id: 'incoming-pin-guidance',
    tx_id: '8'.repeat(64),
    content: '请继续说说。',
  });
  const { store: coworkStore } = createCoworkStoreHarness();
  const { metabot, store: metabotStore } = createMetabotStoreHarness();
  const logs = [];
  let saveCount = 0;
  let consumedCount = 0;
  let capturedSystemPrompt = '';

  startPrivateChatDaemon(
    db,
    () => {
      saveCount += 1;
    },
    coworkStore,
    metabotStore,
    {
      on() {},
      off() {},
    },
    async (_metabotStore, metabotId, payload) => {
      assert.equal(metabotId, metabot.id);
      assert.equal(payload.path, '/protocols/simplemsg');
      const txid = '8'.repeat(64);
      return { txids: [txid], pinId: `${txid}i0` };
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
      capturedSystemPrompt = params.systemPrompt;
      return {
        replyText: '我会先聚焦预算范围。',
        assistantMessageId: null,
      };
    },
    async () => '我需要查询一下，请稍等。',
    (sessionId, metabotId) => {
      assert.equal(sessionId, 'session-private-1');
      assert.equal(metabotId, 1);
      consumedCount += 1;
      return consumedCount === 1 ? '下一轮先追问预算范围。' : null;
    },
  );

  try {
    await waitFor(() => logs.some((message) => message.includes('Replied to')));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }

  assert.equal(row.is_processed, 1);
  assert.equal(saveCount, 1);
  assert.equal(consumedCount, 1);
  assert.match(capturedSystemPrompt, /Human Operator Guidance/);
  assert.match(capturedSystemPrompt, /下一轮先追问预算范围。/);
});
