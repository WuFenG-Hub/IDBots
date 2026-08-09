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
    assert.equal(h.orchestrationStore.getAttempt(started.attempt.id).result.ownerAccepted, true);
    assert.equal(h.orchestrationStore.getAttempt(started.attempt.id).result.verified, false);
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

test('P0-1: failed noise steps do NOT block owner acceptance', async () => {
  const h = await makeHarness();
  try {
    // A real worker step that completed (waiting_input after completion)
    const real = h.bridge.beginWorkerAttempt({
      groupTaskId: h.groupTask.id,
      workerMetabotId: 2,
      objective: 'Build the MetaApp',
      sourceMessageKey: 'real-assignment-i0',
    });
    h.bridge.markWorkerAttemptRunning(real.attempt.id, 'session-real');
    h.bridge.completeWorkerAttempt({
      attemptId: real.attempt.id,
      replyText: '[DELIVERABLE] metaapp: metaapp://realpin',
      groupMessagePinId: 'real-deliverable-i0',
    });

    // A noise step that failed (mistaken mention whose skill routing failed)
    const noise = h.bridge.beginWorkerAttempt({
      groupTaskId: h.groupTask.id,
      workerMetabotId: 2,
      objective: 'noise message',
      sourceMessageKey: 'noise-message-i0',
    });
    h.bridge.failWorkerAttempt(noise.attempt.id, 'SKILL_ROUTING_FAILED');

    h.groupTaskStore.updateTaskStatus(h.groupTask.id, 'executing');
    h.bridge.syncStatus(h.groupTask.id);
    h.groupTaskStore.updateTaskStatus(h.groupTask.id, 'review');
    h.bridge.syncStatus(h.groupTask.id);

    // Acceptance must NOT throw despite the failed step
    const accepted = h.bridge.acceptGroupTask(h.groupTask.id);
    assert.equal(accepted.groupTask.status, 'done');
    assert.equal(accepted.canonicalTask.status, 'completed');
  } finally {
    h.sqliteStore.close();
  }
});

test('P0-1b: ignoreFailedSteps demotes noise steps to completed with an ignored marker', async () => {
  const h = await makeHarness();
  try {
    const noise = h.bridge.beginWorkerAttempt({
      groupTaskId: h.groupTask.id,
      workerMetabotId: 2,
      objective: 'noise',
      sourceMessageKey: 'noise-i0',
    });
    h.bridge.failWorkerAttempt(noise.attempt.id, 'SKILL_ROUTING_FAILED');
    assert.equal(h.orchestrationStore.getStep(noise.step.id).status, 'failed');

    const ignored = h.bridge.ignoreFailedSteps(h.groupTask.id);
    assert.equal(ignored, 1);
    const step = h.orchestrationStore.getStep(noise.step.id);
    assert.equal(step.status, 'completed');
    assert.equal(step.acceptedResult.ignored, true);

    // Real steps are untouched
    const real = h.bridge.beginWorkerAttempt({
      groupTaskId: h.groupTask.id,
      workerMetabotId: 2,
      objective: 'real',
      sourceMessageKey: 'real-i0',
    });
    assert.equal(h.orchestrationStore.getStep(real.step.id).status, 'queued');
    assert.equal(h.bridge.ignoreFailedSteps(h.groupTask.id), 0, 'no more failed steps to ignore');
  } finally {
    h.sqliteStore.close();
  }
});

// ---------------------------------------------------------------------------
// F6 (GT#11): close path — no-step close succeeds; unfinished steps produce a
// detailed, actionable error instead of the bare "unfinished canonical steps"
// ---------------------------------------------------------------------------

test('F6: owner acceptance closes a task with no canonical steps (nothing unfinished)', async () => {
  const h = await makeHarness();
  try {
    h.groupTaskStore.updateTaskStatus(h.groupTask.id, 'executing');
    h.bridge.syncStatus(h.groupTask.id);
    h.groupTaskStore.updateTaskStatus(h.groupTask.id, 'review');
    h.bridge.syncStatus(h.groupTask.id);

    const accepted = h.bridge.acceptGroupTask(h.groupTask.id);
    assert.equal(accepted.groupTask.status, 'done');
    assert.equal(accepted.canonicalTask.status, 'completed');
  } finally {
    h.sqliteStore.close();
  }
});

test('F6: close error names every unfinished step with its status and the remedy', async () => {
  const h = await makeHarness();
  try {
    const started = h.bridge.beginWorkerAttempt({
      groupTaskId: h.groupTask.id,
      workerMetabotId: 2,
      objective: 'Build the MetaApp',
      sourceMessageKey: 'f6-running-i0',
    });
    h.bridge.markWorkerAttemptRunning(started.attempt.id, 'group-worker-session');
    assert.equal(h.orchestrationStore.getStep(started.step.id).status, 'running');

    h.groupTaskStore.updateTaskStatus(h.groupTask.id, 'executing');
    h.bridge.syncStatus(h.groupTask.id);
    h.groupTaskStore.updateTaskStatus(h.groupTask.id, 'review');
    h.bridge.syncStatus(h.groupTask.id);

    assert.throws(
      () => h.bridge.acceptGroupTask(h.groupTask.id),
      (error) => {
        assert.match(error.message, /1 unfinished canonical step/);
        assert.match(error.message, /"Worker assignment: Builder Bot" \[running\] assignee=bot-2/);
        assert.match(error.message, /re-dispatch/);
        assert.match(error.message, /noise steps never block/);
        return true;
      },
    );
    // Nothing closed: the group task stays in review, the step stays running.
    assert.equal(h.groupTaskStore.getTaskById(h.groupTask.id).status, 'review');
    assert.equal(h.orchestrationStore.getStep(started.step.id).status, 'running');
  } finally {
    h.sqliteStore.close();
  }
});
