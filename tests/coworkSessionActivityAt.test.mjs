import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCoworkStore,
  createSqliteStore,
  getColumns,
  getRow,
} from './memoryTestUtils.mjs';

/**
 * cowork_sessions.activity_at is the session list's ordering key: the created_at
 * of the last activity message (a user turn or an on-chain A2A private DM synced
 * into the session). It replaced two correlated subqueries listSessions ran per
 * session on every list read — the exact value must survive the move:
 *  - the write paths stamp it for activity messages only (stream traffic must
 *    not reshuffle the sidebar),
 *  - pre-existing rows are backfilled once from the old computation,
 *  - an unstamped row still sorts through that computation as a fallback.
 */

/** The pre-column computation, verbatim: last activity message, else newest message, else updated_at. */
const legacyActivityAtSql = (sessionId) => `
  SELECT COALESCE((
    SELECT m.created_at
    FROM cowork_messages m
    WHERE m.session_id = '${sessionId}'
      AND (m.type = 'user' OR m.metadata LIKE '%"sourceChannel":"metaweb_private"%')
    ORDER BY m.created_at DESC
    LIMIT 1
  ), (
    SELECT m.created_at
    FROM cowork_messages m
    WHERE m.session_id = '${sessionId}'
    ORDER BY m.created_at DESC
    LIMIT 1
  ), s.updated_at) AS activity_at
  FROM cowork_sessions s WHERE s.id = '${sessionId}'
`;

const seedSession = (store, db, title, createdAt) => {
  const session = store.createSession(title, '/tmp/activity', '', 'local', [], null);
  db.run('UPDATE cowork_sessions SET created_at = ?, updated_at = ? WHERE id = ?', [
    createdAt,
    createdAt,
    session.id,
  ]);
  return session;
};

const setMessageCreatedAt = (db, messageId, createdAt) => {
  db.run('UPDATE cowork_messages SET created_at = ? WHERE id = ?', [createdAt, messageId]);
};

test('activity_at is added to existing databases and backfilled from the legacy computation', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    assert.ok(getColumns(db, 'cowork_sessions').includes('activity_at'));

    const userOnly = seedSession(store, db, 'user only', 1000);
    const assistantOnly = seedSession(store, db, 'assistant only', 2000);
    const privateDm = seedSession(store, db, 'private dm', 3000);

    setMessageCreatedAt(db, store.addMessage(userOnly.id, { type: 'user', content: 'hi' }).id, 1500);
    setMessageCreatedAt(db, store.addMessage(assistantOnly.id, { type: 'assistant', content: 'thinking' }).id, 2500);
    const dm = store.addMessage(privateDm.id, {
      type: 'assistant',
      content: 'morning report',
      metadata: { sourceChannel: 'metaweb_private', direction: 'outgoing' },
    });
    setMessageCreatedAt(db, dm.id, 3500);

    // Simulate a database written before the column existed: values cleared,
    // which is exactly what an upgraded user's rows look like on first boot.
    db.run('UPDATE cowork_sessions SET activity_at = NULL');
    for (const session of [userOnly, assistantOnly, privateDm]) {
      assert.equal(getRow(db, 'SELECT activity_at FROM cowork_sessions WHERE id = ?', [session.id]).activity_at, null);
      assert.equal(
        getRow(db, legacyActivityAtSql(session.id)).activity_at,
        [1500, 2500, 3500][[userOnly, assistantOnly, privateDm].indexOf(session)],
      );
    }

    const firstPass = store.runHeavyStartupMaintenance();
    assert.equal(firstPass.backfilledSessionActivityAt, 3);
    for (const [session, expected] of [[userOnly, 1500], [assistantOnly, 2500], [privateDm, 3500]]) {
      assert.equal(
        getRow(db, 'SELECT activity_at FROM cowork_sessions WHERE id = ?', [session.id]).activity_at,
        expected,
      );
    }

    // Idempotent and re-entrant: a second pass touches nothing (an interrupted
    // boot continues from where it stopped instead of redoing the whole sweep).
    const secondPass = store.runHeavyStartupMaintenance();
    assert.equal(secondPass.backfilledSessionActivityAt, 0);
    db.run('UPDATE cowork_sessions SET activity_at = NULL WHERE id = ?', [privateDm.id]);
    assert.equal(store.runHeavyStartupMaintenance().backfilledSessionActivityAt, 1);
    assert.equal(getRow(db, 'SELECT activity_at FROM cowork_sessions WHERE id = ?', [privateDm.id]).activity_at, 3500);
  } finally {
    cleanup();
  }
});

test('listSessions orders by the stored activity key exactly as the subquery computation did', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const streamedAfterTurn = seedSession(store, db, 'streamed after turn', 1000);
    const streamOnly = seedSession(store, db, 'stream only', 2000);
    const busierTurn = seedSession(store, db, 'busier turn', 3000);

    const streamedTurn = store.addMessage(streamedAfterTurn.id, { type: 'user', content: 'ask' });
    setMessageCreatedAt(db, streamedTurn.id, 5000);
    const lateChunk = store.addMessage(streamedAfterTurn.id, { type: 'assistant', content: 'stream chunk' });
    setMessageCreatedAt(db, lateChunk.id, 9000);

    const streamOnlyChunk = store.addMessage(streamOnly.id, { type: 'assistant', content: 'no user turn yet' });
    setMessageCreatedAt(db, streamOnlyChunk.id, 8000);

    const busierTurnMessage = store.addMessage(busierTurn.id, { type: 'user', content: 'ask' });
    setMessageCreatedAt(db, busierTurnMessage.id, 7000);

    // Keys are derived from the transcript exactly as an upgraded database
    // derives them (write paths stamp Date.now() at insert; the backfill folds
    // the preserved timestamps in).
    db.run('UPDATE cowork_sessions SET activity_at = NULL');
    store.runHeavyStartupMaintenance();

    // Ordering is unchanged by the column: a session whose last activity is a
    // user turn keeps that turn's time even though a later stream chunk exists,
    // and a session with no activity message at all still falls back to its
    // newest message.
    assert.deepEqual(
      store.listSessions().map((session) => session.id),
      [streamOnly.id, busierTurn.id, streamedAfterTurn.id],
    );
    assert.deepEqual(
      store.listSessions().map((session) => session.updatedAt),
      [8000, 7000, 5000],
    );

    // Reproduce the legacy ORDER BY on the same rows and require an identical
    // sequence — stored column and computation may not drift.
    const legacyOrder = db.exec(`
      SELECT s.id,
        COALESCE((
          SELECT m.created_at FROM cowork_messages m
          WHERE m.session_id = s.id
            AND (m.type = 'user' OR m.metadata LIKE '%"sourceChannel":"metaweb_private"%')
          ORDER BY m.created_at DESC LIMIT 1
        ), (
          SELECT m.created_at FROM cowork_messages m
          WHERE m.session_id = s.id ORDER BY m.created_at DESC LIMIT 1
        ), s.updated_at) AS activity_at
      FROM cowork_sessions s
      WHERE COALESCE(s.hidden_from_session_list, 0) = 0
        AND s.archived_at IS NULL
      ORDER BY s.pinned DESC, activity_at DESC, s.updated_at DESC, s.created_at DESC, s.id DESC
    `);
    const legacyIds = (legacyOrder[0]?.values ?? []).map((row) => String(row[0]));
    assert.deepEqual(legacyIds, store.listSessions().map((session) => session.id));
  } finally {
    cleanup();
  }
});

test('only activity messages move the stored key, monotonically', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const session = seedSession(store, db, 'activity', 1000);
    const activityAt = () => getRow(db, 'SELECT activity_at FROM cowork_sessions WHERE id = ?', [session.id]).activity_at;

    // A session with no activity message yet stays unstamped: the list keeps
    // computing its key (newest message, then updated_at) as it always did.
    store.addMessage(session.id, { type: 'assistant', content: 'boot' });
    assert.equal(activityAt(), null);

    const userMessage = store.addMessage(session.id, { type: 'user', content: 'ask' });
    assert.ok(activityAt() > 0);

    // Assistant/tool/system stream traffic never bumps it.
    const stamped = activityAt();
    store.addMessage(session.id, { type: 'assistant', content: 'stream chunk', metadata: { isStreaming: true } });
    store.addMessage(session.id, { type: 'tool_use', content: 'search' });
    store.addMessage(session.id, { type: 'system', content: 'notice' });
    assert.equal(activityAt(), stamped);

    // A daemon-synced private DM does, and an older migrated copy cannot sink it.
    const privateDm = store.addMessage(session.id, {
      type: 'assistant',
      content: 'morning report',
      metadata: { sourceChannel: 'metaweb_private', direction: 'outgoing' },
    });
    assert.ok(activityAt() > stamped);

    // The stamp is monotonic: a later insert whose created_at is older (a
    // migrated/legacy copy) leaves the newest value in place. Staged with a
    // far-future stamp precisely because insert time is Date.now().
    db.run('UPDATE cowork_sessions SET activity_at = ? WHERE id = ?', [9_000_000_000_000, session.id]);
    store.addMessage(session.id, { type: 'user', content: 'legacy copy' });
    assert.equal(activityAt(), 9_000_000_000_000, 'an older timestamp never lowers the stamp');
    assert.ok(privateDm.id);
  } finally {
    cleanup();
  }
});

test('rewinding to a point before the last user turn recomputes the key', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const session = seedSession(store, db, 'rewind', 1000);
    const anchor = store.addMessage(session.id, { type: 'user', content: 'first' });
    const tail = store.addMessage(session.id, { type: 'user', content: 'second' });
    setMessageCreatedAt(db, anchor.id, 2000);
    setMessageCreatedAt(db, tail.id, 3000);
    store.rewindSession(session.id, anchor.id);
    assert.equal(getRow(db, 'SELECT activity_at FROM cowork_sessions WHERE id = ?', [session.id]).activity_at, 2000);
  } finally {
    cleanup();
  }
});
