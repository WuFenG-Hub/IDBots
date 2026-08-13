import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { GroupTaskStore } = require('../dist-electron/main/groupTaskStore.js');

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-acceptance-store-'));

const openStores = async (tempDir) => {
  const store = await SqliteStore.create(tempDir);
  const groupTaskStore = new GroupTaskStore(store.getDatabase(), store.getSaveFunction());
  return { store, groupTaskStore, db: store.getDatabase() };
};

const insertWallet = (db, id) => {
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at) VALUES (?, ?, ?, ?)`,
    [id, `abandon ability able about above absent absorb abstract absurd abuse access accident ${id}`, "m/44'/10001'/0'/0/0", 1700000000000 + id],
  );
};

const insertMetabot = (db, { id, walletId, name, type = 'worker', globalmetaid = null }) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, walletId, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `public-${id}`, `chat-public-${id}`,
      name, 1, `metaid-${id}`, globalmetaid, type, '0000', `${name} role`, `${name} soul`,
      1700000000000 + id, 1700000000000 + id,
    ],
  );
};

const getColumns = (db, tableName) => {
  const result = db.exec(`PRAGMA table_info(${tableName})`);
  return (result[0]?.values || []).map((row) => String(row[1]));
};

const getIndexNames = (db, tableName) => {
  const result = db.exec(`PRAGMA index_list(${tableName})`);
  return (result[0]?.values || []).map((row) => String(row[1]));
};

const seedTask = (groupTaskStore, overrides = {}) =>
  groupTaskStore.createTask({
    groupId: overrides.groupId ?? `group-${Math.random().toString(36).slice(2)}`,
    title: overrides.title ?? 'Demo task',
    goal: overrides.goal ?? 'Build a demo',
    acceptanceCriteria: overrides.acceptanceCriteria ?? null,
    chairMetabotId: overrides.chairMetabotId ?? 1,
    createdBy: overrides.createdBy ?? 'user',
    createPinId: overrides.createPinId ?? 'pin-create',
  });

test('group_task_acceptance_summaries table + index are created on open', async () => {
  const tempDir = makeTempDir();
  const { store, db } = await openStores(tempDir);
  try {
    const cols = getColumns(db, 'group_task_acceptance_summaries');
    for (const col of ['id', 'task_id', 'version', 'goal', 'deliverables_json', 'members_json', 'guidance', 'generated_by']) {
      assert.ok(cols.includes(col), `${col} column should exist`);
    }
    assert.ok(
      getIndexNames(db, 'group_task_acceptance_summaries').includes('idx_group_task_acceptance_summaries_task'),
      'task index should exist',
    );
  } finally {
    store.close();
  }
});

test('saveAcceptanceSummary assigns version 1 then increments on subsequent saves', async () => {
  const tempDir = makeTempDir();
  const { store, db, groupTaskStore } = await openStores(tempDir);
  try {
    insertWallet(db, 1);
    insertMetabot(db, { id: 1, walletId: 1, name: 'Twin', type: 'twin' });
    const task = seedTask(groupTaskStore);

    const v1 = groupTaskStore.saveAcceptanceSummary({
      taskId: task.id,
      goal: task.goal,
      acceptanceCriteria: 'ships the demo',
      deliverables: [{ kind: 'metaapp', uri: 'metaapp://abc', status: 'accepted', confirmation: 'confirmed', authorName: 'Lucy' }],
      members: [{ name: 'Lucy', role: 'worker', workStatus: 'working' }],
      guidance: 'guidance-v1',
    });
    assert.equal(v1.version, 1);
    assert.equal(v1.goal, 'Build a demo');
    assert.equal(v1.acceptanceCriteria, 'ships the demo');
    assert.equal(v1.deliverables.length, 1);
    assert.equal(v1.deliverables[0].uri, 'metaapp://abc');
    assert.equal(v1.members.length, 1);
    assert.equal(v1.generatedBy, 'host');
    assert.equal(v1.publishedGroupPinId, null);
    assert.equal(v1.notifiedSession, null);

    const v2 = groupTaskStore.saveAcceptanceSummary({
      taskId: task.id,
      goal: task.goal,
      deliverables: [],
      members: [],
      guidance: 'guidance-v2',
    });
    assert.equal(v2.version, 2);

    assert.equal(groupTaskStore.getLatestAcceptanceSummary(task.id).version, 2);
    assert.deepEqual(
      groupTaskStore.listAcceptanceSummaries(task.id).map((s) => s.version),
      [1, 2],
    );
  } finally {
    store.close();
  }
});

test('getLatestAcceptanceSummary returns null when none generated', async () => {
  const tempDir = makeTempDir();
  const { store, db, groupTaskStore } = await openStores(tempDir);
  try {
    insertWallet(db, 1);
    insertMetabot(db, { id: 1, walletId: 1, name: 'Twin', type: 'twin' });
    const task = seedTask(groupTaskStore);
    assert.equal(groupTaskStore.getLatestAcceptanceSummary(task.id), null);
    assert.deepEqual(groupTaskStore.listAcceptanceSummaries(task.id), []);
  } finally {
    store.close();
  }
});

test('updateAcceptanceSummaryPublishedPin + notifiedSession stamp the latest version only', async () => {
  const tempDir = makeTempDir();
  const { store, db, groupTaskStore } = await openStores(tempDir);
  try {
    insertWallet(db, 1);
    insertMetabot(db, { id: 1, walletId: 1, name: 'Twin', type: 'twin' });
    const task = seedTask(groupTaskStore);
    groupTaskStore.saveAcceptanceSummary({ taskId: task.id, goal: task.goal, deliverables: [], members: [], guidance: 'g1' });
    groupTaskStore.saveAcceptanceSummary({ taskId: task.id, goal: task.goal, deliverables: [], members: [], guidance: 'g2' });

    groupTaskStore.updateAcceptanceSummaryPublishedPin(task.id, 'pin-closing');
    groupTaskStore.updateAcceptanceSummaryNotifiedSession(task.id, 'session-origin');

    const latest = groupTaskStore.getLatestAcceptanceSummary(task.id);
    assert.equal(latest.version, 2);
    assert.equal(latest.publishedGroupPinId, 'pin-closing');
    assert.equal(latest.notifiedSession, 'session-origin');
    // v1 untouched.
    assert.equal(groupTaskStore.listAcceptanceSummaries(task.id)[0].publishedGroupPinId, null);
  } finally {
    store.close();
  }
});

test('finalizeAcceptanceSummary stamps outcome + rating on the latest version', async () => {
  const tempDir = makeTempDir();
  const { store, db, groupTaskStore } = await openStores(tempDir);
  try {
    insertWallet(db, 1);
    insertMetabot(db, { id: 1, walletId: 1, name: 'Twin', type: 'twin' });
    const task = seedTask(groupTaskStore);
    groupTaskStore.saveAcceptanceSummary({ taskId: task.id, goal: task.goal, deliverables: [], members: [], guidance: 'g1' });

    const finalized = groupTaskStore.finalizeAcceptanceSummary(task.id, {
      outcome: 'done',
      rating: 5,
      ratingComment: 'great',
    });
    assert.equal(finalized.outcome, 'done');
    assert.equal(finalized.rating, 5);
    assert.equal(finalized.ratingComment, 'great');
  } finally {
    store.close();
  }
});

test('finalizeAcceptanceSummary returns null when no summary exists', async () => {
  const tempDir = makeTempDir();
  const { store, db, groupTaskStore } = await openStores(tempDir);
  try {
    insertWallet(db, 1);
    insertMetabot(db, { id: 1, walletId: 1, name: 'Twin', type: 'twin' });
    const task = seedTask(groupTaskStore);
    assert.equal(
      groupTaskStore.finalizeAcceptanceSummary(task.id, { outcome: 'cancelled' }),
      null,
    );
  } finally {
    store.close();
  }
});
