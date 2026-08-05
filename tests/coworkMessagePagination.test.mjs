import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCoworkStore,
  createSqliteStore,
  getCompiledStores,
  getIndexNames,
} from './memoryTestUtils.mjs';

const {
  A2A_SESSION_CONVERSATION_GAP_MS,
  A2A_SESSION_EPISODE_IDLE_MS,
  A2A_SESSION_EPISODE_MESSAGE_LIMIT,
  resolveA2ASessionEpisodeRotationReason,
  rotateCoworkA2ASessionEpisode,
} = await import('../dist-electron/main/services/coworkEnsureA2ASession.js');
const {
  buildA2AConversationThreadId,
  buildA2AParticipantPairKey,
} = getCompiledStores();

const insertMetabot = (db, id, globalMetaId) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key,
      chat_public_key, name, metaid, globalmetaid, metabot_type, created_by,
      role, soul, created_at, updated_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'worker', 'test', 'role', 'soul', 1, 1)`,
    [
      id,
      `mvc-${id}`,
      `btc-${id}`,
      `doge-${id}`,
      `pk-${id}`,
      `chatpk-${id}`,
      `bot-${id}`,
      `metaid-${id}`,
      globalMetaId,
    ],
  );
};

test('message pagination index is created idempotently', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    createCoworkStore(db);
    createCoworkStore(db);
    const names = getIndexNames(db, 'cowork_messages');
    assert.equal(names.filter((name) => name === 'idx_cowork_messages_session_sequence').length, 1);
  } finally {
    cleanup();
  }
});

test('A2A identity keys separate local perspective while retaining a pair-wide key', () => {
  assert.notEqual(
    buildA2AConversationThreadId('IDQ1LOCAL', 'idq1peer'),
    buildA2AConversationThreadId('idq1peer', 'idq1local'),
  );
  assert.equal(
    buildA2AParticipantPairKey('IDQ1LOCAL', 'idq1peer'),
    buildA2AParticipantPairKey('idq1peer', 'idq1local'),
  );
});

test('legacy canonical A2A sessions are idempotently backfilled into logical threads', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    insertMetabot(db, 1, 'idq1local');
    const session = store.createSession(
      'Legacy peer',
      '/tmp/a2a',
      '',
      'local',
      [],
      1,
      'a2a',
      'idq1peer',
    );
    store.upsertConversationMapping({
      channel: 'metaweb_private',
      externalConversationId: 'metaweb-private:idq1peer',
      metabotId: 1,
      coworkSessionId: session.id,
      metadataJson: JSON.stringify({
        a2aConversationId: 'metaweb-private:idq1peer',
        episodeIndex: 1,
        episodeStartedAt: session.createdAt,
      }),
    });

    const migrated = createCoworkStore(db);
    createCoworkStore(db);
    const thread = migrated.getA2AConversationThreadBySession(session.id);
    assert.equal(thread?.localGlobalMetaId, 'idq1local');
    assert.equal(thread?.peerGlobalMetaId, 'idq1peer');
    assert.equal(migrated.listA2AConversationEpisodes(session.id).length, 1);
  } finally {
    cleanup();
  }
});

test('message pages use a stable sequence cursor and preserve chronological order', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const session = store.createSession('long A2A chat', '/tmp/a2a', '', 'local', [], 1, 'a2a');
    const ids = [];
    for (let index = 1; index <= 7; index += 1) {
      ids.push(store.addMessage(session.id, {
        type: index % 2 === 0 ? 'assistant' : 'user',
        content: `message-${index}`,
      }).id);
    }

    const latest = store.getSessionMessagesPage(session.id, { limit: 3 });
    assert.deepEqual(latest.messages.map((message) => message.content), ['message-5', 'message-6', 'message-7']);
    assert.equal(latest.hasMoreBefore, true);
    assert.equal(latest.beforeSequence, 5);

    const middle = store.getSessionMessagesPage(session.id, {
      beforeSequence: latest.beforeSequence,
      limit: 3,
    });
    assert.deepEqual(middle.messages.map((message) => message.content), ['message-2', 'message-3', 'message-4']);
    assert.equal(middle.hasMoreBefore, true);
    assert.equal(middle.beforeSequence, 2);

    const oldest = store.getSessionMessagesPage(session.id, {
      beforeSequence: middle.beforeSequence,
      limit: 3,
    });
    assert.deepEqual(oldest.messages.map((message) => message.content), ['message-1']);
    assert.equal(oldest.hasMoreBefore, false);
    assert.equal(oldest.beforeSequence, null);

    const view = store.getSessionView(session.id, 3);
    assert.deepEqual(view?.messages.map((message) => message.content), ['message-5', 'message-6', 'message-7']);
    assert.deepEqual(view?.messageHistory, {
      hasMoreBefore: true,
      beforeSequence: 5,
      pageSize: 3,
    });
    assert.deepEqual(store.getSession(session.id)?.messages.map((message) => message.id), ids);
  } finally {
    cleanup();
  }
});

test('A2A daemon queries stay bounded and preserve exact metadata for callers', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const session = store.createSession('bounded A2A chat', '/tmp/a2a', '', 'local', [], 1, 'a2a');
    store.addMessage(session.id, {
      type: 'assistant',
      content: 'pong',
      metadata: { sourceChannel: 'metaweb_private', direction: 'outgoing', pinId: 'pin-pong' },
    });
    store.addMessage(session.id, {
      type: 'assistant',
      content: 'internal trace',
      metadata: { sourceChannel: 'metaweb_private', direction: 'outgoing', orderExecutionTrace: true },
    });
    store.addMessage(session.id, {
      type: 'tool_result',
      content: 'large internal result',
      metadata: { sourceChannel: 'cowork_ui' },
    });
    assert.equal(store.hasPriorPrivateA2AOutboundMessage(session.id), false);
    store.addMessage(session.id, {
      type: 'user',
      content: 'peer question',
      metadata: { sourceChannel: 'metaweb_private', direction: 'incoming', pinId: 'pin-question' },
    });
    store.addMessage(session.id, {
      type: 'assistant',
      content: 'useful reply',
      metadata: { sourceChannel: 'metaweb_private', direction: 'outgoing', txid: 'tx-reply' },
    });

    assert.deepEqual(
      store.getRecentPrivateA2AMessages(session.id, 2).map((message) => message.content),
      ['peer question', 'useful reply'],
    );
    assert.deepEqual(
      store.getSessionMessagesMatchingMetadataValues(session.id, ['pin-question']).map((message) => message.content),
      ['peer question'],
    );
    assert.equal(store.hasPriorPrivateA2AOutboundMessage(session.id), true);
    assert.deepEqual(store.getSessionWithoutMessages(session.id)?.messages, []);

    const now = 1_800_000_000_000;
    db.run(`
      INSERT INTO service_orders (
        id, role, local_metabot_id, counterparty_global_metaid, service_name,
        payment_txid, payment_chain, payment_amount, payment_currency,
        cowork_session_id, status, first_response_deadline_at, delivery_deadline_at,
        created_at, updated_at
      ) VALUES (?, 'buyer', 1, 'idq1peer', 'Test service', 'tx-order', 'mvc', '1', 'SPACE', ?, 'rating_pending', ?, ?, ?, ?)
    `, ['order-1', session.id, now, now, now, now - 2 * A2A_SESSION_EPISODE_IDLE_MS]);
    assert.equal(store.hasBlockingServiceOrdersForSession(session.id, now), false);
    db.run("UPDATE service_orders SET updated_at = ? WHERE id = 'order-1'", [now]);
    assert.equal(store.hasBlockingServiceOrdersForSession(session.id, now), true);
    db.run("UPDATE service_orders SET status = 'in_progress', updated_at = ? WHERE id = 'order-1'", [now - 2 * A2A_SESSION_EPISODE_IDLE_MS]);
    assert.equal(store.hasBlockingServiceOrdersForSession(session.id, now), true);
  } finally {
    cleanup();
  }
});

test('A2A episode policy rotates only at durable boundaries', () => {
  const now = 1_800_000_000_000;
  const mapping = {
    lastActiveAt: now - 1_000,
    metadataJson: JSON.stringify({ episodeIndex: 1 }),
  };
  assert.equal(resolveA2ASessionEpisodeRotationReason({
    mapping,
    messageCount: A2A_SESSION_EPISODE_MESSAGE_LIMIT,
    hasBlockingServiceOrders: false,
    isArchived: false,
    now,
  }), null);
  assert.equal(resolveA2ASessionEpisodeRotationReason({
    mapping: { ...mapping, lastActiveAt: now - A2A_SESSION_CONVERSATION_GAP_MS - 1 },
    messageCount: A2A_SESSION_EPISODE_MESSAGE_LIMIT + 400,
    hasBlockingServiceOrders: false,
    isArchived: false,
    now,
  }), 'message_limit');
  assert.equal(resolveA2ASessionEpisodeRotationReason({
    mapping: { ...mapping, lastActiveAt: now - A2A_SESSION_EPISODE_IDLE_MS },
    messageCount: 10,
    hasBlockingServiceOrders: false,
    isArchived: false,
    now,
  }), 'idle_timeout');
  assert.equal(resolveA2ASessionEpisodeRotationReason({
    mapping: { ...mapping, metadataJson: JSON.stringify({ byeSent: true }) },
    messageCount: 10,
    hasBlockingServiceOrders: false,
    isArchived: false,
    restartEndedConversation: true,
    now,
  }), 'conversation_restarted');
  assert.equal(resolveA2ASessionEpisodeRotationReason({
    mapping: { ...mapping, metadataJson: JSON.stringify({ episodeRestartRequestedAt: now }) },
    messageCount: 10,
    hasBlockingServiceOrders: false,
    isArchived: false,
    now,
  }), 'conversation_restarted');
  assert.equal(resolveA2ASessionEpisodeRotationReason({
    mapping,
    messageCount: A2A_SESSION_EPISODE_MESSAGE_LIMIT + 100,
    hasBlockingServiceOrders: true,
    isArchived: true,
    restartEndedConversation: true,
    now,
  }), null);
});

test('rotating an A2A episode preserves stable conversation identity and archives raw history', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const conversationId = 'metaweb-private:idq1peer';
    const oldSession = store.createSession(
      'Peer Bot',
      '/tmp/a2a',
      '',
      'local',
      [],
      1,
      'a2a',
      'idq1peer',
      'Peer Bot',
    );
    store.addMessage(oldSession.id, {
      type: 'user',
      content: 'old history remains intact',
      metadata: { sourceChannel: 'metaweb_private', direction: 'incoming' },
    });
    const mapping = store.upsertConversationMapping({
      channel: 'metaweb_private',
      externalConversationId: conversationId,
      metabotId: 1,
      coworkSessionId: oldSession.id,
      metadataJson: JSON.stringify({
        peerGlobalMetaId: 'idq1peer',
        episodeIndex: 1,
        episodeStartedAt: oldSession.createdAt,
      }),
    });

    const nextSession = rotateCoworkA2ASessionEpisode({
      coworkStore: store,
      mapping,
      session: store.getSessionWithoutMessages(oldSession.id),
      externalConversationId: conversationId,
      reason: 'message_limit',
      localGlobalMetaId: 'idq1local',
      peerGlobalMetaId: 'idq1peer',
      peerName: 'Peer Bot',
      now: 1_800_000_000_000,
    });

    assert.notEqual(nextSession.id, oldSession.id);
    assert.equal(store.getConversationMapping('metaweb_private', conversationId, 1)?.coworkSessionId, nextSession.id);
    assert.equal(store.isSessionArchived(oldSession.id), true);
    assert.deepEqual(store.getSession(oldSession.id)?.messages.map((message) => message.content), ['old history remains intact']);
    assert.deepEqual(store.getConversationSourceContextBySession(oldSession.id), {
      sourceChannel: 'metaweb_private',
      externalConversationId: conversationId,
    });
    assert.deepEqual(store.listSessions().map((session) => session.id), [nextSession.id]);
    assert.deepEqual(store.listArchivedSessions().map((session) => session.id), [oldSession.id]);
    const currentMetadata = JSON.parse(
      store.getConversationMapping('metaweb_private', conversationId, 1)?.metadataJson ?? '{}',
    );
    assert.equal(currentMetadata.episodeIndex, 2);
    assert.equal(currentMetadata.previousEpisodeSessionId, oldSession.id);
    assert.equal(currentMetadata.byeSent, false);

    store.addMessage(nextSession.id, {
      type: 'assistant',
      content: 'new episode message 1',
      metadata: { sourceChannel: 'metaweb_private', direction: 'outgoing' },
    });
    store.addMessage(nextSession.id, {
      type: 'user',
      content: 'new episode message 2',
      metadata: { sourceChannel: 'metaweb_private', direction: 'incoming' },
    });

    const episodes = store.listA2AConversationEpisodes(nextSession.id);
    assert.deepEqual(episodes.map((episode) => ({
      sessionId: episode.sessionId,
      episodeIndex: episode.episodeIndex,
      previousSessionId: episode.previousSessionId,
      nextSessionId: episode.nextSessionId,
      endedAt: episode.endedAt,
      closeReason: episode.closeReason,
    })), [
      {
        sessionId: oldSession.id,
        episodeIndex: 1,
        previousSessionId: null,
        nextSessionId: nextSession.id,
        endedAt: 1_800_000_000_000,
        closeReason: 'message_limit',
      },
      {
        sessionId: nextSession.id,
        episodeIndex: 2,
        previousSessionId: oldSession.id,
        nextSessionId: null,
        endedAt: null,
        closeReason: null,
      },
    ]);
    const thread = store.getA2AConversationThreadBySession(nextSession.id);
    assert.ok(thread?.id.startsWith('a2a-thread:'));
    assert.ok(thread?.participantPairKey.startsWith('a2a-pair:'));

    const latestHistory = store.getA2AConversationHistoryPage(nextSession.id, { limit: 2 });
    assert.deepEqual(
      latestHistory?.messages.map((entry) => [entry.episodeIndex, entry.message.content]),
      [[2, 'new episode message 1'], [2, 'new episode message 2']],
    );
    assert.equal(latestHistory?.hasMoreBefore, true);
    const earlierHistory = store.getA2AConversationHistoryPage(nextSession.id, {
      beforeCursor: latestHistory?.beforeCursor,
      limit: 2,
    });
    assert.deepEqual(
      earlierHistory?.messages.map((entry) => [entry.episodeIndex, entry.message.content]),
      [[1, 'old history remains intact']],
    );
    assert.equal(earlierHistory?.hasMoreBefore, false);
  } finally {
    cleanup();
  }
});
