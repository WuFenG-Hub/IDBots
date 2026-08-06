import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createLegacyMemoryDb,
  createSqliteStore,
} from './memoryTestUtils.mjs';

let MetaIDExperienceStore;
let GroupTaskStore;
let backfillMetaIDPrivateA2AExperiences;
let backfillMetaIDServiceOrderExperiences;
let backfillMetaIDGroupTaskExperiences;
let runMetaIDExperienceBackfill;
try {
  ({ MetaIDExperienceStore } = await import('../dist-electron/main/metaidExperienceStore.js'));
  ({ GroupTaskStore } = await import('../dist-electron/main/groupTaskStore.js'));
  ({
    backfillMetaIDPrivateA2AExperiences,
    backfillMetaIDServiceOrderExperiences,
    backfillMetaIDGroupTaskExperiences,
    runMetaIDExperienceBackfill,
  } = await import('../dist-electron/main/services/metaidExperienceBackfillService.js'));
} catch {
  ({ MetaIDExperienceStore } = await import('../dist-electron/metaidExperienceStore.js'));
  ({ GroupTaskStore } = await import('../dist-electron/groupTaskStore.js'));
  ({
    backfillMetaIDPrivateA2AExperiences,
    backfillMetaIDServiceOrderExperiences,
    backfillMetaIDGroupTaskExperiences,
    runMetaIDExperienceBackfill,
  } = await import('../dist-electron/services/metaidExperienceBackfillService.js'));
}

const OWNER = 'idq1owner';
const PEER = 'idq1peer';

function addPrivateTables(db) {
  db.run(`
    CREATE TABLE private_chat_messages (
      id INTEGER PRIMARY KEY,
      pin_id TEXT UNIQUE NOT NULL,
      tx_id TEXT,
      from_global_metaid TEXT,
      to_global_metaid TEXT,
      content TEXT,
      reply_pin TEXT,
      chain_timestamp INTEGER,
      created_at TEXT
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS cowork_conversation_mappings (
      channel TEXT NOT NULL,
      external_conversation_id TEXT NOT NULL,
      metabot_id INTEGER NOT NULL,
      cowork_session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0,
      last_active_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (channel, external_conversation_id, metabot_id)
    );
  `);
  db.run(`
    INSERT INTO cowork_conversation_mappings
      (channel, external_conversation_id, metabot_id, cowork_session_id, created_at, last_active_at)
    VALUES ('metaweb_private', 'metaweb-private:${PEER}', 1, 'session-peer', 0, 0);
  `);
}

test('private A2A backfill is conservative and converges on the live source key', async () => {
  const db = await createLegacyMemoryDb();
  addPrivateTables(db);
  db.run(`
    INSERT INTO private_chat_messages
      (id, pin_id, tx_id, from_global_metaid, to_global_metaid, content, reply_pin, chain_timestamp, created_at)
    VALUES
      (1, 'private-pin-i0', 'private-tx', '${PEER}', '${OWNER}', 'A useful collaboration turn', '', 1700000000, '2023-11-14T22:13:20.000Z'),
      (2, 'bad-pin-i0', 'bad-tx', '', '${OWNER}', 'Name-only legacy row', '', 1700000001, '2023-11-14T22:13:21.000Z'),
      (3, 'cipher-pin-i0', 'cipher-tx', '${PEER}', '${OWNER}', 'U2FsdGVkX1ciphertext', '', 1700000002, '2023-11-14T22:13:22.000Z');
  `);
  const store = new MetaIDExperienceStore(db, () => {}, () => 1800000000000);
  const first = backfillMetaIDPrivateA2AExperiences({
    db,
    experienceStore: store,
    localIdentities: [{ metabotId: 1, globalMetaID: OWNER }],
  });
  const second = backfillMetaIDPrivateA2AExperiences({
    db,
    experienceStore: store,
    localIdentities: [{ metabotId: 1, globalMetaID: OWNER }],
  });

  assert.equal(first.recorded, 1);
  assert.equal(first.skipped, 2);
  assert.equal(second.recorded, 1);
  assert.equal(store.listEpisodes({ ownerGlobalMetaID: OWNER, subjectGlobalMetaID: PEER }).length, 1);
  const episode = store.listEpisodes({ ownerGlobalMetaID: OWNER, subjectGlobalMetaID: PEER })[0];
  assert.equal(store.listEvidence(episode.id).length, 1);
  assert.equal(store.listEvidence(episode.id)[0].occurredAt, 1700000000000);
});

test('service-order backfill reconstructs factual lifecycle events without name inference', async () => {
  const db = await createLegacyMemoryDb();
  const store = new MetaIDExperienceStore(db, () => {}, () => 1800000000000);
  const order = {
    id: 'order-history-1',
    role: 'buyer',
    localMetabotId: 1,
    counterpartyGlobalMetaid: PEER,
    servicePinId: 'service-pin',
    orderPinId: 'order-pin',
    serviceName: 'Historical service',
    paymentTxid: 'payment-tx',
    paymentChain: 'mvc',
    paymentAmount: '1',
    paymentCurrency: 'SPACE',
    settlementKind: 'native',
    mrc20Ticker: null,
    mrc20Id: null,
    paymentCommitTxid: null,
    orderMessagePinId: 'order-message-pin',
    orderMessageTxid: 'order-message-tx',
    coworkSessionId: 'order-session',
    status: 'completed',
    firstResponseDeadlineAt: 1,
    deliveryDeadlineAt: 2,
    firstResponseAt: 1000,
    deliveryMessagePinId: 'delivery-pin',
    deliveredAt: 2000,
    ratingRequestedAt: 3000,
    ratingDeadlineAt: 4000,
    orderEndMessagePinId: 'end-pin',
    orderEndedAt: 5000,
    orderEndReason: 'rated',
    failedAt: null,
    failureReason: null,
    refundRequestPinId: null,
    refundFinalizePinId: null,
    refundTxid: null,
    refundRequestedAt: null,
    refundCompletedAt: null,
    refundApplyRetryCount: 0,
    nextRetryAt: null,
    createdAt: 0,
    updatedAt: 5000,
  };
  const first = backfillMetaIDServiceOrderExperiences({
    experienceStore: store,
    localIdentities: [{ metabotId: 1, globalMetaID: OWNER }],
    orders: [order],
  });
  const second = backfillMetaIDServiceOrderExperiences({
    experienceStore: store,
    localIdentities: [{ metabotId: 1, globalMetaID: OWNER }],
    orders: [order],
  });
  assert.equal(first.recorded, 5);
  assert.equal(second.recorded, 5);
  const episode = store.listEpisodes({ ownerGlobalMetaID: OWNER, subjectGlobalMetaID: PEER })[0];
  assert.equal(episode.status, 'completed');
  assert.deepEqual(store.listEvidence(episode.id).map((item) => item.metadata.event), [
    'created', 'first_response', 'delivered', 'rating_requested', 'order_ended',
  ]);
});

test('group-task backfill is owner-relative, idempotent, and preserves roster identities', async () => {
  const harness = await createSqliteStore();
  try {
    const { db } = harness;
    const groupTasks = new GroupTaskStore(db, () => {});
    const task = groupTasks.createTask({
      groupId: 'group-history',
      title: 'History task',
      goal: 'Recover prior facts',
      chairMetabotId: 1,
      createdBy: 'user',
    });
    db.run(
      `INSERT INTO group_task_members (task_id, metabot_id, globalmetaid, role)
       VALUES (?, ?, ?, 'chair'), (?, NULL, ?, 'worker')`,
      [task.id, 1, OWNER, task.id, PEER],
    );
    db.run(`
      INSERT INTO group_chat_messages (
        pin_id, tx_id, group_id, channel_id, sender_metaid, sender_global_metaid,
        sender_address, sender_name, sender_avatar, sender_chat_pubkey, protocol,
        content, content_type, encryption, reply_pin, mention, chain_timestamp,
        chain, raw_data, is_processed, msg_index
      ) VALUES ('group-pin-i0', 'group-tx', 'group-history', NULL, 'peer-metaid', '${PEER}',
        NULL, 'Peer', '', '', '/protocols/simplegroupchat', '[DELIVERABLE] pin',
        'text/plain', NULL, NULL, '[]', 1700000010, 'mvc', '{}', 1, 1)
    `);
    const experience = new MetaIDExperienceStore(db, () => {}, () => 1800000000000);
    const first = backfillMetaIDGroupTaskExperiences({
      db,
      experienceStore: experience,
      groupTaskStore: groupTasks,
      localIdentities: [{ metabotId: 1, globalMetaID: OWNER }],
    });
    const second = backfillMetaIDGroupTaskExperiences({
      db,
      experienceStore: experience,
      groupTaskStore: groupTasks,
      localIdentities: [{ metabotId: 1, globalMetaID: OWNER }],
    });
    assert.equal(first.recorded, 1);
    assert.equal(second.recorded, 1);
    const episode = experience.listEpisodes({ ownerGlobalMetaID: OWNER, subjectGlobalMetaID: PEER })[0];
    assert.equal(experience.listEvidence(episode.id).length, 1);
    assert.equal(experience.listParticipants(episode.id).find((item) => item.globalMetaID === PEER).role, 'worker');
  } finally {
    harness.cleanup();
  }
});

test('versioned runner marks each source independently and skips completed versions', async () => {
  const db = await createLegacyMemoryDb();
  const store = new MetaIDExperienceStore(db, () => {});
  const state = new Map();
  const logs = [];
  const deps = {
    db,
    experienceStore: store,
    migrationState: {
      get: (key) => state.get(key),
      set: (key, value) => state.set(key, value),
    },
    localIdentities: () => [{ metabotId: 1, globalMetaID: OWNER }],
    serviceOrders: () => [],
    emitLog: (message) => logs.push(message),
  };
  const first = runMetaIDExperienceBackfill(deps);
  const second = runMetaIDExperienceBackfill(deps);
  assert.equal(first.sources.filter((source) => source.status === 'completed').length, 1);
  assert.equal(second.sources.filter((source) => source.status === 'skipped').length, 3);
  assert.equal(logs.length, 3);
});
