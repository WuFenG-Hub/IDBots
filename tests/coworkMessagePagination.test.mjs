import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCoworkStore,
  createSqliteStore,
  getCompiledStores,
  getIndexNames,
} from './memoryTestUtils.mjs';

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

test('split A2A episodes are idempotently consolidated into the original session', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    insertMetabot(db, 1, 'idq1local');
    const original = store.createSession(
      'Peer Bot', '/tmp/a2a', '', 'local', [], 1, 'a2a', 'idq1peer', 'Old Peer',
    );
    const split = store.createSession(
      'Peer Bot', '/tmp/a2a', '', 'local', [], 1, 'a2a', 'idq1peer', 'New Peer', 'new-avatar',
    );
    const child = store.createSession('Child', '/tmp/a2a', '', 'local');
    db.run('UPDATE cowork_sessions SET parent_session_id = ? WHERE id = ?', [split.id, child.id]);
    store.addMessage(original.id, { type: 'user', content: 'original history' });
    store.addMessage(split.id, { type: 'assistant', content: 'split history' });
    store.setSessionPinned(split.id, true);
    store.archiveSession(original.id);

    const firstEpisode = store.registerA2AEpisode({
      sessionId: original.id,
      localMetabotId: 1,
      localGlobalMetaId: 'idq1local',
      peerGlobalMetaId: 'idq1peer',
      episodeIndex: 1,
      startedAt: 100,
    });
    store.registerA2AEpisode({
      sessionId: split.id,
      localMetabotId: 1,
      localGlobalMetaId: 'idq1local',
      peerGlobalMetaId: 'idq1peer',
      episodeIndex: 2,
      previousSessionId: original.id,
      startedAt: 200,
      previousCloseReason: 'message_limit',
    });
    store.upsertConversationMapping({
      channel: 'metaweb_private',
      externalConversationId: 'metaweb-private:idq1peer',
      metabotId: 1,
      coworkSessionId: split.id,
      metadataJson: JSON.stringify({
        a2aThreadId: firstEpisode.threadId,
        episodeIndex: 2,
        previousEpisodeSessionId: original.id,
        episodeReason: 'message_limit',
        peerName: 'New Peer',
      }),
    });
    db.run(`
      INSERT INTO service_orders (
        id, role, local_metabot_id, counterparty_global_metaid, service_name,
        payment_txid, payment_chain, payment_amount, payment_currency,
        cowork_session_id, status, first_response_deadline_at, delivery_deadline_at,
        created_at, updated_at
      ) VALUES ('order-split', 'buyer', 1, 'idq1peer', 'Test', 'tx', 'mvc', '1', 'SPACE', ?, 'in_progress', 1, 1, 1, 1)
    `, [split.id]);

    const migrated = createCoworkStore(db);
    createCoworkStore(db);

    assert.equal(migrated.getSessionWithoutMessages(split.id), null);
    assert.equal(migrated.isSessionArchived(original.id), false);
    assert.equal(migrated.getSessionWithoutMessages(original.id)?.pinned, true);
    assert.equal(migrated.getSessionWithoutMessages(original.id)?.peerName, 'New Peer');
    assert.deepEqual(
      db.exec('SELECT sequence, content FROM cowork_messages WHERE session_id = ? ORDER BY sequence', [original.id])[0].values,
      [[1, 'original history'], [2, 'split history']],
    );
    assert.equal(
      migrated.getConversationMapping('metaweb_private', 'metaweb-private:idq1peer', 1)?.coworkSessionId,
      original.id,
    );
    const mappingMetadata = JSON.parse(
      migrated.getConversationMapping('metaweb_private', 'metaweb-private:idq1peer', 1)?.metadataJson ?? '{}',
    );
    assert.equal(mappingMetadata.episodeIndex, 1);
    assert.equal(mappingMetadata.previousEpisodeSessionId, undefined);
    assert.equal(mappingMetadata.episodeReason, undefined);
    assert.deepEqual(migrated.listA2AConversationEpisodes(original.id).map((episode) => ({
      sessionId: episode.sessionId,
      episodeIndex: episode.episodeIndex,
      previousSessionId: episode.previousSessionId,
      nextSessionId: episode.nextSessionId,
    })), [{
      sessionId: original.id,
      episodeIndex: 1,
      previousSessionId: null,
      nextSessionId: null,
    }]);
    assert.equal(db.exec("SELECT cowork_session_id FROM service_orders WHERE id = 'order-split'")[0].values[0][0], original.id);
    assert.equal(db.exec('SELECT parent_session_id FROM cowork_sessions WHERE id = ?', [child.id])[0].values[0][0], original.id);
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
    `, ['order-1', session.id, now, now, now, now - 2 * 24 * 60 * 60 * 1000]);
    assert.equal(store.hasBlockingServiceOrdersForSession(session.id, now), false);
    db.run("UPDATE service_orders SET updated_at = ? WHERE id = 'order-1'", [now]);
    assert.equal(store.hasBlockingServiceOrdersForSession(session.id, now), true);
    db.run("UPDATE service_orders SET status = 'in_progress', updated_at = ? WHERE id = 'order-1'", [now - 2 * 24 * 60 * 60 * 1000]);
    assert.equal(store.hasBlockingServiceOrdersForSession(session.id, now), true);
  } finally {
    cleanup();
  }
});

test('A2A display window skips a hidden error flood and keeps visible conversation', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const session = store.createSession('error flood A2A', '/tmp/a2a', '', 'local', [], 1, 'a2a');
    store.addMessage(session.id, {
      type: 'user',
      content: 'please fix invite_remote',
      metadata: { sourceChannel: 'metaweb_private', direction: 'incoming' },
    });
    store.addMessage(session.id, {
      type: 'assistant',
      content: 'wait a moment',
      metadata: { sourceChannel: 'metaweb_private', direction: 'outgoing' },
    });
    store.addMessage(session.id, {
      type: 'assistant',
      content: 'internal reasoning',
      metadata: { isThinking: true },
    });
    store.addMessage(session.id, {
      type: 'tool_use',
      content: 'Using tool: bash',
      metadata: { toolName: 'bash', toolUseId: 'call-1' },
    });
    for (let index = 0; index < 120; index += 1) {
      store.addMessage(session.id, {
        type: 'system',
        content: 'Error: DSH turn failed: free_quota_exhausted',
        metadata: { error: 'DSH turn failed: {"code":"QUOTA"}' },
      });
    }

    const rawTail = store.getSessionMessagesPage(session.id, { limit: 100 });
    assert.equal(rawTail.messages.length, 100);
    assert.equal(rawTail.messages.every((message) => message.type === 'system'), true);

    const view = store.getSessionView(session.id, 20);
    const contents = view?.messages.map((message) => message.content) ?? [];
    assert.equal(contents.includes('please fix invite_remote'), true);
    assert.equal(contents.includes('wait a moment'), true);
    assert.equal(contents.includes('internal reasoning'), true);
    assert.equal(contents.includes('Using tool: bash'), true);
    assert.equal(contents.filter((content) => content.startsWith('Error:')).length, 1);
    assert.equal(view?.messageHistory?.hasMoreBefore, false);

    const earlier = store.getSessionMessagesPage(session.id, {
      beforeSequence: view?.messageHistory?.beforeSequence ?? undefined,
      limit: 20,
      displayWindow: true,
    });
    assert.equal(earlier.hasMoreBefore, false);
  } finally {
    cleanup();
  }
});
