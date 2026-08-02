import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCoworkStore,
  createSqliteStore,
  getIndexNames,
} from './memoryTestUtils.mjs';

test('cowork_sessions metabot/updated index is created by schema compatibility', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    createCoworkStore(db);
    assert.ok(getIndexNames(db, 'cowork_sessions').includes('idx_cowork_sessions_metabot_updated'));
  } finally {
    cleanup();
  }
});

test('listSessions filters by metabot id and surfaces metabotId in summaries', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);

    const botOne = store.createSession('bot one session', '/tmp/bot-one', '', 'local', [], 1);
    const botTwo = store.createSession('bot two session', '/tmp/bot-two', '', 'local', [], 2);
    store.createSession('unattributed session', '/tmp/legacy');

    const all = store.listSessions();
    assert.equal(all.length, 3);
    const summaryById = new Map(all.map((summary) => [summary.id, summary]));
    assert.equal(summaryById.get(botOne.id)?.metabotId, 1);
    assert.equal(summaryById.get(botTwo.id)?.metabotId, 2);

    const onlyBotOne = store.listSessions({ metabotId: 1 });
    assert.deepEqual(onlyBotOne.map((summary) => summary.id), [botOne.id]);
    assert.equal(onlyBotOne[0]?.metabotId, 1);

    const onlyBotTwo = store.listSessions({ metabotId: 2 });
    assert.deepEqual(onlyBotTwo.map((summary) => summary.id), [botTwo.id]);

    assert.deepEqual(store.listSessions({ metabotId: 999 }), []);
    // Non-positive ids are treated as "no filter" for backward compatibility.
    assert.equal(store.listSessions({ metabotId: 0 }).length, 3);
    assert.equal(store.listSessions({ metabotId: null }).length, 3);
  } finally {
    cleanup();
  }
});
