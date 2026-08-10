import test from 'node:test';
import assert from 'node:assert/strict';

import { createCoworkStore, createSqliteStore, getIndexNames, getRow } from './memoryTestUtils.mjs';

let MessageFeedbackStore;
try {
  ({ MessageFeedbackStore } = await import('../dist-electron/main/messageFeedbackStore.js'));
} catch {
  ({ MessageFeedbackStore } = await import('../dist-electron/messageFeedbackStore.js'));
}

const DAY = new Date(2026, 7, 10, 12).getTime();

const insertMessage = (db, sessionId, type, content, createdAt, sequence) => {
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [`msg-${sessionId}-${sequence}`, sessionId, type, content, '{}', createdAt, sequence]
  );
  return `msg-${sessionId}-${sequence}`;
};

test('message_feedback table and index are created idempotently', async () => {
  const { db, store, userDataPath, cleanup } = await createSqliteStore();
  try {
    store.initializeTables(userDataPath); // second run must be a no-op

    const table = getRow(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_feedback'"
    );
    assert.equal(table?.name, 'message_feedback');
    assert.ok(getIndexNames(db, 'message_feedback').includes('idx_message_feedback_session'));
  } finally {
    cleanup();
  }
});

test('upsertFeedback creates, switches rating, and handles comment semantics', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const store = new MessageFeedbackStore(db, () => {});
    const session = coworkStore.createSession('反馈会话', '/tmp/fb', '', 'local', [], 5);
    const messageId = insertMessage(db, session.id, 'assistant', '方案 A', DAY + 1000, 1);

    const created = store.upsertFeedback({
      messageId,
      sessionId: session.id,
      rating: 'up',
      comment: '  回答得很好  ',
    });
    assert.equal(created.messageId, messageId);
    assert.equal(created.sessionId, session.id);
    assert.equal(created.rating, 'up');
    assert.equal(created.comment, '回答得很好', 'comment is trimmed');
    assert.ok(created.createdAt > 0);
    assert.equal(created.createdAt, created.updatedAt);

    // Comment key absent → existing comment preserved, rating switches,
    // created_at keeps the original value.
    const switched = store.upsertFeedback({ messageId, sessionId: session.id, rating: 'down' });
    assert.equal(switched.rating, 'down');
    assert.equal(switched.comment, '回答得很好');
    assert.equal(switched.createdAt, created.createdAt);
    assert.ok(switched.updatedAt >= created.updatedAt);

    // Comment key present → stored trimmed; empty string → null.
    const emptied = store.upsertFeedback({ messageId, sessionId: session.id, rating: 'down', comment: '   ' });
    assert.equal(emptied.comment, null);

    const withComment = store.upsertFeedback({ messageId, sessionId: session.id, rating: 'up', comment: '这次可以' });
    assert.equal(withComment.comment, '这次可以');

    // Explicit null comment clears the stored comment.
    const nulled = store.upsertFeedback({ messageId, sessionId: session.id, rating: 'up', comment: null });
    assert.equal(nulled.comment, null);
  } finally {
    cleanup();
  }
});

test('clearFeedback removes the row exactly once', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const store = new MessageFeedbackStore(db, () => {});
    const session = coworkStore.createSession('反馈会话', '/tmp/fb', '', 'local', [], 5);
    const messageId = insertMessage(db, session.id, 'assistant', '方案 A', DAY + 1000, 1);

    assert.equal(store.clearFeedback(messageId), false, 'nothing to clear');
    store.upsertFeedback({ messageId, sessionId: session.id, rating: 'up' });
    assert.equal(store.clearFeedback(messageId), true);
    assert.equal(store.getFeedback(messageId), null);
    assert.equal(store.clearFeedback(messageId), false, 'second clear is a no-op');
  } finally {
    cleanup();
  }
});

test('listFeedbackForSession scopes by session and orders by created_at ASC', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const store = new MessageFeedbackStore(db, () => {});
    const sessionA = coworkStore.createSession('会话 A', '/tmp/a', '', 'local', [], 5);
    const sessionB = coworkStore.createSession('会话 B', '/tmp/b', '', 'local', [], 5);
    const msgA1 = insertMessage(db, sessionA.id, 'assistant', 'A1', DAY + 1000, 1);
    const msgA2 = insertMessage(db, sessionA.id, 'assistant', 'A2', DAY + 2000, 2);
    const msgB1 = insertMessage(db, sessionB.id, 'assistant', 'B1', DAY + 3000, 1);

    // Fixed timestamps keep the ordering assertion deterministic; inserted in
    // reverse chronological order on purpose.
    db.run(
      `INSERT INTO message_feedback (message_id, session_id, rating, comment, created_at, updated_at)
       VALUES (?, ?, 'up', NULL, 2000, 2000)`,
      [msgA2, sessionA.id]
    );
    db.run(
      `INSERT INTO message_feedback (message_id, session_id, rating, comment, created_at, updated_at)
       VALUES (?, ?, 'down', '太远', 1000, 1000)`,
      [msgA1, sessionA.id]
    );
    db.run(
      `INSERT INTO message_feedback (message_id, session_id, rating, comment, created_at, updated_at)
       VALUES (?, ?, 'up', NULL, 1500, 1500)`,
      [msgB1, sessionB.id]
    );

    const listA = store.listFeedbackForSession(sessionA.id);
    assert.deepEqual(listA.map((record) => record.messageId), [msgA1, msgA2]);
    assert.equal(listA[0].rating, 'down');
    assert.equal(listA[0].comment, '太远');

    const listB = store.listFeedbackForSession(sessionB.id);
    assert.deepEqual(listB.map((record) => record.messageId), [msgB1]);

    assert.deepEqual(store.listFeedbackForSession('no-such-session'), []);
  } finally {
    cleanup();
  }
});

test('UNIQUE(message_id) is enforced', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const store = new MessageFeedbackStore(db, () => {});
    const session = coworkStore.createSession('反馈会话', '/tmp/fb', '', 'local', [], 5);
    const messageId = insertMessage(db, session.id, 'assistant', '方案 A', DAY + 1000, 1);

    store.upsertFeedback({ messageId, sessionId: session.id, rating: 'up' });
    assert.throws(() => db.run(
      `INSERT INTO message_feedback (message_id, session_id, rating, comment, created_at, updated_at)
       VALUES (?, ?, 'down', NULL, 1, 1)`,
      [messageId, session.id]
    ), /UNIQUE/i);
  } finally {
    cleanup();
  }
});
