/**
 * Dream review P1 (2026-10-23), item P1-2: the private-chat direct-answer path
 * (no chat skill) injects the bot's own craft — the <knowledge> hot layer
 * (≤8 items / 2400 chars) and <procedures> (≤5 / 1800 chars) — using the same
 * builders and hot selection as the cowork runner, with hot-layer exposure
 * accounting wired like the cowork path (the nightly usage audit reads these
 * rows as evidence). Owner-memory privacy rules are untouched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Module from 'node:module';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function createPeerPublicKey() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh.getPublicKey('hex', 'uncompressed');
}

let startPrivateChatDaemon;
let stopPrivateChatDaemon;
const seenPerformChatCalls = [];
let performChatReply = 'Confirmed: all six tallies check out.';

function loadDaemonModule() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') {
      return {
        app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() },
      };
    }
    if (request === './cognitiveChatCompletion') {
      return {
        performChatCompletionForOrchestrator: async (system, user, llmId, options) => {
          seenPerformChatCalls.push({ system, user, llmId, options });
          return performChatReply;
        },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    const loaded = require('../dist-electron/main/services/privateChatDaemon.js');
    startPrivateChatDaemon = loaded.startPrivateChatDaemon;
    stopPrivateChatDaemon = loaded.stopPrivateChatDaemon;
  } finally {
    Module._load = originalLoad;
  }
}

const require = Module.createRequire(import.meta.url);
loadDaemonModule();

function createDirectAnswerHarness() {
  const row = {
    id: 1,
    pin_id: 'incoming-pin-direct-1',
    tx_id: 'a'.repeat(64),
    from_metaid: 'peer-metaid',
    from_global_metaid: 'peer-global',
    from_name: 'Peer Bot',
    from_avatar: null,
    from_chat_pubkey: createPeerPublicKey(),
    to_metaid: 'local-metaid',
    to_global_metaid: 'local-global',
    content: 'Please confirm the six tallies when you have a moment.',
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
    id: 'session-private-direct-1',
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
    // No chat skills → the direct answer path answers this row.
    allow_chat_skills: [],
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
      }
    },
  };
  const exposures = [];
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
    getRecentA2AThreadMessages(sessionId, limit = 400) {
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
      const created = { id: `msg-${session.messages.length + 1}`, timestamp: 1_770_000_000_000, ...message };
      session.messages.push(created);
      return created;
    },
    updateMessage() {},
    updateConversationMappingMetadata() {},
    getConfig() {
      return { workingDirectory: '/tmp/idbots-test' };
    },
    listInjectableTechniques() {
      return [];
    },
    recordHotLayerExposures(input) {
      exposures.push(input);
      return input.items.length;
    },
    markCapabilityDraftsInjected() {},
    getMemoryBackend() {
      return {
        getEffectiveMemoryPolicyForMetabot() {
          return { memoryEnabled: true, memoryUserMemoriesMaxItems: 12, memoryPromptMaxChars: 4000 };
        },
        listUserMemories() {
          return [];
        },
        touchUserMemoriesLastUsed() {},
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
    getMetabotWalletByMetabotId() {
      return { mnemonic: TEST_MNEMONIC, path: "m/44'/10001'/0'/0/0" };
    },
  };
  return { db, row, coworkStore, metabotStore, session, exposures };
}

async function waitFor(predicate, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('timed out waiting for private chat daemon test condition');
}

test('direct answer path injects <knowledge> and <procedures> and records hot exposures', async () => {
  const { db, row, coworkStore, metabotStore, exposures } = createDirectAnswerHarness();
  const logs = [];
  const knowledgeRows = [
    { id: 'k1', topic: '视频导出流程', summary: '先渲染预览确认无误再导出正式版。', kind: 'know_how', category: null, tags: [], version: 1, status: 'active', updatedAt: 2 },
    { id: 'k2', topic: '弱网交付', summary: '弱网下先传小体积样片再传成片。', kind: 'pitfall', category: null, tags: [], version: 1, status: 'active', updatedAt: 1 },
  ];
  const procedureRows = [
    { id: 'p1', title: '视频交付流程', triggerText: '交付视频类任务时', steps: ['先渲染预览', '再导出正式版'], pitfalls: [], sourcePinIds: [], category: null, tags: [], version: 1, status: 'active', updatedAt: 2 },
  ];
  let listKnowledgeCalls = 0;
  const getKnowledgeStore = () => ({
    listKnowledge(options) {
      listKnowledgeCalls += 1;
      assert.equal(options.hotEligibleOnly, true, 'hot pool excludes cooled entries');
      return knowledgeRows;
    },
    listHotProcedures() {
      return procedureRows;
    },
  });

  startPrivateChatDaemon(
    db,
    () => {},
    coworkStore,
    metabotStore,
    { on() {}, off() {} },
    async () => ({ txids: ['t'.repeat(64)], pinId: 'p'.repeat(64) + 'i0' }),
    (message) => logs.push(message),
    null,
    undefined,
    undefined,
    () => ({ respondToStrangerPrivateChats: true }),
    undefined,
    undefined,
    undefined,
    async () => ({ prompt: '', activeSkillIds: [] }),
    // No runPrivateChatSkillTurn → the direct answer path answers this row.
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    getKnowledgeStore,
  );

  try {
    await waitFor(() => row.is_processed === 1, 20_000);
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }

  assert.equal(seenPerformChatCalls.length, 1, 'one direct answer turn ran');
  const prompt = seenPerformChatCalls[0].system;
  assert.ok(prompt.includes('<knowledge>'), 'knowledge hot layer injected');
  assert.ok(prompt.includes('topic="视频导出流程"'), 'knowledge entry rendered');
  assert.ok(prompt.includes('<procedures>') || prompt.includes('视频交付流程'), 'procedures hot layer injected');
  assert.equal(listKnowledgeCalls, 1);
  // Exposure accounting rides along with the same semantics as cowork.
  assert.equal(exposures.length, 1);
  assert.deepEqual(
    exposures[0].items.sort((a, b) => a.id.localeCompare(b.id)),
    [
      { kind: 'knowledge', id: 'k1', exposure: 'hot' },
      { kind: 'knowledge', id: 'k2', exposure: 'hot' },
      { kind: 'procedure', id: 'p1', exposure: 'hot' },
    ].sort((a, b) => a.id.localeCompare(b.id)),
  );
  // The language contract still closes the turn prompt.
  assert.ok(prompt.trimEnd().length > 0);
});

test('direct answer path degrades to the plain prompt when the knowledge store is absent', async () => {
  seenPerformChatCalls.length = 0;
  const { db, row, coworkStore, metabotStore } = createDirectAnswerHarness();
  startPrivateChatDaemon(
    db,
    () => {},
    coworkStore,
    metabotStore,
    { on() {}, off() {} },
    async () => ({ txids: ['t'.repeat(64)], pinId: 'p'.repeat(64) + 'i0' }),
    () => {},
    null,
    undefined,
    undefined,
    () => ({ respondToStrangerPrivateChats: true }),
    undefined,
    undefined,
    undefined,
    async () => ({ prompt: '', activeSkillIds: [] }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    // No getKnowledgeStore → older wiring keeps working unchanged.
    undefined,
  );
  try {
    await waitFor(() => row.is_processed === 1, 20_000);
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }
  const prompt = seenPerformChatCalls[0].system;
  assert.ok(!prompt.includes('<knowledge>'), 'no craft blocks without the store');
});
