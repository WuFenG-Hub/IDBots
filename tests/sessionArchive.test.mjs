import test from 'node:test';
import assert from 'node:assert/strict';

import { createCoworkStore, createSqliteStore, getRow } from './memoryTestUtils.mjs';

let DreamStore;
try {
  ({ DreamStore } = await import('../dist-electron/main/dreamStore.js'));
} catch {
  ({ DreamStore } = await import('../dist-electron/dreamStore.js'));
}

const DAY_START = new Date(2026, 6, 30).getTime();
const DAY_END = new Date(2026, 6, 31).getTime();

test('archived sessions leave the list but keep every record, and unarchive restores them', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const keep = store.createSession('保留的会话', '/tmp/a', '', 'local', [], 5);
    const archived = store.createSession('要归档的会话', '/tmp/b', '', 'local', [], 5);
    store.addMessage(archived.id, { type: 'user', content: '这条消息不能因为归档而丢' });

    assert.equal(store.isSessionArchived(archived.id), false);
    store.archiveSession(archived.id);
    assert.equal(store.isSessionArchived(archived.id), true);

    // Archived sessions are excluded from the UI list (with and without bot filter).
    assert.deepEqual(store.listSessions().map((s) => s.id), [keep.id]);
    assert.deepEqual(store.listSessions({ metabotId: 5 }).map((s) => s.id), [keep.id]);

    // But the session row and all of its messages are preserved.
    const sessionRow = getRow(db, 'SELECT id, archived_at FROM cowork_sessions WHERE id = ?', [archived.id]);
    assert.ok(sessionRow?.archived_at != null);
    const messageRow = getRow(db, 'SELECT content FROM cowork_messages WHERE session_id = ?', [archived.id]);
    assert.equal(messageRow?.content, '这条消息不能因为归档而丢');

    store.unarchiveSession(archived.id);
    assert.equal(store.isSessionArchived(archived.id), false);
    assert.equal(store.listSessions().length, 2);
  } finally {
    cleanup();
  }
});

test('dream activity still sees archived sessions (archive is not deletion)', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const dreamStore = new DreamStore(db, () => {});

    const session = store.createSession('归档前的工作', '/tmp/c', '', 'local', [], 5);
    db.run(
      'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['m1', session.id, 'user', '归档前聊的重要内容', '{}', DAY_START + 1000, 1]
    );
    store.archiveSession(session.id);

    const activity = dreamStore.getActivityForDate(5, DAY_START, DAY_END);
    assert.equal(activity.sessions.length, 1);
    assert.equal(activity.sessions[0].messages[0]?.content, '归档前聊的重要内容');
  } finally {
    cleanup();
  }
});
