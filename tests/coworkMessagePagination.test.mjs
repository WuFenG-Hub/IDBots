import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCoworkStore,
  createSqliteStore,
  getIndexNames,
} from './memoryTestUtils.mjs';

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
  } finally {
    cleanup();
  }
});
