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

test('listArchivedSessions searchContent matches message bodies only when enabled', async () => {
  const { db, cleanup, store, arch1, arch2 } = await seed();
  try {
    const bodyOnly = '只在正文出现的独特词 body-only-secret';
    const chineseBodyOnly = '正文独有中文词';
    db.run(
      "INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, 'assistant', ?, NULL, ?, 1)",
      ['m-body-1', arch1.id, `这段消息正文里包含 ${bodyOnly} 和 ${chineseBodyOnly}`, 5000],
    );
    db.run(
      "INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, 'user', ?, NULL, ?, 1)",
      ['m-body-2', arch2.id, bodyOnly, 5001],
    );

    // Without the toggle, body-only keywords must NOT match (title/peer search only).
    assert.equal(store.listArchivedSessions({ query: bodyOnly }).length, 0, 'body-only keyword misses without searchContent');
    assert.equal(store.countArchivedSessions({ query: bodyOnly }), 0, 'count agrees without searchContent');

    // With the toggle, both sessions whose bodies contain the keyword match.
    const hits = store.listArchivedSessions({ query: bodyOnly, searchContent: true }).map((s) => s.id).sort();
    assert.deepEqual(hits, [arch1.id, arch2.id].sort(), 'body-only keyword hits with searchContent');
    assert.equal(store.countArchivedSessions({ query: bodyOnly, searchContent: true }), 2, 'count agrees with searchContent');

    // Non-ASCII body content matches too.
    assert.deepEqual(
      store.listArchivedSessions({ query: chineseBodyOnly, searchContent: true }).map((s) => s.id),
      [arch1.id],
      'chinese body content matches with searchContent',
    );
    // Title matches still work alongside body search.
    assert.deepEqual(
      store.listArchivedSessions({ query: 'metaapp', searchContent: true }).map((s) => s.id),
      [arch1.id],
      'title match preserved when searchContent enabled',
    );
  } finally {
    cleanup();
  }
});
