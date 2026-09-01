import test from 'node:test';
import assert from 'node:assert/strict';

let appendPrivateChatA2AMessage;
let endPrivateChatA2AConversation;
let analyzePrivateChatA2AConversation;
let buildPrivateChatA2ASystemPrompt;
let waitBeforePrivateChatReply;
let getPrivateChatReplyDelayMs;
let shouldKeepPrivateChatConversationClosedAfterBye;
let shouldDisplayInboundPrivateChatWhileClosed;
let shouldSkipPrivateChatAutoReplyText;
let hasNewerPrivateChatMessage;
let evaluatePrivateChatAutoReplyPolicy;
let hasPriorNonHandshakePrivateChatOutbound;
let hasPriorPrivateChatA2AOutbound;
let buildPrivateChatA2AChainMetadata;
let isPrivateChatHandshakePlaintext;
let shouldContinuePrivateChatInboundAfterOutgoingSync;
try {
  ({
    appendPrivateChatA2AMessage,
    endPrivateChatA2AConversation,
    analyzePrivateChatA2AConversation,
    buildPrivateChatA2ASystemPrompt,
    waitBeforePrivateChatReply,
    getPrivateChatReplyDelayMs,
    shouldKeepPrivateChatConversationClosedAfterBye,
    shouldDisplayInboundPrivateChatWhileClosed,
    shouldSkipPrivateChatAutoReplyText,
    hasNewerPrivateChatMessage,
    evaluatePrivateChatAutoReplyPolicy,
    hasPriorNonHandshakePrivateChatOutbound,
    hasPriorPrivateChatA2AOutbound,
    buildPrivateChatA2AChainMetadata,
    isPrivateChatHandshakePlaintext,
    shouldContinuePrivateChatInboundAfterOutgoingSync,
  } = await import('../dist-electron/main/services/privateChatDaemon.js'));
} catch {
  ({
    appendPrivateChatA2AMessage,
    endPrivateChatA2AConversation,
    analyzePrivateChatA2AConversation,
    buildPrivateChatA2ASystemPrompt,
    waitBeforePrivateChatReply,
    getPrivateChatReplyDelayMs,
    shouldKeepPrivateChatConversationClosedAfterBye,
    shouldDisplayInboundPrivateChatWhileClosed,
    shouldSkipPrivateChatAutoReplyText,
    hasNewerPrivateChatMessage,
    evaluatePrivateChatAutoReplyPolicy,
    hasPriorNonHandshakePrivateChatOutbound,
    hasPriorPrivateChatA2AOutbound,
    buildPrivateChatA2AChainMetadata,
    isPrivateChatHandshakePlaintext,
    shouldContinuePrivateChatInboundAfterOutgoingSync,
  } = await import('../dist-electron/services/privateChatDaemon.js'));
}

let a2aChatLimits;
try {
  a2aChatLimits = await import('../dist-electron/main/services/a2aChatLimits.js');
} catch {
  a2aChatLimits = await import('../dist-electron/services/a2aChatLimits.js');
}
const {
  normalizeA2AMaxIncomingTurns,
  normalizeA2AByeCooldownMs,
  normalizeA2AAutoReplyEnabled,
  deriveA2AClosingPhaseTurns,
} = a2aChatLimits;

function createCoworkStoreHarness() {
  const stored = [];
  return {
    stored,
    coworkStore: {
      // appendPrivateChatA2AMessage consults session state for the stale-error
      // heal; a null session makes the heal a no-op in this harness.
      getSessionWithoutMessages: () => null,
      addMessage(sessionId, message) {
        const created = {
          id: `msg-${stored.length + 1}`,
          timestamp: 1_770_000_000_000 + stored.length,
          ...message,
        };
        stored.push({ sessionId, message: created });
        return created;
      },
    },
  };
}

test('regular private chat A2A messages are emitted live with display direction metadata', () => {
  const { coworkStore, stored } = createCoworkStoreHarness();
  const emitted = [];
  const emitToRenderer = (channel, data) => emitted.push({ channel, data });

  const incoming = appendPrivateChatA2AMessage({
    coworkStore,
    sessionId: 'session-private-1',
    externalConversationId: 'metaweb-private:peer-global-1',
    type: 'user',
    content: '你好呀',
    senderGlobalMetaId: 'peer-global-1',
    senderName: 'Sunny',
    senderAvatar: '/content/avatar.png',
    emitToRenderer,
  });
  const outgoing = appendPrivateChatA2AMessage({
    coworkStore,
    sessionId: 'session-private-1',
    externalConversationId: 'metaweb-private:peer-global-1',
    type: 'assistant',
    content: '你好，我在。',
    emitToRenderer,
  });

  assert.equal(stored.length, 2);
  assert.equal(incoming.metadata.sourceChannel, 'metaweb_private');
  assert.equal(incoming.metadata.externalConversationId, 'metaweb-private:peer-global-1');
  assert.equal(incoming.metadata.direction, 'incoming');
  assert.equal(incoming.metadata.senderGlobalMetaId, 'peer-global-1');
  assert.equal(incoming.metadata.senderName, 'Sunny');
  assert.equal(incoming.metadata.senderAvatar, '/content/avatar.png');
  assert.equal(incoming.metadata.suppressRunningStatus, true);
  assert.equal(outgoing.metadata.direction, 'outgoing');

  assert.deepEqual(emitted, [
    {
      channel: 'cowork:stream:message',
      data: { sessionId: 'session-private-1', message: incoming },
    },
    {
      channel: 'cowork:stream:message',
      data: { sessionId: 'session-private-1', message: outgoing },
    },
  ]);
});

test('private chat A2A chain metadata normalizes txid and pin ids for bubble display', () => {
  const txid = '56ddbdab' + 'c'.repeat(56);

  assert.deepEqual(
    buildPrivateChatA2AChainMetadata({
      txId: txid.toUpperCase(),
      pinId: `${txid}i0`,
    }),
    {
      txid,
      txids: [txid],
      pinId: `${txid}i0`,
    },
  );

  const fallbackTxid = 'a'.repeat(64);
  assert.deepEqual(
    buildPrivateChatA2AChainMetadata({
      txids: [fallbackTxid],
      pinId: `${fallbackTxid}i0`,
    }),
    {
      txid: fallbackTxid,
      txids: [fallbackTxid],
      pinId: `${fallbackTxid}i0`,
    },
  );
});

test('ending a private chat A2A conversation marks the mapping closed and emits the local bye turn', () => {
  const emitted = [];
  const metadataUpdates = [];
  const addedMessages = [];
  const session = {
    id: 'session-private-1',
    sessionType: 'a2a',
    metabotId: 7,
    peerGlobalMetaId: 'peer-global-1',
  };
  const mapping = {
    channel: 'metaweb_private',
    externalConversationId: 'metaweb-private:peer-global-1',
    metabotId: 7,
    coworkSessionId: 'session-private-1',
    metadataJson: JSON.stringify({ peerGlobalMetaId: 'peer-global-1', peerName: 'Peer Bot' }),
  };
  const coworkStore = {
    getSessionWithoutMessages(id) {
      return id === session.id ? session : null;
    },
    getConversationSourceContextBySession(id) {
      assert.equal(id, session.id);
      return {
        sourceChannel: 'metaweb_private',
        externalConversationId: mapping.externalConversationId,
      };
    },
    getConversationMapping(channel, externalConversationId, metabotId) {
      assert.equal(channel, 'metaweb_private');
      assert.equal(externalConversationId, mapping.externalConversationId);
      assert.equal(metabotId, 7);
      return mapping;
    },
    updateConversationMappingMetadata(channel, externalConversationId, metabotId, metadata) {
      metadataUpdates.push({ channel, externalConversationId, metabotId, metadata });
    },
    updateSession(id, updates) {
      assert.equal(id, session.id);
      session.status = updates.status;
    },
    addMessage(sessionId, message) {
      const created = {
        id: `end-msg-${addedMessages.length + 1}`,
        timestamp: 1_770_000_000_000 + addedMessages.length,
        ...message,
      };
      addedMessages.push({ sessionId, message: created });
      return created;
    },
  };

  const result = endPrivateChatA2AConversation({
    coworkStore,
    sessionId: session.id,
    now: () => 1_770_000_000_000,
    emitToRenderer: (channel, data) => emitted.push({ channel, data }),
  });

  assert.equal(result.success, true);
  assert.equal(result.externalConversationId, mapping.externalConversationId);
  assert.equal(result.peerGlobalMetaId, 'peer-global-1');
  assert.deepEqual(metadataUpdates, [{
    channel: 'metaweb_private',
    externalConversationId: mapping.externalConversationId,
    metabotId: 7,
    metadata: {
      peerGlobalMetaId: 'peer-global-1',
      peerName: 'Peer Bot',
      byeSent: true,
      endedByHuman: true,
      endedAt: 1_770_000_000_000,
    },
  }]);
  assert.equal(session.status, 'completed');
  assert.equal(addedMessages.length, 2);
  assert.equal(addedMessages[0].message.content, 'bye');
  assert.equal(addedMessages[0].message.metadata.direction, 'outgoing');
  assert.equal(addedMessages[0].message.metadata.a2aConversationEnded, true);
  assert.match(addedMessages[1].message.content, /已结束/);
  assert.equal(addedMessages[1].message.metadata.a2aConversationEndSystemNotice, true);
  assert.deepEqual(emitted.map((entry) => entry.channel), [
    'cowork:stream:message',
    'cowork:stream:message',
    'cowork:stream:complete',
  ]);
});

test('private chat replies do not wait based on active incoming turn count', async () => {
  assert.equal(getPrivateChatReplyDelayMs(1), 0);
  assert.equal(getPrivateChatReplyDelayMs(5), 0);
  assert.equal(getPrivateChatReplyDelayMs(6), 0);
  assert.equal(getPrivateChatReplyDelayMs(10), 0);
  assert.equal(getPrivateChatReplyDelayMs(11), 0);
  assert.equal(getPrivateChatReplyDelayMs(20), 0);
  assert.equal(getPrivateChatReplyDelayMs(21), 0);
  assert.equal(getPrivateChatReplyDelayMs(30), 0);
  assert.equal(getPrivateChatReplyDelayMs(50), 0);

  const delays = [];
  await waitBeforePrivateChatReply(21, (ms) => {
    delays.push(ms);
    return Promise.resolve();
  });

  assert.deepEqual(delays, []);
});

test('auto-bye private chat conversations reopen after five minutes', () => {
  const endedAt = 1_770_000_000_000;

  assert.equal(
    shouldKeepPrivateChatConversationClosedAfterBye({
      mappingMeta: { byeSent: true, endedByAutoPolicy: true, endedAt },
      now: endedAt + 4 * 60_000 + 59_000,
    }),
    true,
  );
  assert.equal(
    shouldKeepPrivateChatConversationClosedAfterBye({
      mappingMeta: { byeSent: true, endedByAutoPolicy: true, endedAt },
      now: endedAt + 5 * 60_000 + 1_000,
    }),
    false,
  );
  assert.equal(
    shouldKeepPrivateChatConversationClosedAfterBye({
      mappingMeta: { byeSent: true, endedByHuman: true, endedAt },
      now: endedAt + 60 * 60_000,
    }),
    true,
  );
});

test('closed private chat still displays inbound remote messages while auto-reply remains suppressed', () => {
  const endedAt = 1_770_000_000_000;

  assert.equal(
    shouldDisplayInboundPrivateChatWhileClosed({
      mappingMeta: { byeSent: true, endedByAutoPolicy: true, endedAt },
      now: endedAt + 4 * 60_000,
    }),
    true,
  );
  assert.equal(
    shouldDisplayInboundPrivateChatWhileClosed({
      mappingMeta: { byeSent: true, endedByHuman: true, endedAt },
      now: endedAt + 4 * 60_000,
    }),
    true,
  );
  assert.equal(
    shouldDisplayInboundPrivateChatWhileClosed({
      mappingMeta: { byeSent: true, endedByAutoPolicy: true, endedAt },
      now: endedAt + 5 * 60_000 + 1_000,
    }),
    false,
  );
});

test('private chat prompt includes recent A2A context and topic-ending policy', () => {
  const analysis = analyzePrivateChatA2AConversation({
    messages: [
      {
        id: 'm1',
        type: 'user',
        content: '我们讨论一下比特币生态的索引器吧',
        timestamp: 1_770_000_000_000,
        metadata: { direction: 'incoming', sourceChannel: 'metaweb_private', senderName: 'Peer Bot' },
      },
      {
        id: 'm2',
        type: 'assistant',
        content: '可以，先从链上数据可用性说起。',
        timestamp: 1_770_000_001_000,
        metadata: { direction: 'outgoing', sourceChannel: 'metaweb_private' },
      },
      {
        id: 'm3',
        type: 'user',
        content: '那缓存策略呢？',
        timestamp: 1_770_000_002_000,
        metadata: { direction: 'incoming', sourceChannel: 'metaweb_private', senderName: 'Peer Bot' },
      },
    ],
    now: 1_770_000_002_000,
  });

  const prompt = buildPrivateChatA2ASystemPrompt({
    metabot: {
      name: 'Local Bot',
      role: 'Technical partner',
      soul: 'direct',
      goal: 'useful discussion',
      background: 'MetaID',
    },
    memoryContext: '<contactMemories />',
    analysis,
  });

  assert.match(prompt, /private-chat MetaBot/);
  assert.match(prompt, /valuable discussion/i);
  assert.match(prompt, /coherent topic/i);
  assert.match(prompt, /do not need to reply to every message/i);
  assert.match(prompt, /latest meaningful message/i);
  assert.match(prompt, /Thinking\.\.\./);
  assert.match(prompt, /\.\.\.\./);
  assert.match(prompt, /say exactly "bye"/i);
  assert.match(prompt, /30 turns/i);
  assert.match(prompt, /Peer Bot: 我们讨论一下比特币生态的索引器吧/);
  assert.match(prompt, /Local Bot: 可以，先从链上数据可用性说起。/);
  assert.match(prompt, /Peer Bot: 那缓存策略呢？/);
  assert.match(prompt, /<contactMemories \/>/);
});

test('private chat A2A analysis ignores internal order execution trace messages', () => {
  const analysis = analyzePrivateChatA2AConversation({
    messages: [
      {
        id: 'm1',
        type: 'user',
        content: '请生成头像',
        timestamp: 1_770_000_000_000,
        metadata: { direction: 'incoming', sourceChannel: 'metaweb_private', senderName: 'Peer Bot' },
      },
      {
        id: 'm2',
        type: 'assistant',
        content: '正在读取图片生成技能。',
        timestamp: 1_770_000_001_000,
        metadata: {
          sourceChannel: 'metaweb_private',
          orderExecutionTrace: true,
          excludeFromSandboxHistory: true,
        },
      },
      {
        id: 'm3',
        type: 'assistant',
        content: '头像已生成。',
        timestamp: 1_770_000_002_000,
        metadata: { direction: 'outgoing', sourceChannel: 'metaweb_private' },
      },
    ],
    now: 1_770_000_002_000,
  });

  assert.deepEqual(
    analysis.contextMessages.map((message) => message.content),
    ['请生成头像', '头像已生成。'],
  );
});

test('private chat A2A analysis ignores transport handshake messages', () => {
  const analysis = analyzePrivateChatA2AConversation({
    messages: [
      {
        id: 'ping',
        type: 'assistant',
        content: 'ping',
        timestamp: 1_770_000_000_000,
        metadata: {
          direction: 'outgoing',
          sourceChannel: 'metaweb_private',
          simplemsgKind: 'private_chat',
        },
      },
      {
        id: 'pong',
        type: 'user',
        content: 'pong',
        timestamp: 1_770_000_001_000,
        metadata: {
          direction: 'incoming',
          sourceChannel: 'metaweb_private',
          simplemsgKind: 'private_chat',
        },
      },
      {
        id: 'real',
        type: 'user',
        content: '请查一下北京天气',
        timestamp: 1_770_000_002_000,
        metadata: { direction: 'incoming', sourceChannel: 'metaweb_private' },
      },
    ],
    now: 1_770_000_002_000,
  });

  assert.deepEqual(
    analysis.contextMessages.map((message) => message.content),
    ['请查一下北京天气'],
  );
  assert.equal(analysis.incomingTurnCount, 1);
});

test('regular private chat skips placeholder latest messages without an LLM reply', () => {
  assert.equal(shouldSkipPrivateChatAutoReplyText('Thinking...'), true);
  assert.equal(shouldSkipPrivateChatAutoReplyText(' thinking… '), true);
  assert.equal(shouldSkipPrivateChatAutoReplyText('....'), true);
  assert.equal(shouldSkipPrivateChatAutoReplyText('……'), true);
  assert.equal(shouldSkipPrivateChatAutoReplyText('bye'), true);
  assert.equal(shouldSkipPrivateChatAutoReplyText('I am thinking about indexer caching.'), false);
  assert.equal(shouldSkipPrivateChatAutoReplyText('Can you compare these options?'), false);
});

test('private chat handshake plaintext is classified as transport-only', () => {
  assert.equal(isPrivateChatHandshakePlaintext('ping'), true);
  assert.equal(isPrivateChatHandshakePlaintext(' pong! '), true);
  assert.equal(isPrivateChatHandshakePlaintext('Ping.'), true);
  assert.equal(isPrivateChatHandshakePlaintext('[ORDER] ping'), false);
  assert.equal(isPrivateChatHandshakePlaintext('ping the seller after delivery'), false);
});

test('local-to-local outgoing simplemsg continues through inbound recipient handling', () => {
  assert.equal(
    shouldContinuePrivateChatInboundAfterOutgoingSync({
      senderMetabotId: 2,
      recipientMetabotId: 1,
    }),
    true,
  );
  assert.equal(
    shouldContinuePrivateChatInboundAfterOutgoingSync({
      senderMetabotId: 2,
      recipientMetabotId: null,
    }),
    false,
  );
  assert.equal(
    shouldContinuePrivateChatInboundAfterOutgoingSync({
      senderMetabotId: 2,
      recipientMetabotId: 2,
    }),
    false,
  );
});

test('regular private chat skips older turns when a newer peer message exists', () => {
  const execCalls = [];
  const db = {
    exec(sql, params) {
      execCalls.push({ sql, params });
      return [{ columns: ['found'], values: [[1]] }];
    },
  };

  assert.equal(
    hasNewerPrivateChatMessage(db, {
      currentRowId: 10,
      fromGlobalMetaId: 'peer-global',
      fromMetaId: 'peer-meta',
      toGlobalMetaId: 'local-global',
      toMetaId: 'local-meta',
    }),
    true,
  );
  assert.match(execCalls[0].sql, /private_chat_messages/);
  assert.match(execCalls[0].sql, /id > \?/);
  assert.deepEqual(execCalls[0].params, [
    10,
    'peer-global',
    'peer-meta',
    'local-global',
    'local-meta',
  ]);
});

test('private chat analysis keeps one active segment within five minutes', () => {
  const base = 1_770_000_000_000;
  const analysis = analyzePrivateChatA2AConversation({
    messages: [
      {
        id: 'before-gap',
        type: 'user',
        content: 'previous topic still relevant',
        timestamp: base,
        metadata: { direction: 'incoming', sourceChannel: 'metaweb_private' },
      },
      {
        id: 'within-gap',
        type: 'user',
        content: 'continue after four minutes',
        timestamp: base + 4 * 60_000,
        metadata: { direction: 'incoming', sourceChannel: 'metaweb_private' },
      },
    ],
    now: base + 4 * 60_000,
  });

  assert.equal(analysis.incomingTurnCount, 2);
  assert.deepEqual(
    analysis.contextMessages.map((message) => message.content),
    ['previous topic still relevant', 'continue after four minutes'],
  );
});

test('private chat analysis requests bye at fifty incoming turns and carries prior context after inactivity', () => {
  const base = 1_770_000_000_000;
  const longRun = Array.from({ length: 50 }, (_value, index) => ({
    id: `incoming-${index + 1}`,
    type: 'user',
    content: `turn ${index + 1}`,
    timestamp: base + index * 10_000,
    metadata: { direction: 'incoming', sourceChannel: 'metaweb_private' },
  }));

  const longRunAnalysis = analyzePrivateChatA2AConversation({
    messages: longRun,
    now: base + 500_000,
  });
  assert.equal(longRunAnalysis.shouldForceBye, true);
  assert.equal(longRunAnalysis.incomingTurnCount, 50);

  const resetAnalysis = analyzePrivateChatA2AConversation({
    messages: [
      ...longRun,
      {
        id: 'after-gap',
        type: 'user',
        content: 'new topic after a long gap',
        timestamp: base + 50 * 10_000 + 6 * 60_000,
        metadata: { direction: 'incoming', sourceChannel: 'metaweb_private' },
      },
    ],
    now: base + 50 * 10_000 + 6 * 60_000,
  });

  assert.equal(resetAnalysis.shouldForceBye, false);
  assert.equal(resetAnalysis.incomingTurnCount, 1);
  assert.deepEqual(
    resetAnalysis.contextMessages.map((message) => message.content),
    [
      ...Array.from({ length: 20 }, (_value, index) => `turn ${31 + index}`),
      'new topic after a long gap',
    ],
  );
});

test('private chat analysis resets after an outgoing bye', () => {
  const analysis = analyzePrivateChatA2AConversation({
    messages: [
      {
        id: 'before-bye',
        type: 'user',
        content: 'old topic',
        timestamp: 1_770_000_000_000,
        metadata: { direction: 'incoming', sourceChannel: 'metaweb_private' },
      },
      {
        id: 'bye',
        type: 'assistant',
        content: 'bye',
        timestamp: 1_770_000_001_000,
        metadata: { direction: 'outgoing', sourceChannel: 'metaweb_private' },
      },
      {
        id: 'after-bye',
        type: 'user',
        content: 'new topic',
        timestamp: 1_770_000_002_000,
        metadata: { direction: 'incoming', sourceChannel: 'metaweb_private' },
      },
    ],
    now: 1_770_000_002_000,
  });

  assert.equal(analysis.incomingTurnCount, 1);
  assert.deepEqual(analysis.contextMessages.map((message) => message.content), ['new topic']);
});

test('regular private chat auto-reply policy blocks strangers when the global switch is off', () => {
  const result = evaluatePrivateChatAutoReplyPolicy({
    metabot: {
      enabled: true,
      boss_id: null,
      boss_global_metaid: null,
      globalmetaid: 'local-global',
      metaid: 'local-meta',
    },
    senderGlobalMetaId: 'peer-global',
    senderMetaId: 'peer-meta',
    listenerConfig: {
      enabled: true,
      groupChats: false,
      privateChats: true,
      serviceRequests: false,
      respondToStrangerPrivateChats: false,
    },
    metabotStore: {
      getMetabotById() {
        throw new Error('boss lookup should not be needed');
      },
    },
    hasPriorLocalOutbound: false,
  });

  assert.deepEqual(result, {
    shouldReply: false,
    reason: 'stranger_blocked',
  });
});

test('regular private chat auto-reply policy lets owners and known peers bypass the stranger switch', () => {
  const base = {
    metabot: {
      enabled: true,
      boss_id: 42,
      boss_global_metaid: null,
      globalmetaid: 'local-global',
      metaid: 'local-meta',
    },
    listenerConfig: {
      enabled: true,
      groupChats: false,
      privateChats: true,
      serviceRequests: false,
      respondToStrangerPrivateChats: false,
    },
    metabotStore: {
      getMetabotById(id) {
        assert.equal(id, 42);
        return { globalmetaid: 'boss-global', metaid: 'boss-meta' };
      },
    },
  };

  assert.deepEqual(
    evaluatePrivateChatAutoReplyPolicy({
      ...base,
      senderGlobalMetaId: 'boss-global',
      senderMetaId: 'anything',
      hasPriorLocalOutbound: false,
    }),
    { shouldReply: true, reason: 'owner' },
  );

  assert.deepEqual(
    evaluatePrivateChatAutoReplyPolicy({
      ...base,
      metabot: {
        ...base.metabot,
        boss_id: null,
        boss_global_metaid: 'external-owner-global',
      },
      senderGlobalMetaId: 'external-owner-global',
      senderMetaId: 'anything',
      hasPriorLocalOutbound: false,
    }),
    { shouldReply: true, reason: 'owner' },
  );

  assert.deepEqual(
    evaluatePrivateChatAutoReplyPolicy({
      ...base,
      senderGlobalMetaId: 'peer-global',
      senderMetaId: 'peer-meta',
      hasPriorLocalOutbound: true,
    }),
    { shouldReply: true, reason: 'prior_local_outbound' },
  );
});

test('disabled MetaBots do not auto-respond even to owners or known peers', () => {
  const result = evaluatePrivateChatAutoReplyPolicy({
    metabot: {
      enabled: false,
      boss_id: null,
      boss_global_metaid: 'owner-global',
      globalmetaid: 'local-global',
      metaid: 'local-meta',
    },
    senderGlobalMetaId: 'owner-global',
    senderMetaId: 'owner-meta',
    listenerConfig: {
      enabled: true,
      groupChats: false,
      privateChats: true,
      serviceRequests: false,
      respondToStrangerPrivateChats: true,
    },
    metabotStore: {
      getMetabotById() {
        return null;
      },
    },
    hasPriorLocalOutbound: true,
  });

  assert.deepEqual(result, {
    shouldReply: false,
    reason: 'disabled_metabot',
  });
});

test('prior private chat outbound detection only counts local non-handshake sends to the peer', () => {
  const execCalls = [];
  const hitDb = {
    exec(sql, params) {
      execCalls.push({ sql, params });
      return [{ columns: ['found'], values: [[1]] }];
    },
  };

  assert.equal(
    hasPriorNonHandshakePrivateChatOutbound(hitDb, {
      localGlobalMetaId: 'local-global',
      localMetaId: 'local-meta',
      peerGlobalMetaId: 'peer-global',
      peerMetaId: 'peer-meta',
      currentRowId: 9,
    }),
    true,
  );
  assert.match(execCalls[0].sql, /private_chat_messages/);
  assert.match(execCalls[0].sql, /NOT IN\s*\(\s*'ping'\s*,\s*'pong'\s*\)/i);
  assert.deepEqual(execCalls[0].params, [
    9,
    'local-global',
    'local-meta',
    'peer-global',
    'peer-meta',
  ]);

  const missDb = {
    exec() {
      return [{ columns: ['found'], values: [] }];
    },
  };
  assert.equal(
    hasPriorNonHandshakePrivateChatOutbound(missDb, {
      localGlobalMetaId: 'local-global',
      localMetaId: 'local-meta',
      peerGlobalMetaId: 'peer-global',
      peerMetaId: 'peer-meta',
      currentRowId: 9,
    }),
    false,
  );
});

test('prior A2A outbound detection counts previous local private chat turns', () => {
  const coworkStore = {
    getConversationMapping(channel, externalConversationId, metabotId) {
      assert.equal(channel, 'metaweb_private');
      assert.equal(externalConversationId, 'metaweb-private:peer-global');
      assert.equal(metabotId, 7);
      return { coworkSessionId: 'session-1' };
    },
    hasPriorPrivateA2AOutboundMessage(sessionId) {
      assert.equal(sessionId, 'session-1');
      return true;
    },
  };

  assert.equal(
    hasPriorPrivateChatA2AOutbound(coworkStore, {
      externalConversationId: 'metaweb-private:peer-global',
      metabotId: 7,
    }),
    true,
  );
});

test('prior A2A outbound detection ignores internal order execution traces', () => {
  const coworkStore = {
    getConversationMapping(channel, externalConversationId, metabotId) {
      assert.equal(channel, 'metaweb_private');
      assert.equal(externalConversationId, 'metaweb-private:peer-global');
      assert.equal(metabotId, 7);
      return { coworkSessionId: 'session-1' };
    },
    hasPriorPrivateA2AOutboundMessage(sessionId) {
      assert.equal(sessionId, 'session-1');
      return false;
    },
  };

  assert.equal(
    hasPriorPrivateChatA2AOutbound(coworkStore, {
      externalConversationId: 'metaweb-private:peer-global',
      metabotId: 7,
    }),
    false,
  );
});


function buildIncomingA2AMessages(count, startTimestamp = 1_770_000_000_000) {
  return Array.from({ length: count }, (_, index) => ({
    id: `incoming-${index + 1}`,
    type: 'user',
    content: `peer message ${index + 1}`,
    timestamp: startTimestamp + index * 1_000,
    metadata: { direction: 'incoming', sourceChannel: 'metaweb_private', senderName: 'Peer Bot' },
  }));
}

test('a2a chat limit helpers normalize to selectable options and derive closing phase', () => {
  assert.equal(normalizeA2AMaxIncomingTurns(30), 30);
  assert.equal(normalizeA2AMaxIncomingTurns(200), 200);
  assert.equal(normalizeA2AMaxIncomingTurns(31), 30);
  assert.equal(normalizeA2AMaxIncomingTurns(undefined), 30);
  assert.equal(normalizeA2AMaxIncomingTurns(null), 30);
  assert.equal(normalizeA2AMaxIncomingTurns('abc'), 30);

  assert.equal(normalizeA2AByeCooldownMs(60_000), 60_000);
  assert.equal(normalizeA2AByeCooldownMs(3_600_000), 3_600_000);
  assert.equal(normalizeA2AByeCooldownMs(90_000), 300_000);
  assert.equal(normalizeA2AByeCooldownMs(undefined), 300_000);

  assert.equal(deriveA2AClosingPhaseTurns(30), 20);
  assert.equal(deriveA2AClosingPhaseTurns(20), 13);
  assert.equal(deriveA2AClosingPhaseTurns(100), 66);
  assert.equal(deriveA2AClosingPhaseTurns(200), 133);
});

test('private chat A2A analysis honors per-bot max incoming turns', () => {
  const messages20 = buildIncomingA2AMessages(20);

  // Default limit stays 30: 20 incoming turns do not force a bye.
  assert.equal(analyzePrivateChatA2AConversation({ messages: messages20 }).shouldForceBye, false);
  // Per-bot limit of 20: exactly 20 incoming turns forces a bye.
  assert.equal(
    analyzePrivateChatA2AConversation({ messages: messages20, maxIncomingTurns: 20 }).shouldForceBye,
    true,
  );
  // Per-bot limit of 200: a 50-turn session is still active.
  assert.equal(
    analyzePrivateChatA2AConversation({ messages: buildIncomingA2AMessages(50), maxIncomingTurns: 200 }).shouldForceBye,
    false,
  );
  // Invalid stored values fall back to the default 30-turn limit.
  assert.equal(
    analyzePrivateChatA2AConversation({ messages: buildIncomingA2AMessages(35), maxIncomingTurns: 999 }).shouldForceBye,
    true,
  );
});

test('private chat prompt reflects the per-bot max turns limit and closing phase', () => {
  const buildAnalysis = (incomingCount, maxIncomingTurns) =>
    analyzePrivateChatA2AConversation({ messages: buildIncomingA2AMessages(incomingCount), maxIncomingTurns });
  const buildPrompt = (incomingCount, maxIncomingTurns) =>
    buildPrivateChatA2ASystemPrompt({
      metabot: { name: 'Local Bot' },
      analysis: buildAnalysis(incomingCount, maxIncomingTurns),
      maxIncomingTurns,
    });

  const defaultPrompt = buildPrompt(1, undefined);
  assert.match(defaultPrompt, /1\/30 turns/);

  const customPrompt = buildPrompt(5, 100);
  assert.match(customPrompt, /5\/100 turns/);
  assert.doesNotMatch(customPrompt, /closing phase/i);

  // 67 > floor(100 * 2 / 3) = 66, so the closing-phase rule kicks in.
  const closingPrompt = buildPrompt(67, 100);
  assert.match(closingPrompt, /closing phase/i);

  const forceByePrompt = buildPrompt(100, 100);
  assert.match(forceByePrompt, /reached the 100 turns limit/i);
});

test('auto-bye cooldown honors per-bot reopen gap override', () => {
  const endedAt = 1_770_000_000_000;
  const mappingMeta = { byeSent: true, endedByAutoPolicy: true, endedAt };

  // 1-minute cooldown: closed at 59s, reopened at 61s.
  assert.equal(
    shouldKeepPrivateChatConversationClosedAfterBye({ mappingMeta, now: endedAt + 59_000, reopenGapMs: 60_000 }),
    true,
  );
  assert.equal(
    shouldKeepPrivateChatConversationClosedAfterBye({ mappingMeta, now: endedAt + 61_000, reopenGapMs: 60_000 }),
    false,
  );
  // 60-minute cooldown: still closed at the old 5-minute boundary.
  assert.equal(
    shouldKeepPrivateChatConversationClosedAfterBye({ mappingMeta, now: endedAt + 5 * 60_000 + 1_000, reopenGapMs: 3_600_000 }),
    true,
  );
  // Invalid stored values fall back to the default 5-minute cooldown.
  assert.equal(
    shouldKeepPrivateChatConversationClosedAfterBye({ mappingMeta, now: endedAt + 5 * 60_000 + 1_000, reopenGapMs: 123 }),
    false,
  );
});


test('per-bot A2A auto-reply toggle blocks auto-reply when turned off', () => {
  const base = {
    metabot: {
      enabled: true,
      boss_id: 42,
      boss_global_metaid: null,
      globalmetaid: 'local-global',
      metaid: 'local-meta',
    },
    senderGlobalMetaId: 'boss-global',
    senderMetaId: 'boss-meta',
    listenerConfig: {
      enabled: true,
      groupChats: false,
      privateChats: true,
      serviceRequests: false,
      respondToStrangerPrivateChats: true,
    },
    metabotStore: {
      getMetabotById(id) {
        assert.equal(id, 42);
        return { globalmetaid: 'boss-global', metaid: 'boss-meta' };
      },
    },
    hasPriorLocalOutbound: true,
  };

  // Off blocks auto-reply even for the owner.
  assert.deepEqual(
    evaluatePrivateChatAutoReplyPolicy({
      ...base,
      metabot: { ...base.metabot, a2a_auto_reply_enabled: false },
    }),
    { shouldReply: false, reason: 'auto_reply_disabled' },
  );
  // On (explicit or default) keeps the existing owner behavior.
  assert.deepEqual(
    evaluatePrivateChatAutoReplyPolicy({
      ...base,
      metabot: { ...base.metabot, a2a_auto_reply_enabled: true },
    }),
    { shouldReply: true, reason: 'owner' },
  );
  assert.deepEqual(
    evaluatePrivateChatAutoReplyPolicy(base),
    { shouldReply: true, reason: 'owner' },
  );
  // NULL stored value means default (on).
  assert.deepEqual(
    evaluatePrivateChatAutoReplyPolicy({
      ...base,
      metabot: { ...base.metabot, a2a_auto_reply_enabled: null },
    }),
    { shouldReply: true, reason: 'owner' },
  );
});

test('a2a auto-reply normalizer treats null/undefined as default on and 0 as off', () => {
  assert.equal(normalizeA2AAutoReplyEnabled(undefined), true);
  assert.equal(normalizeA2AAutoReplyEnabled(null), true);
  assert.equal(normalizeA2AAutoReplyEnabled(1), true);
  assert.equal(normalizeA2AAutoReplyEnabled(0), false);
  assert.equal(normalizeA2AAutoReplyEnabled(true), true);
  assert.equal(normalizeA2AAutoReplyEnabled(false), false);
});
