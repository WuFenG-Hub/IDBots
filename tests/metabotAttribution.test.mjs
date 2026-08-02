import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCoworkStore,
  createSqliteStore,
  getRow,
} from './memoryTestUtils.mjs';

const insertMetabot = (db, id, type = 'worker') => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key,
      chat_public_key, name, metaid, metabot_type, created_by, role, soul,
      created_at, updated_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'test', 'role', 'soul', 1, 1)`,
    [
      id,
      `mvc-${id}`,
      `btc-${id}`,
      `doge-${id}`,
      `pk-${id}`,
      `chatpk-${id}`,
      `bot-${id}`,
      `metaid-${id}`,
      type,
    ]
  );
};

test('session-scoped memory attribution never falls back to another bot', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    insertMetabot(db, 1, 'twin');
    insertMetabot(db, 2, 'worker');

    const botTwoSession = store.createSession('bot two', '/tmp/bot-two', '', 'local', [], 2);
    const unattributedSession = store.createSession('legacy', '/tmp/legacy');

    // A session's own metabot_id is authoritative, even when it is not the default bot.
    assert.equal(store.resolveMetabotIdForMemory(botTwoSession.id), 2);
    // Unattributed or unknown sessions resolve to null instead of leaking into the default bot.
    assert.equal(store.resolveMetabotIdForMemory(unattributedSession.id), null);
    assert.equal(store.resolveMetabotIdForMemory('missing-session-id'), null);
    // Callers without any session context keep the legacy default-twin fallback.
    assert.equal(store.resolveMetabotIdForMemory(), 1);
    assert.equal(store.resolveMetabotIdForMemory(undefined), 1);
    assert.equal(store.resolveMetabotIdForMemory(null), 1);
  } finally {
    cleanup();
  }
});

test('deleting a metabot preserves its sessions and memories as historical attribution', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    insertMetabot(db, 1, 'twin');
    insertMetabot(db, 2, 'worker');

    const session = store.createSession('bot two work', '/tmp/bot-two', '', 'local', [], 2);
    const memory = store.createUserMemory({
      metabotId: 2,
      text: 'The client prefers concise weekly reports',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
    });

    // Mirrors MetabotStore.deleteMetabot: only the metabots row is removed.
    db.run('DELETE FROM metabots WHERE id = ?', [2]);

    const sessionRow = getRow(db, 'SELECT metabot_id FROM cowork_sessions WHERE id = ?', [session.id]);
    assert.equal(sessionRow?.metabot_id, 2);

    const memoryRow = getRow(db, 'SELECT metabot_id, status FROM user_memories WHERE id = ?', [memory.id]);
    assert.equal(memoryRow?.metabot_id, 2);
    assert.equal(memoryRow?.status, 'created');
  } finally {
    cleanup();
  }
});
