import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCoworkStore,
  createLegacyMemoryDb,
} from './memoryTestUtils.mjs';

function insertSession(db, row) {
  db.run(`
    INSERT INTO cowork_sessions
      (id, title, status, cwd, metabot_id, session_type, peer_global_metaid, peer_name, created_at, updated_at)
    VALUES (?, ?, 'idle', '/tmp', ?, ?, ?, ?, ?, ?)
  `, [
    row.id,
    row.title ?? '',
    row.metabotId ?? 1,
    row.sessionType ?? 'standard',
    row.peerGlobalMetaId ?? null,
    row.peerName ?? null,
    row.createdAt ?? 1,
    row.updatedAt ?? 1,
  ]);
}

test('listMemoryScopes groups owner/contact/conversation with counts and peer names', async () => {
  const db = await createLegacyMemoryDb();
  const store = createCoworkStore(db);

  insertSession(db, {
    id: 'sess-alice',
    sessionType: 'a2a',
    peerGlobalMetaId: 'idq-peer-alice',
    peerName: 'Alice',
    updatedAt: 10,
  });

  store.createUserMemory({
    metabotId: 1,
    text: 'Owner fact',
    scopeKind: 'owner',
    scopeKey: 'owner:self',
  });
  const aliceOne = store.createUserMemory({
    metabotId: 1,
    text: 'Alice prefers English',
    scopeKind: 'contact',
    scopeKey: 'metaweb_private:peer:idq-peer-alice',
  });
  store.createUserMemory({
    metabotId: 1,
    text: 'Alice likes concise replies',
    scopeKind: 'contact',
    scopeKey: 'metaweb_private:peer:idq-peer-alice',
  });
  store.createUserMemory({
    metabotId: 1,
    text: 'Bob fact',
    scopeKind: 'contact',
    scopeKey: 'metaweb_private:peer:idq-peer-bob',
  });
  store.createUserMemory({
    metabotId: 1,
    text: 'Order context',
    scopeKind: 'conversation',
    scopeKey: 'metaweb_order:conversation:order-1',
  });

  // Deleted entries must not count towards the scope aggregates.
  db.run('UPDATE user_memories SET status = ? WHERE id = ?', ['deleted', aliceOne.id]);

  const overview = store.listMemoryScopes(1);

  assert.equal(overview.owner.kind, 'owner');
  assert.equal(overview.owner.key, 'owner:self');
  assert.equal(overview.owner.count, 1);

  assert.equal(overview.contacts.length, 2);
  const alice = overview.contacts.find((scope) => scope.peerGlobalMetaId === 'idq-peer-alice');
  assert.equal(alice.key, 'metaweb_private:peer:idq-peer-alice');
  assert.equal(alice.count, 1);
  assert.equal(alice.peerName, 'Alice');
  const bob = overview.contacts.find((scope) => scope.peerGlobalMetaId === 'idq-peer-bob');
  assert.equal(bob.count, 1);
  assert.equal(bob.peerName, null);

  assert.equal(overview.conversations.length, 1);
  assert.equal(overview.conversations[0].key, 'metaweb_order:conversation:order-1');
  assert.equal(overview.conversations[0].count, 1);
});

test('listMemoryScopes always returns an owner scope even when empty', async () => {
  const db = await createLegacyMemoryDb();
  const store = createCoworkStore(db);

  const overview = store.listMemoryScopes(1);

  assert.equal(overview.owner.kind, 'owner');
  assert.equal(overview.owner.key, 'owner:self');
  assert.equal(overview.owner.count, 0);
  assert.deepEqual(overview.contacts, []);
  assert.deepEqual(overview.conversations, []);
});

test('listMemoryScopes does not leak scopes across MetaBots', async () => {
  const db = await createLegacyMemoryDb();
  const store = createCoworkStore(db);

  db.run("INSERT INTO metabots (id, name, avatar, metabot_type) VALUES (2, 'Second', NULL, 'twin')");

  store.createUserMemory({
    metabotId: 1,
    text: 'Bot 1 owner fact',
    scopeKind: 'owner',
    scopeKey: 'owner:self',
  });
  store.createUserMemory({
    metabotId: 2,
    text: 'Bot 2 owner fact',
    scopeKind: 'owner',
    scopeKey: 'owner:self',
  });
  store.createUserMemory({
    metabotId: 2,
    text: 'Bot 2 contact fact',
    scopeKind: 'contact',
    scopeKey: 'metaweb_private:peer:idq-peer-bot2',
  });

  const overviewBot1 = store.listMemoryScopes(1);
  assert.equal(overviewBot1.owner.count, 1);
  assert.equal(overviewBot1.contacts.length, 0);

  const overviewBot2 = store.listMemoryScopes(2);
  assert.equal(overviewBot2.owner.count, 1);
  assert.equal(overviewBot2.contacts.length, 1);
  assert.equal(overviewBot2.contacts[0].peerGlobalMetaId, 'idq-peer-bot2');
});
