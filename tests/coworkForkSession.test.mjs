// forkSession regression: copied messages must take FRESH ids (cowork_messages.id
// is a global PK — reusing source ids threw UNIQUE and leaked an orphan session),
// and zero-message failed-fork orphans are swept at store construction.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

const seedConversation = (store) => {
  const session = store.createSession('源会话', '/tmp/x', 'base prompt', 'local', [], 5);
  const first = store.addMessage(session.id, { type: 'user', content: 'first question' });
  const second = store.addMessage(session.id, { type: 'assistant', content: 'first answer' });
  const third = store.addMessage(session.id, { type: 'user', content: 'second question' });
  const fourth = store.addMessage(session.id, { type: 'assistant', content: 'second answer' });
  return { session, messages: [first, second, third, fourth] };
};

test('forkSession copies history up to the fork point with fresh message ids', async () => {
  const { cleanup, store } = await createSqliteStore().then((r) => ({
    cleanup: r.cleanup, store: createCoworkStore(r.db),
  }));
  try {
    const { session, messages } = seedConversation(store);
    const forkPoint = messages[1]; // branch at the FIRST assistant reply

    const forked = store.forkSession(session.id, forkPoint.id, { title: '分支会话' });

    assert.ok(forked, 'forkSession succeeds (no UNIQUE violation on copied ids)');
    assert.equal(forked.title, '分支会话');
    assert.equal(forked.parentSessionId, session.id);
    assert.equal(forked.forkPointMessageId, forkPoint.id);
    assert.equal(forked.messages.length, 2, 'history up to and including the fork point is copied');
    assert.deepEqual(
      forked.messages.map((m) => `${m.type}:${m.content}`),
      ['user:first question', 'assistant:first answer'],
      'content, types and order are preserved'
    );
    const sourceIds = new Set(messages.map((m) => m.id));
    for (const copied of forked.messages) {
      assert.ok(!sourceIds.has(copied.id), 'copied message ids are fresh, not reused from the source');
    }
    assert.equal(
      store.getSessionMessages(session.id).length,
      4,
      'source conversation is untouched'
    );
  } finally {
    cleanup();
  }
});

test('a fork of a fork also succeeds (global id uniqueness holds across copies)', async () => {
  const { cleanup, store } = await createSqliteStore().then((r) => ({
    cleanup: r.cleanup, store: createCoworkStore(r.db),
  }));
  try {
    const { session, messages } = seedConversation(store);
    const firstFork = store.forkSession(session.id, messages[3].id);
    assert.ok(firstFork);
    store.addMessage(firstFork.id, { type: 'user', content: 'fork follow-up' });
    const secondFork = store.forkSession(firstFork.id, firstFork.messages[2].id);
    assert.ok(secondFork, 're-forking a fork does not collide message ids');
    assert.equal(secondFork.messages.length, 3);
  } finally {
    cleanup();
  }
});

test('store construction sweeps zero-message failed-fork orphan sessions only', async () => {
  const prepared = await createSqliteStore();
  const { db, cleanup } = prepared;
  try {
    const now = Date.now();
    // Real user DBs already carry the fork columns from earlier migrations;
    // a fresh base schema does not, so add it before seeding the orphan the
    // way a legacy failed fork left it behind.
    db.run('ALTER TABLE cowork_sessions ADD COLUMN parent_session_id TEXT');
    // Orphan from a failed fork: session row exists, parent set, zero messages.
    db.run(`INSERT INTO cowork_sessions (id, title, status, cwd, created_at, updated_at, parent_session_id)
            VALUES ('orphan-fork', 'x (fork)', 'idle', '/tmp/x', ?, ?, 'source-a')`, [now, now]);
    // A healthy fork (parent set, has messages) must survive the sweep.
    db.run(`INSERT INTO cowork_sessions (id, title, status, cwd, created_at, updated_at, parent_session_id)
            VALUES ('healthy-fork', 'y (fork)', 'idle', '/tmp/y', ?, ?, 'source-b')`, [now, now]);
    db.run(`INSERT INTO cowork_messages (id, session_id, type, content, created_at, sequence)
            VALUES ('healthy-fork-msg', 'healthy-fork', 'user', 'kept', ?, 1)`, [now]);
    // A user-created empty session WITHOUT a parent is legitimate; keep it.
    db.run(`INSERT INTO cowork_sessions (id, title, status, cwd, created_at, updated_at)
            VALUES ('plain-empty', 'draft', 'idle', '/tmp/z', ?, ?)`, [now, now]);

    const store = createCoworkStore(db);

    const probe = (id) => db.exec(`SELECT id FROM cowork_sessions WHERE id = '${id}'`).length;
    assert.equal(probe('orphan-fork'), 0, 'zero-message failed-fork orphan is swept');
    assert.equal(probe('healthy-fork'), 1, 'fork with copied messages survives');
    assert.equal(probe('plain-empty'), 1, 'ordinary empty session survives');
  } finally {
    cleanup();
  }
});
