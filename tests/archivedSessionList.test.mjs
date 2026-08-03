import test from 'node:test';
import assert from 'node:assert/strict';

import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

const seed = async () => {
  const { db, cleanup } = await createSqliteStore();
  const store = createCoworkStore(db);

  const active = store.createSession('活跃的会话', '/tmp/a', '', 'local', [], 5);
  const arch1 = store.createSession('发布 MetaApp 复盘', '/tmp/b', '', 'local', [], 5);
  const arch2 = store.createSession('和 Nova 闲聊', '/tmp/c', '', 'local', [], 5, 'a2a', 'nova-gmid', 'Nova', null);
  const arch3 = store.createSession('别的 bot 的归档', '/tmp/d', '', 'local', [], 6);

  for (const id of [arch1.id, arch2.id, arch3.id]) {
    store.archiveSession(id);
    // ensure deterministic archived_at ordering
    db.run('UPDATE cowork_sessions SET archived_at = ? WHERE id = ?', [
      id === arch1.id ? 1000 : id === arch2.id ? 2000 : 3000,
      id,
    ]);
  }
  return { db, cleanup, store, active, arch1, arch2, arch3 };
};

test('listArchivedSessions returns only archived sessions, newest archive first', async () => {
  const { db, cleanup, store, active, arch1, arch2, arch3 } = await seed();
  try {
    const all = store.listArchivedSessions();
    assert.deepEqual(all.map((s) => s.id), [arch3.id, arch2.id, arch1.id]);
    assert.ok(!all.some((s) => s.id === active.id), 'active session excluded');
    assert.ok(all.every((s) => typeof s.archivedAt === 'number'), 'archivedAt populated');
    assert.equal(all[0].peerName, null);
    assert.equal(all[1].peerName, 'Nova');
    assert.equal(all[1].sessionType, 'a2a');
  } finally {
    cleanup();
  }
});

test('listArchivedSessions filters by metabot and by title/peer query', async () => {
  const { db, cleanup, store, arch1, arch2, arch3 } = await seed();
  try {
    assert.deepEqual(store.listArchivedSessions({ metabotId: 5 }).map((s) => s.id), [arch2.id, arch1.id]);
    assert.deepEqual(store.listArchivedSessions({ metabotId: 6 }).map((s) => s.id), [arch3.id]);

    assert.deepEqual(store.listArchivedSessions({ query: 'metaapp' }).map((s) => s.id), [arch1.id], 'title LIKE, case-insensitive');
    assert.deepEqual(store.listArchivedSessions({ query: 'nova' }).map((s) => s.id), [arch2.id], 'peer name LIKE');
    assert.deepEqual(store.listArchivedSessions({ query: '%' }).length, 0, 'wildcards escaped');
    assert.deepEqual(store.listArchivedSessions({ query: '不存在' }).length, 0);
  } finally {
    cleanup();
  }
});

test('listArchivedSessions honors limit and offset', async () => {
  const { db, cleanup, store, arch1, arch2, arch3 } = await seed();
  try {
    const page1 = store.listArchivedSessions({ limit: 2 });
    assert.deepEqual(page1.map((s) => s.id), [arch3.id, arch2.id]);
    const page2 = store.listArchivedSessions({ limit: 2, offset: 2 });
    assert.deepEqual(page2.map((s) => s.id), [arch1.id]);
  } finally {
    cleanup();
  }
});
