import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

let startPrivateChatDaemon;
let stopPrivateChatDaemon;
let analyzePrivateChatA2AConversation;
let maybeRollOverPrivateChatEpisode;
let buildA2AEpisodeFallbackSummary;
let buildA2AEpisodeContinuityPromptBlock;
let A2A_EPISODE_ROLLOVER_MESSAGE_THRESHOLD;
try {
  ({
    startPrivateChatDaemon,
    stopPrivateChatDaemon,
    analyzePrivateChatA2AConversation,
  } = await import('../dist-electron/main/services/privateChatDaemon.js'));
  ({
    maybeRollOverPrivateChatEpisode,
    buildA2AEpisodeFallbackSummary,
    buildA2AEpisodeContinuityPromptBlock,
    A2A_EPISODE_ROLLOVER_MESSAGE_THRESHOLD,
  } = await import('../dist-electron/main/services/a2aEpisodeRollover.js'));
} catch {
  ({
    startPrivateChatDaemon,
    stopPrivateChatDaemon,
    analyzePrivateChatA2AConversation,
  } = await import('../dist-electron/main/services/privateChatDaemon.js'));
  ({
    maybeRollOverPrivateChatEpisode,
    buildA2AEpisodeFallbackSummary,
    buildA2AEpisodeContinuityPromptBlock,
    A2A_EPISODE_ROLLOVER_MESSAGE_THRESHOLD,
  } = await import('../dist-electron/main/services/a2aEpisodeRollover.js'));
}

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_THREAD_ID = 'a2a-thread:episode-test';

function createPeerPublicKey() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh.getPublicKey('hex', 'uncompressed');
}

function createEpisodeStoreHarness() {
  const externalConversationId = 'metaweb-private:peer-global';
  const sessions = new Map();
  const episodes = [];
  const mappings = new Map();
  const mappingKey = (channel, conversationId, metabotId) => `${channel}|${conversationId}|${metabotId}`;

  let sessionSeq = 0;
  const createSession = (title, _cwd, _systemPrompt, _mode, _skills, metabotId, sessionType, peerGlobalMetaId) => {
    sessionSeq += 1;
    const session = {
      id: `sess-${sessionSeq}`,
      title,
      createdAt: Date.now(),
      sessionType,
      metabotId,
      peerGlobalMetaId,
      messages: [],
    };
    sessions.set(session.id, session);
    return session;
  };

  const seedSession = createSession('Peer thread', '/tmp/idbots-test', '', 'local', [], 1, 'a2a', 'peer-global');
  // A long-lived thread accumulates messages across MANY bye-separated
  // conversation cycles: bye pressure resets each cycle, so the thread stays
  // alive while the session grows past the rollover threshold.
  let fillerSeq = 0;
  while (seedSession.messages.length < A2A_EPISODE_ROLLOVER_MESSAGE_THRESHOLD + 5) {
    for (let cycle = 0; cycle < 4; cycle += 1) {
      fillerSeq += 1;
      seedSession.messages.push({
        id: `filler-in-${fillerSeq}`,
        timestamp: 1_770_000_000_000 + fillerSeq,
        type: 'user',
        content: `filler ask ${fillerSeq}`,
        metadata: { sourceChannel: 'metaweb_private', direction: 'incoming' },
      });
      seedSession.messages.push({
        id: `filler-out-${fillerSeq}`,
        timestamp: 1_770_000_000_001 + fillerSeq,
        type: 'assistant',
        content: `filler answer ${fillerSeq}`,
        metadata: { sourceChannel: 'metaweb_private', direction: 'outgoing' },
      });
    }
    fillerSeq += 1;
    seedSession.messages.push({
      id: `filler-bye-${fillerSeq}`,
      timestamp: 1_770_000_000_002 + fillerSeq,
      type: 'assistant',
      content: 'bye',
      metadata: { sourceChannel: 'metaweb_private', direction: 'outgoing' },
    });
  }
  episodes.push({
    sessionId: seedSession.id,
    threadId: TEST_THREAD_ID,
    episodeIndex: 1,
    previousSessionId: null,
    nextSessionId: null,
    startedAt: seedSession.createdAt,
    endedAt: null,
    closeReason: null,
    summary: null,
  });
  mappings.set(mappingKey('metaweb_private', externalConversationId, 1), {
    channel: 'metaweb_private',
    externalConversationId,
    metabotId: 1,
    coworkSessionId: seedSession.id,
    metadataJson: JSON.stringify({ peerGlobalMetaId: 'peer-global', episodeIndex: 1, byeSent: false }),
  });

  const coworkStore = {
    getConversationMapping(channel, conversationId, metabotId) {
      return mappings.get(mappingKey(channel, conversationId, metabotId)) ?? null;
    },
    upsertConversationMapping(entry) {
      mappings.set(mappingKey(entry.channel, entry.externalConversationId, entry.metabotId), { ...entry });
    },
    updateConversationMappingMetadata(channel, conversationId, metabotId, patch) {
      const key = mappingKey(channel, conversationId, metabotId);
      const existing = mappings.get(key);
      if (!existing) return;
      existing.metadataJson = JSON.stringify({
        ...JSON.parse(existing.metadataJson ?? '{}'),
        ...patch,
      });
    },
    getSession(sessionId) {
      return sessions.get(sessionId) ?? null;
    },
    getSessionWithoutMessages(sessionId) {
      return sessions.get(sessionId) ?? null;
    },
    createSession,
    getSessionMessageCount(sessionId) {
      return sessions.get(sessionId)?.messages.length ?? 0;
    },
    hasBlockingServiceOrdersForSession() {
      return false;
    },
    registerA2AEpisode(input) {
      const existing = episodes.find((episode) => episode.sessionId === input.sessionId);
      if (existing) return existing;
      const latestIndex = episodes.reduce((max, episode) => Math.max(max, episode.episodeIndex), 0);
      const episode = {
        sessionId: input.sessionId,
        threadId: TEST_THREAD_ID,
        episodeIndex: input.episodeIndex ?? latestIndex + 1,
        previousSessionId: input.previousSessionId ?? null,
        nextSessionId: null,
        startedAt: input.startedAt,
        endedAt: null,
        closeReason: null,
        summary: null,
      };
      episodes.push(episode);
      const predecessor = input.previousSessionId
        ? episodes.find((item) => item.sessionId === input.previousSessionId)
        : null;
      if (predecessor) {
        predecessor.nextSessionId = episode.sessionId;
        predecessor.endedAt = predecessor.endedAt ?? episode.startedAt;
        predecessor.closeReason = predecessor.closeReason ?? input.previousCloseReason ?? null;
      }
      return episode;
    },
    updateA2AEpisodeSummary(sessionId, summary) {
      const episode = episodes.find((item) => item.sessionId === sessionId);
      if (episode) episode.summary = summary;
      return Boolean(episode);
    },
    listA2AConversationEpisodes(sessionId) {
      const anchor = episodes.find((episode) => episode.sessionId === sessionId);
      if (!anchor) return [];
      return episodes
        .filter((episode) => episode.threadId === anchor.threadId)
        .sort((a, b) => a.episodeIndex - b.episodeIndex);
    },
    getRecentA2AThreadMessages(sessionId, limit = 400) {
      const anchor = episodes.find((episode) => episode.sessionId === sessionId);
      const targets = anchor
        ? episodes.filter((episode) => episode.threadId === anchor.threadId).map((episode) => episode.sessionId)
        : [sessionId];
      const messages = [];
      for (const target of targets) {
        for (const message of sessions.get(target)?.messages ?? []) {
          if (message.type !== 'user' && message.type !== 'assistant') continue;
          if (message.metadata?.sourceChannel !== 'metaweb_private') continue;
          messages.push(message);
        }
      }
      messages.sort((a, b) => a.timestamp - b.timestamp);
      return messages.slice(-limit);
    },
    getRecentPrivateA2AMessages(sessionId, requestedLimit = 100) {
      const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.floor(requestedLimit)) : 100;
      const messages = (sessions.get(sessionId)?.messages ?? []).filter((message) => (
        (message.type === 'user' || message.type === 'assistant')
        && message.metadata?.sourceChannel === 'metaweb_private'
      ));
      return messages.slice(-limit);
    },
    getSessionMessagesMatchingMetadataValues() {
      return [];
    },
    getMessageById(sessionId, messageId) {
      return sessions.get(sessionId)?.messages.find((message) => message.id === messageId) ?? null;
    },
    getConversationSourceContextBySession() {
      return { sourceChannel: 'metaweb_private', externalConversationId };
    },
    isSessionArchived() {
      return false;
    },
    unarchiveSession() {},
    isDelegationBlocking() {
      return false;
    },
    setDelegationBlocking() {},
    updateSession() {},
    touchConversationMapping() {},
    deleteConversationMapping() {},
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
      return (sessions.get(sessionId)?.messages ?? []).some((message) => (
        message.type === 'assistant'
        && message.metadata?.sourceChannel === 'metaweb_private'
        && String(message.content ?? '').trim() !== ''
      ));
    },
    ensureCanonicalPeerSessionShape() {
      return true;
    },
    addMessage(sessionId, message) {
      const session = sessions.get(sessionId);
      const created = {
        id: `msg-${session ? session.messages.length + 1 : 1}`,
        timestamp: Date.now(),
        ...message,
      };
      if (session) session.messages.push(created);
      return created;
    },
    updateMessage(sessionId, messageId, updates) {
      const message = sessions.get(sessionId)?.messages.find((item) => item.id === messageId);
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

  const metabot = {
    id: 1,
    name: 'Local Bot',
    enabled: true,
    metaid: 'local-metaid',
    globalmetaid: 'local-global',
    allow_chat_skills: ['metaid-master-wiki'],
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
    coworkStore,
    metabotStore,
    metabot,
    sessions,
    episodes,
    mappings,
    externalConversationId,
    seedSessionId: seedSession.id,
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

test('rollover threshold is the agreed conservative start (1000 messages)', () => {
  assert.equal(A2A_EPISODE_ROLLOVER_MESSAGE_THRESHOLD, 1000);
});

test('fallback handoff summary is deterministic and bounded', () => {
  const messages = [
    { type: 'user', content: 'hello '.repeat(100), timestamp: 1_770_000_000_000 },
    { type: 'assistant', content: 'short reply', timestamp: 1_770_000_001_000 },
    { type: 'user', content: 'final ask', timestamp: 1_770_000_002_000 },
  ];
  const summary = buildA2AEpisodeFallbackSummary(messages);
  assert.ok(summary.startsWith('[Handoff summary — fallback'));
  assert.ok(summary.includes('Peer:'));
  assert.ok(summary.includes('Local:'));
  assert.ok(summary.length < 3000);
  assert.match(summary, /final ask/);
  assert.ok(buildA2AEpisodeFallbackSummary([]).includes('no readable conversation'));
});

test('continuity block carries closed-episode summaries and caps at two', () => {
  const block = buildA2AEpisodeContinuityPromptBlock([
    { episodeIndex: 1, summary: null, endedAt: null },
    { episodeIndex: 2, summary: 'second episode summary', endedAt: 1_770_000_000_000 },
    { episodeIndex: 3, summary: 'third episode summary', endedAt: 1_770_010_000_000 },
    { episodeIndex: 4, summary: null, endedAt: null },
  ]);
  assert.ok(block.includes('Previous Episodes of This Conversation'));
  assert.ok(block.includes('### Episode 2'));
  assert.ok(block.includes('second episode summary'));
  assert.ok(block.includes('### Episode 3'));
  assert.ok(!block.includes('### Episode 1'));
  assert.equal(buildA2AEpisodeContinuityPromptBlock([]), '');
});

test('maybeRollOver closes the episode, re-points the mapping, and preserves bye state', async () => {
  const harness = createEpisodeStoreHarness();
  const summaryCalls = [];
  const result = await maybeRollOverPrivateChatEpisode({
    coworkStore: harness.coworkStore,
    sessionId: harness.seedSessionId,
    externalConversationId: harness.externalConversationId,
    metabotId: 1,
    localGlobalMetaId: 'local-global',
    peerGlobalMetaId: 'peer-global',
    peerName: 'Peer Bot',
    peerAvatar: null,
    performChat: async (systemPrompt, userMessage) => {
      summaryCalls.push({ systemPrompt, userMessage });
      return ' Topics covered. OPEN COMMITTMENTS: deliver the verification results. ';
    },
    emitLog: () => {},
  });

  assert.ok(result, 'rollover should fire above the threshold');
  assert.notEqual(result.sessionId, harness.seedSessionId);
  assert.equal(result.episodeIndex, 2);
  assert.match(result.summary, /OPEN COMMITTMENTS/);
  assert.equal(summaryCalls.length, 1);

  const closed = harness.episodes.find((episode) => episode.sessionId === harness.seedSessionId);
  assert.equal(closed.closeReason, 'rollover');
  assert.equal(closed.nextSessionId, result.sessionId);
  assert.match(closed.summary, /OPEN COMMITTMENTS/);

  const mapping = harness.mappings.get(`metaweb_private|${harness.externalConversationId}|1`);
  assert.equal(mapping.coworkSessionId, result.sessionId);
  const metadata = JSON.parse(mapping.metadataJson);
  assert.equal(metadata.episodeIndex, 2);
  assert.equal(metadata.previousEpisodeSessionId, harness.seedSessionId);
  assert.equal(metadata.byeSent, false, 'bye state must survive the rollover');
});

test('maybeRollOver is a no-op below the threshold or with blocking orders', async () => {
  const harness = createEpisodeStoreHarness();
  harness.sessions.get(harness.seedSessionId).messages.length = 10;
  assert.equal(
    await maybeRollOverPrivateChatEpisode({
      coworkStore: harness.coworkStore,
      sessionId: harness.seedSessionId,
      externalConversationId: harness.externalConversationId,
      metabotId: 1,
      localGlobalMetaId: 'local-global',
      peerGlobalMetaId: 'peer-global',
      performChat: async () => 'summary',
      emitLog: () => {},
    }),
    null,
  );

  const harness2 = createEpisodeStoreHarness();
  harness2.coworkStore.hasBlockingServiceOrdersForSession = () => true;
  assert.equal(
    await maybeRollOverPrivateChatEpisode({
      coworkStore: harness2.coworkStore,
      sessionId: harness2.seedSessionId,
      externalConversationId: harness2.externalConversationId,
      metabotId: 1,
      localGlobalMetaId: 'local-global',
      peerGlobalMetaId: 'peer-global',
      performChat: async () => 'summary',
      emitLog: () => {},
    }),
    null,
  );
  assert.equal(harness2.episodes.length, 1, 'no new episode may be registered when orders block');
});

// End-to-end: an inbound message on an over-threshold session rolls over
// BEFORE the turn — the inbound lands in the successor session, the turn's
// system prompt carries the closed episode's handoff summary, and the reply
// broadcasts on-chain from the successor.
test('daemon rolls the episode over and answers from the successor session', async () => {
  const harness = createEpisodeStoreHarness();
  const logs = [];
  let createPinCount = 0;
  const skillTurnParams = [];

  const row = {
    id: 1,
    pin_id: 'incoming-pin-rollover-1',
    tx_id: 'a'.repeat(64),
    from_metaid: 'peer-metaid',
    from_global_metaid: 'peer-global',
    from_name: 'Peer Bot',
    from_avatar: null,
    from_chat_pubkey: createPeerPublicKey(),
    to_metaid: 'local-metaid',
    to_global_metaid: 'local-global',
    content: 'Verification anchors ready — waiting for your complete reply.',
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

  // The bye-cycled filler thread already contains delivered outbound
  // messages, so wake arming sees an established conversation.

  startPrivateChatDaemon(
    db,
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
      skillTurnParams.push(params);
      const persisted = harness.coworkStore.addMessage(params.sessionId, {
        type: 'assistant',
        content: 'Verification complete — full reply as promised.',
        metadata: { isStreaming: false, isFinal: true },
      });
      return { replyText: 'Verification complete — full reply as promised.', assistantMessageId: persisted.id };
    },
    async () => '我需要查询一下，请稍等。',
  );

  try {
    // The summary LLM has no configured provider in tests, so the rollover
    // settles on the deterministic fallback digest — the wiring under test is
    // the rollover itself, not the summary quality.
    await waitFor(() => logs.some((message) => message.includes('Replied to')), 120_000);
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }

  // Rollover happened before the turn.
  assert.ok(logs.some((message) => message.includes('Episode rollover for metaweb-private:peer-global')));

  // The inbound landed in the successor session with the repoint metadata.
  const mapping = harness.mappings.get(`metaweb_private|${harness.externalConversationId}|1`);
  const successorId = mapping.coworkSessionId;
  assert.notEqual(successorId, harness.seedSessionId);
  const successor = harness.sessions.get(successorId);
  const inbound = successor.messages.find(
    (message) => message.type === 'user' && message.content.includes('Verification anchors ready')
  );
  assert.ok(inbound, 'inbound message must be appended to the successor session');
  assert.equal(inbound.metadata.a2aEpisodeStarted, true);
  assert.equal(inbound.metadata.previousEpisodeSessionId, harness.seedSessionId);

  // The turn ran in the successor with the continuity block.
  assert.equal(skillTurnParams.length, 1);
  assert.equal(skillTurnParams[0].sessionId, successorId);
  assert.match(skillTurnParams[0].systemPrompt, /Previous Episodes of This Conversation/);

  // Delivered on-chain from the successor.
  assert.equal(row.is_processed, 1);
  assert.equal(createPinCount, 1);
  const delivered = successor.messages.find(
    (message) => message.content === 'Verification complete — full reply as promised.'
  );
  assert.equal(delivered?.metadata?.privateChatDeliveryStatus, 'sent');

  // The closed episode keeps its audit trail (LLM summary or fallback digest).
  const closed = harness.episodes.find((episode) => episode.sessionId === harness.seedSessionId);
  assert.equal(closed.closeReason, 'rollover');
  assert.ok(closed.summary && closed.summary.trim().length > 0);
});

test('bye pressure is conversation-scoped: gaps and either side\'s bye reset it; continuous chatter still forces', () => {
  const base = 1_770_000_000_000;
  const incoming = (id, ts) => ({
    id,
    type: 'user',
    content: `msg ${id}`,
    timestamp: ts,
    metadata: { direction: 'incoming', sourceChannel: 'metaweb_private' },
  });
  const outgoingBye = (id, ts) => ({
    id,
    type: 'assistant',
    content: 'bye',
    timestamp: ts,
    metadata: { direction: 'outgoing', sourceChannel: 'metaweb_private' },
  });
  const incomingBye = (id, ts) => ({
    id,
    type: 'user',
    content: 'bye',
    timestamp: ts,
    metadata: { direction: 'incoming', sourceChannel: 'metaweb_private' },
  });

  // Release-audit follow-up 2026-09-19: a >5-min gap starts a NEW
  // conversation — only the post-gap conversation's inbound counts. The old
  // thread-cumulative reading force-byed the twin→owner daily-report thread
  // (one short message a day) every 50 CUMULATIVE messages forever.
  const acrossGaps = analyzePrivateChatA2AConversation({
    messages: [
      incoming('a', base),
      incoming('b', base + 10_000),
      incoming('c', base + 10_000 + 6 * 60_000), // > 5 min gap — new conversation
    ],
    now: base + 20_000_000,
  });
  assert.equal(acrossGaps.incomingTurnCount, 1, 'a conversation gap resets the pressure');

  // Continuous chatter (no gap) still accumulates and still forces the bye —
  // a peer keeping the thread hot cannot outlive the policy. (Cap must be a
  // selectable option: the analyzer normalizes off-list values to the default.)
  const continuous = analyzePrivateChatA2AConversation({
    messages: Array.from({ length: 20 }, (_, i) => incoming(`hot-${i}`, base + i * 60_000)),
    now: base + 20_000_000,
    maxIncomingTurns: 20,
  });
  assert.equal(continuous.incomingTurnCount, 20);
  assert.equal(continuous.shouldForceBye, true, 'a hot conversation still hits the cap');

  const afterBye = analyzePrivateChatA2AConversation({
    messages: [
      incoming('a', base),
      outgoingBye('bye', base + 10_000),
      incoming('d', base + 20_000),
    ],
    now: base + 20_000_000,
  });
  assert.equal(afterBye.incomingTurnCount, 1);

  // A PEER's bye also ends the conversation (previously it counted +1 toward
  // our own forced bye and stayed in the context window).
  const afterPeerBye = analyzePrivateChatA2AConversation({
    messages: [
      incoming('a', base),
      incomingBye('bye', base + 10_000),
      incoming('d', base + 20_000),
    ],
    now: base + 20_000_000,
  });
  assert.equal(afterPeerBye.incomingTurnCount, 1, "the peer's bye resets the pressure too");
  assert.ok(
    afterPeerBye.contextMessages.every((m) => m.content !== 'bye'),
    "the peer's bye text is not carried as conversation context",
  );
});
