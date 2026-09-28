import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCoworkStore,
  createSqliteStore,
  getIndexNames,
} from './memoryTestUtils.mjs';

/**
 * The transcript order is (created_at, sequence, ROWID): the order
 * getSessionMessages returns, the order a message page walks, and the order the
 * store rewinds along. Both reads used to spell sequence as COALESCE(sequence, 0)
 * — an expression no index can order by — so every read of a session (a real one
 * holds five figures of rows) materialized the whole session into a temp B-tree
 * before applying its LIMIT. These tests pin the rewritten SQL to the indexes
 * that make it an index-ordered walk, and pin the ordering itself.
 */

const plan = (db, sql) => (db.exec(`EXPLAIN QUERY PLAN ${sql}`)[0]?.values ?? [])
  .map((row) => String(row[3]))
  .join(' | ');

test('transcript reads and message pages are index-ordered, never sorted', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const session = store.createSession('indexed transcript', '/tmp/indexed', '', 'local');

    const indexes = getIndexNames(db, 'cowork_messages');
    assert.ok(indexes.includes('idx_cowork_messages_session_created_sequence'));
    assert.ok(indexes.includes('idx_cowork_messages_session_sequence_created'));

    // The full transcript (getSessionMessages).
    const full = plan(db, `
      SELECT id, type, content, metadata, created_at, sequence
      FROM cowork_messages
      WHERE session_id = '${session.id}'
      ORDER BY created_at ASC, sequence ASC, ROWID ASC
    `);
    assert.match(full, /USING INDEX idx_cowork_messages_session_created_sequence/);
    assert.doesNotMatch(full, /TEMP B-TREE/);

    // The newest-first page (querySessionMessageRows), with and without a cursor.
    for (const sql of [
      `SELECT id, type, content, metadata, created_at, sequence FROM cowork_messages
        WHERE session_id = '${session.id}'
        ORDER BY sequence DESC, created_at DESC, ROWID DESC LIMIT 101`,
      `SELECT id, type, content, metadata, created_at, sequence FROM cowork_messages
        WHERE session_id = '${session.id}' AND COALESCE(sequence, 0) < 5
        ORDER BY sequence DESC, created_at DESC, ROWID DESC LIMIT 101`,
    ]) {
      const pagePlan = plan(db, sql);
      assert.match(pagePlan, /USING INDEX idx_cowork_messages_session_sequence_created/);
      assert.doesNotMatch(pagePlan, /TEMP B-TREE/);
    }
  } finally {
    cleanup();
  }
});

test('page hits are the newest rows of the session and page back without gaps', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const session = store.createSession('page walk', '/tmp/page', '', 'local');
    const ids = [];
    for (let index = 1; index <= 25; index += 1) {
      ids.push(store.addMessage(session.id, {
        type: index % 2 === 0 ? 'assistant' : 'user',
        content: `message-${index}`,
      }).id);
    }

    // Walk the whole transcript through the pager and require the exact
    // transcript order back (the page cursor must not skip or repeat a row).
    const collected = [];
    let cursor = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = store.getSessionMessagesPage(session.id, { beforeTranscriptCursor: cursor, limit: 4 });
      collected.unshift(...page.messages.map((message) => message.content));
      if (!page.hasMoreBefore) break;
      cursor = page.beforeTranscriptCursor;
    }
    assert.deepEqual(collected, ids.map((_, index) => `message-${index + 1}`));
    assert.deepEqual(
      store.getSession(session.id).messages.map((message) => message.id),
      ids,
    );
  } finally {
    cleanup();
  }
});

test('a transcript whose sequence order differs from its timestamps keeps both reads honest', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const session = store.createSession('migrated copy', '/tmp/migrated', '', 'local');
    // A copy that appended an OLD turn after newer ones (copyMissingOrder-
    // MessagesToCanonicalSession preserves created_at while assigning fresh
    // sequences): sequence order and created_at order genuinely diverge.
    const newer = store.addMessage(session.id, { type: 'user', content: 'newer turn' });
    const olderCopy = store.addMessage(session.id, { type: 'user', content: 'older copied turn' });
    db.run('UPDATE cowork_messages SET created_at = 1000 WHERE id = ?', [olderCopy.id]);
    db.run('UPDATE cowork_messages SET created_at = 2000 WHERE id = ?', [newer.id]);

    // The full transcript is chronological (created_at-led) — the order the
    // runner, the compaction and the rewind path all assume.
    assert.deepEqual(
      store.getSession(session.id).messages.map((message) => message.content),
      ['older copied turn', 'newer turn'],
    );
    // The page window follows the transcript (created_at) too, so the newest
    // page is the later timestamp and the page below it is the migrated copy.
    const page = store.getSessionMessagesPage(session.id, { limit: 1 });
    assert.deepEqual(page.messages.map((message) => message.content), ['newer turn']);
    assert.equal(page.beforeSequence, null);
    assert.equal(typeof page.beforeTranscriptCursor, 'string');
    const below = store.getSessionMessagesPage(session.id, {
      beforeTranscriptCursor: page.beforeTranscriptCursor,
      limit: 1,
    });
    assert.deepEqual(below.messages.map((message) => message.content), ['older copied turn']);
    assert.equal(below.hasMoreBefore, false);
    // The A2A display window, by contrast, is sequence-led (insert order): the
    // migrated copy carries the highest sequence and opens its window.
    const displayPage = store.getSessionMessagesPage(session.id, { limit: 1, displayWindow: true });
    assert.deepEqual(displayPage.messages.map((message) => message.content), ['older copied turn']);
    assert.equal(displayPage.beforeSequence, 2);
  } finally {
    cleanup();
  }
});
