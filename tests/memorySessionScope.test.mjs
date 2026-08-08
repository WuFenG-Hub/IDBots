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

function insertMapping(db, row) {
  db.run(`
    INSERT INTO cowork_conversation_mappings
      (channel, external_conversation_id, metabot_id, cowork_session_id, metadata_json, created_at, last_active_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    row.channel,
    row.externalConversationId,
    row.metabotId ?? 1,
    row.sessionId,
    row.metadataJson ?? '{}',
    row.createdAt ?? 1,
    row.updatedAt ?? 1,
  ]);
}

test('standard local session resolves to owner scope', async () => {
  const db = await createLegacyMemoryDb();
  const store = createCoworkStore(db);

  insertSession(db, { id: 'sess-local', title: 'Local chat' });

  const resolved = store.resolveMemoryScopeForSession('sess-local');
  assert.equal(resolved.metabotId, 1);
  assert.deepEqual(resolved.scope, { kind: 'owner', key: 'owner:self' });
  assert.equal(resolved.peerName, null);
});

test('metaweb private a2a session resolves to contact scope with peer name', async () => {
  const db = await createLegacyMemoryDb();
  const store = createCoworkStore(db);

  insertSession(db, {
    id: 'sess-a2a',
    title: 'A2A with Alice',
    sessionType: 'a2a',
    peerGlobalMetaId: 'idq-peer-alice',
    peerName: 'Alice',
  });
  insertMapping(db, {
    channel: 'metaweb_private',
    externalConversationId: 'metaweb-private:idq-peer-alice',
    sessionId: 'sess-a2a',
  });

  const resolved = store.resolveMemoryScopeForSession('sess-a2a');
  assert.equal(resolved.metabotId, 1);
  assert.equal(resolved.scope.kind, 'contact');
  assert.equal(resolved.scope.key, 'metaweb_private:peer:idq-peer-alice');
  assert.equal(resolved.peerName, 'Alice');
});

test('order session resolves to conversation scope', async () => {
  const db = await createLegacyMemoryDb();
  const store = createCoworkStore(db);

  insertSession(db, { id: 'sess-order', title: 'Order chat' });
  insertMapping(db, {
    channel: 'metaweb_order',
    externalConversationId: 'order-1',
    sessionId: 'sess-order',
  });

  const resolved = store.resolveMemoryScopeForSession('sess-order');
  assert.equal(resolved.metabotId, 1);
  assert.equal(resolved.scope.kind, 'conversation');
  assert.equal(resolved.scope.key, 'metaweb_order:conversation:order-1');
  assert.equal(resolved.peerName, null);
});

test('unknown session resolves to null instead of guessing a MetaBot', async () => {
  const db = await createLegacyMemoryDb();
  const store = createCoworkStore(db);

  assert.equal(store.resolveMemoryScopeForSession('missing-session'), null);
});

test('missing session context falls back to owner scope via the default MetaBot', async () => {
  const db = await createLegacyMemoryDb();
  const store = createCoworkStore(db);

  const resolved = store.resolveMemoryScopeForSession(null);
  assert.equal(resolved.metabotId, 1);
  assert.deepEqual(resolved.scope, { kind: 'owner', key: 'owner:self' });
});
