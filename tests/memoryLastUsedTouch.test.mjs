import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCoworkStore,
  createLegacyMemoryDb,
  getRow,
} from './memoryTestUtils.mjs';

let buildScopedMemoryPromptBlocksDetailed;
try {
  ({ buildScopedMemoryPromptBlocksDetailed } = await import('../dist-electron/main/memory/memoryPromptBlocks.js'));
} catch {
  ({ buildScopedMemoryPromptBlocksDetailed } = await import('../dist-electron/main/memory/memoryPromptBlocks.js'));
}

function lastUsedAtOf(db, id) {
  return getRow(db, 'SELECT last_used_at AS last_used_at FROM user_memories WHERE id = ?', [id])?.last_used_at ?? null;
}

test('injection-scoped touch: only entries that render into the prompt get last_used_at bumped', async () => {
  const db = await createLegacyMemoryDb();
  const store = createCoworkStore(db);

  // Write-time text is capped at 360 chars, so the eviction scenario pads the
  // stored text directly (write-time dedupe must not merge the fixtures).
  const pad = (label) => label + 'x'.repeat(900 - label.length);
  const oldest = store.createUserMemory({
    metabotId: 1, text: 'gamma fact about juice', scopeKind: 'owner', scopeKey: 'owner:self',
  });
  const newest = store.createUserMemory({
    metabotId: 1, text: 'alpha fact about tea', scopeKind: 'owner', scopeKey: 'owner:self',
  });
  const mid = store.createUserMemory({
    metabotId: 1, text: 'beta fact about coffee', scopeKind: 'owner', scopeKey: 'owner:self',
  });
  db.run('UPDATE user_memories SET text = ?, updated_at = ? WHERE id = ?', [pad('c-oldest:'), 1000, oldest.id]);
  db.run('UPDATE user_memories SET text = ?, updated_at = ? WHERE id = ?', [pad('a-newest:'), 3000, newest.id]);
  db.run('UPDATE user_memories SET text = ?, updated_at = ? WHERE id = ?', [pad('b-mid:'), 2000, mid.id]);

  // The new per-turn call pattern: pool WITHOUT touching, build the detailed
  // blocks, touch only the ids that survived ranking + the char budget.
  const pool = store.listUserMemories({
    metabotId: 1,
    scopeKind: 'owner',
    scopeKey: 'owner:self',
    status: 'created',
    includeDeleted: false,
    limit: 200,
    offset: 0,
    touchLastUsed: false,
  });
  assert.equal(pool.length, 3);
  assert.equal(lastUsedAtOf(db, oldest.id), null, 'pooling alone must not touch last_used_at');
  assert.equal(lastUsedAtOf(db, newest.id), null);
  assert.equal(lastUsedAtOf(db, mid.id), null);

  const { xml, injectedIds } = buildScopedMemoryPromptBlocksDetailed({
    channel: 'cowork_ui',
    ownerEntries: pool,
    maxOwnerEntries: 12,
    maxTotalChars: 50, // below the 2000 clamp floor → budget is 2000, one eviction
  });
  assert.match(xml, /a-newest:/);
  assert.match(xml, /b-mid:/);
  assert.doesNotMatch(xml, /c-oldest:/);
  assert.deepEqual([...injectedIds].sort(), [mid.id, newest.id].sort());

  store.touchUserMemoriesLastUsed(1, injectedIds);

  assert.equal(lastUsedAtOf(db, oldest.id), null, 'pooled-but-evicted row keeps its old value');
  assert.ok(lastUsedAtOf(db, newest.id) > 0, 'injected row is touched');
  assert.ok(lastUsedAtOf(db, mid.id) > 0, 'injected row is touched');
});

test('listUserMemories touchLastUsed:true still bumps every returned row (legacy contract)', async () => {
  const db = await createLegacyMemoryDb();
  const store = createCoworkStore(db);

  const first = store.createUserMemory({
    metabotId: 1, text: 'alpha fact about tea', scopeKind: 'owner', scopeKey: 'owner:self',
  });
  const second = store.createUserMemory({
    metabotId: 1, text: 'beta fact about coffee', scopeKind: 'owner', scopeKey: 'owner:self',
  });
  assert.equal(lastUsedAtOf(db, first.id), null);

  const rows = store.listUserMemories({
    metabotId: 1,
    scopeKind: 'owner',
    scopeKey: 'owner:self',
    status: 'created',
    touchLastUsed: true,
  });
  assert.equal(rows.length, 2);
  assert.ok(lastUsedAtOf(db, first.id) > 0, 'touchLastUsed still covers the whole returned pool');
  assert.ok(lastUsedAtOf(db, second.id) > 0);
});
