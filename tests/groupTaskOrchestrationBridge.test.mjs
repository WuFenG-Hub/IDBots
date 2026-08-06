import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { MetabotStore } = require('../dist-electron/main/metabotStore.js');
const { GroupTaskStore } = require('../dist-electron/main/groupTaskStore.js');
const { OrchestrationStore } = require('../dist-electron/main/orchestrationStore.js');
const { GroupTaskOrchestrationBridge } = require('../dist-electron/main/services/groupTaskOrchestrationBridge.js');

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-group-task-orchestration-'));

async function makeHarness() {
  const sqliteStore = await SqliteStore.create(makeTempDir());
  const db = sqliteStore.getDatabase();
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at)
     VALUES (?, ?, ?, ?)`,
    [1, 'abandon ability able about above absent absorb abstract absurd abuse access accident bridge', "m/44'/10001'/0'/0/0", 1],
  );
  const insertBot = ({ id, name, type, globalmetaid, bossGlobalMetaId }) => {
    db.run(
      `INSERT INTO metabots (
        id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
        name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul,
        boss_global_metaid, created_at, updated_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, '0000', ?, ?, ?, 1, 1)`,
      [
        id, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `public-${id}`, `chat-public-${id}`,
        name, `metaid-${id}`, globalmetaid, type, `${name} role`, `${name} soul`, bossGlobalMetaId,
      ],
    );
  };
  insertBot({ id: 1, name: 'Twin Bot', type: 'twin', globalmetaid: 'gmid-twin', bossGlobalMetaId: 'gmid-owner' });
  insertBot({ id: 2, name: 'Builder Bot', type: 'worker', globalmetaid: 'gmid-worker', bossGlobalMetaId: 'gmid-owner' });

  const metabotStore = new MetabotStore(db, sqliteStore.getSaveFunction());
  const groupTaskStore = new GroupTaskStore(db, sqliteStore.getSaveFunction());
  const orchestrationStore = new OrchestrationStore(db, sqliteStore.getSaveFunction());
  const bridge = new GroupTaskOrchestrationBridge({
    groupTaskStore,
    orchestrationStore,
    getMetabotById: (id) => metabotStore.getMetabotById(id),
  });
  const groupTask = groupTaskStore.createTask({
    groupId: 'group-bridge',
    title: 'Build MetaApp',
    goal: 'Build and verify a MetaID knowledge MetaApp',
    acceptanceCriteria: 'A verifiable MetaApp PinID is delivered',
    chairMetabotId: 1,
    createdBy: 'user',
  });
  groupTaskStore.addMember({
    taskId: groupTask.id,
    metabotId: 1,
    globalmetaid: 'gmid-twin',
    role: 'chair',
  });
  groupTaskStore.addMember({
    taskId: groupTask.id,
    metabotId: 2,
    globalmetaid: 'gmid-worker',
    role: 'worker',
  });
  return { sqliteStore, groupTaskStore, orchestrationStore, bridge, groupTask };
}

test('Group Task canonical linking is lazy, durable, and idempotent', async () => {
  const h = await makeHarness();
  try {
    const canonical = h.bridge.ensureCanonicalTask(h.groupTask.id);
    assert.equal(canonical.status, 'planning');
    assert.equal(canonical.ownerGlobalMetaId, 'gmid-owner');
    assert.equal(canonical.twinMetabotId, 1);
    assert.equal(canonical.sourceSessionId, `group-task:${h.groupTask.id}`);
    assert.equal(h.groupTaskStore.getTaskById(h.groupTask.id).orchestrationTaskId, canonical.id);
    assert.equal(h.bridge.ensureCanonicalTask(h.groupTask.id).id, canonical.id);
    assert.equal(h.orchestrationStore.listActiveTasks().length, 1);
  } finally {
    h.sqliteStore.close();
  }
});

test('Worker handoff, deliverable evidence, review, and owner acceptance close both models', async () => {
  const h = await makeHarness();
  try {
    const started = h.bridge.beginWorkerAttempt({
      groupTaskId: h.groupTask.id,
      workerMetabotId: 2,
      objective: 'Build the MetaApp and return its PinID',
      sourceMessageKey: 'assignment-pin-i0',
    });
    assert.equal(started.task.status, 'running');
    assert.equal(started.step.status, 'queued');
    assert.equal(started.attempt.status, 'queued');
    assert.equal(h.bridge.beginWorkerAttempt({
      groupTaskId: h.groupTask.id,
      workerMetabotId: 2,
      objective: 'duplicate message must not create another attempt',
      sourceMessageKey: 'assignment-pin-i0',
    }).attempt.id, started.attempt.id);

    h.bridge.markWorkerAttemptRunning(started.attempt.id, 'group-worker-session');
    h.bridge.completeWorkerAttempt({
      attemptId: started.attempt.id,
      replyText: '[DELIVERABLE] metaapp: metaapp://abc',
      groupMessagePinId: 'deliverable-message-i0',
    });
    assert.equal(h.orchestrationStore.getAttempt(started.attempt.id).status, 'completed');
    assert.equal(h.orchestrationStore.getStep(started.step.id).status, 'waiting_input');

    const deliverable = h.groupTaskStore.addDeliverable({
      taskId: h.groupTask.id,
      msgPinId: 'deliverable-message-i0',
      authorGlobalmetaid: 'gmid-worker',
      kind: 'metaapp',
      uri: 'metaapp://abc',
    });
    h.bridge.recordDeliverable({
      groupTaskId: h.groupTask.id,
      deliverable,
      verificationNotes: ['Host verification: MetaApp PinID found on-chain.'],
    });
    const result = h.orchestrationStore.getAttempt(started.attempt.id).result;
    assert.equal(result.deliverables.length, 1);
    assert.equal(result.deliverables[0].groupTaskDeliverableId, deliverable.id);

    h.groupTaskStore.updateTaskStatus(h.groupTask.id, 'executing');
    h.bridge.syncStatus(h.groupTask.id);
    h.groupTaskStore.updateTaskStatus(h.groupTask.id, 'review');
    assert.equal(h.bridge.syncStatus(h.groupTask.id).status, 'review');

    const accepted = h.bridge.acceptGroupTask(h.groupTask.id);
    assert.equal(accepted.groupTask.status, 'done');
    assert.equal(accepted.canonicalTask.status, 'completed');
    assert.equal(h.orchestrationStore.getStep(started.step.id).status, 'completed');
    assert.equal(h.groupTaskStore.listDeliverables(h.groupTask.id)[0].status, 'accepted');
  } finally {
    h.sqliteStore.close();
  }
});

test('cancelling a Group Task cancels its canonical attempts and steps', async () => {
  const h = await makeHarness();
  try {
    const started = h.bridge.beginWorkerAttempt({
      groupTaskId: h.groupTask.id,
      workerMetabotId: 2,
      objective: 'Long-running work',
      sourceMessageKey: 'cancel-assignment-i0',
    });
    h.bridge.markWorkerAttemptRunning(started.attempt.id, 'group-worker-session');
    const cancelled = h.bridge.cancelGroupTask(h.groupTask.id);
    assert.equal(cancelled.groupTask.status, 'cancelled');
    assert.equal(cancelled.canonicalTask.status, 'cancelled');
    assert.equal(h.orchestrationStore.getStep(started.step.id).status, 'cancelled');
    assert.equal(h.orchestrationStore.getAttempt(started.attempt.id).status, 'cancelled');
  } finally {
    h.sqliteStore.close();
  }
});
