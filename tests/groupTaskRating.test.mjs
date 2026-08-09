import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);

// groupTaskService -> groupChatTransport -> metaidCore imports electron; mock it.
const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: false,
        getAppPath: () => process.cwd(),
        getPath: () => process.cwd(),
      },
    };
  }
  return originalLoad.call(this, request, ...rest);
};

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { GroupTaskStore } = require('../dist-electron/main/groupTaskStore.js');
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');
const { DreamStore } = require('../dist-electron/main/dreamStore.js');
const groupTaskService = require('../dist-electron/main/services/groupTaskService.js');

Module._load = originalLoad;

const { closeGroupTask, setGroupTaskServiceGroupTaskStoreGetter, setGroupTaskServiceOrchestrationBridgeGetter } = groupTaskService;

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-group-task-rating-'));

const openStores = async (tempDir) => {
  const store = await SqliteStore.create(tempDir);
  // CoworkStore owns the cowork_sessions schema (session_type etc.) that the
  // dream activity query reads — instantiate it for its migrations.
  new CoworkStore(store.getDatabase(), store.getSaveFunction());
  const groupTaskStore = new GroupTaskStore(store.getDatabase(), store.getSaveFunction());
  const dreamStore = new DreamStore(store.getDatabase(), store.getSaveFunction());
  return { store, groupTaskStore, dreamStore, db: store.getDatabase() };
};

const getColumns = (db, tableName) => {
  const result = db.exec(`PRAGMA table_info(${tableName})`);
  return (result[0]?.values || []).map((row) => String(row[1]));
};

/** sqlite UTC datetime('now')-style string for a fixed epoch ms. */
const utcString = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

test('rating columns exist on group_tasks (fresh schema + idempotent migration)', async () => {
  const tempDir = makeTempDir();
  const { store, db } = await openStores(tempDir);
  try {
    const cols = getColumns(db, 'group_tasks');
    assert.ok(cols.includes('rating'));
    assert.ok(cols.includes('rating_comment'));
    assert.ok(cols.includes('rated_at'));
  } finally {
    store.close();
  }
});

test('updateTaskRating validates 1-5 and persists rating/comment/ratedAt; re-rating overwrites', async () => {
  const tempDir = makeTempDir();
  const { store, groupTaskStore } = await openStores(tempDir);
  try {
    const task = groupTaskStore.createTask({
      groupId: 'group-rate-1', title: '海报设计', goal: 'G', chairMetabotId: 1, createdBy: 'user',
    });
    assert.equal(task.rating, null);
    assert.equal(task.ratingComment, null);
    assert.equal(task.ratedAt, null);

    assert.throws(() => groupTaskStore.updateTaskRating(task.id, 0), /between 1 and 5/);
    assert.throws(() => groupTaskStore.updateTaskRating(task.id, 6), /between 1 and 5/);
    assert.throws(() => groupTaskStore.updateTaskRating(task.id, Number.NaN), /between 1 and 5/);
    assert.throws(() => groupTaskStore.updateTaskRating(9999, 5), /not found/);

    const rated = groupTaskStore.updateTaskRating(task.id, 5, '  设计很好，继续保持  ');
    assert.equal(rated.rating, 5);
    assert.equal(rated.ratingComment, '设计很好，继续保持', 'comment is trimmed');
    assert.ok(rated.ratedAt, 'rated_at stamped');

    // re-rating overwrites; empty comment clears to NULL
    const rerated = groupTaskStore.updateTaskRating(task.id, 2, '   ');
    assert.equal(rerated.rating, 2);
    assert.equal(rerated.ratingComment, null);
    assert.equal(groupTaskStore.getTaskById(task.id)?.rating, 2);
  } finally {
    store.close();
  }
});

test('closeGroupTask persists the owner rating on done; unrated close stays null (automation path)', async () => {
  const tempDir = makeTempDir();
  const { store, groupTaskStore } = await openStores(tempDir);
  try {
    setGroupTaskServiceGroupTaskStoreGetter(() => groupTaskStore);
    setGroupTaskServiceOrchestrationBridgeGetter(null);

    const rated = groupTaskStore.createTask({
      groupId: 'group-rate-close-1', title: 'T1', goal: 'G', chairMetabotId: 1, createdBy: 'user',
    });
    const done = await closeGroupTask(rated.id, { status: 'done', rating: 4, ratingComment: '排版不错' });
    assert.equal(done.status, 'done');
    assert.equal(done.rating, 4);
    assert.equal(done.ratingComment, '排版不错');
    assert.ok(done.ratedAt);
    assert.equal(groupTaskStore.getTaskById(rated.id)?.rating, 4);

    const unrated = groupTaskStore.createTask({
      groupId: 'group-rate-close-2', title: 'T2', goal: 'G', chairMetabotId: 1, createdBy: 'user',
    });
    const closed = await closeGroupTask(unrated.id, { status: 'done' });
    assert.equal(closed.status, 'done');
    assert.equal(closed.rating, null, 'no fabricated rating for automated closes');

    // rating rejected out of range even at the service layer
    const invalid = groupTaskStore.createTask({
      groupId: 'group-rate-close-3', title: 'T3', goal: 'G', chairMetabotId: 1, createdBy: 'user',
    });
    await assert.rejects(
      closeGroupTask(invalid.id, { status: 'done', rating: 9 }),
      /between 1 and 5/,
    );
  } finally {
    setGroupTaskServiceOrchestrationBridgeGetter(null);
    store.close();
  }
});

test('dream getActivityForDate: group task evaluations are member-scoped, done-only, day-windowed', async () => {
  const tempDir = makeTempDir();
  const { store, groupTaskStore, dreamStore, db } = await openStores(tempDir);
  try {
    const ratedMs = Date.UTC(2026, 6, 30, 12, 0, 0);
    const localDate = new Date(ratedMs);
    const dayStart = new Date(localDate.getFullYear(), localDate.getMonth(), localDate.getDate()).getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    const pinDay = utcString(ratedMs);
    const pinEarlier = utcString(ratedMs - 2 * 24 * 60 * 60 * 1000);

    // task1: member bot 7 (worker) + bot 8 (chair), done + rated 5 within the day
    const task1 = groupTaskStore.createTask({
      groupId: 'group-dream-1', title: '海报设计', goal: '做一张发布会海报', chairMetabotId: 8, createdBy: 'user',
    });
    groupTaskStore.addMember({ taskId: task1.id, metabotId: 7, role: 'worker' });
    groupTaskStore.addMember({ taskId: task1.id, metabotId: 8, role: 'chair' });
    groupTaskStore.updateTaskStatus(task1.id, 'done');
    groupTaskStore.updateTaskRating(task1.id, 5, '设计很好，下次继续保持');
    db.run('UPDATE group_tasks SET closed_at = ?, rated_at = ? WHERE id = ?', [pinDay, pinDay, task1.id]);

    // task2: member bot 7, done WITHOUT a rating (automation close) within the day
    const task2 = groupTaskStore.createTask({
      groupId: 'group-dream-2', title: '数据整理', goal: 'G', chairMetabotId: 7, createdBy: 'user',
    });
    groupTaskStore.addMember({ taskId: task2.id, metabotId: 7, role: 'chair' });
    groupTaskStore.updateTaskStatus(task2.id, 'done');
    db.run('UPDATE group_tasks SET closed_at = ? WHERE id = ?', [pinDay, task2.id]);

    // task3: member bot 7 but still executing — excluded
    const task3 = groupTaskStore.createTask({
      groupId: 'group-dream-3', title: '进行中', goal: 'G', chairMetabotId: 7, createdBy: 'user',
    });
    groupTaskStore.addMember({ taskId: task3.id, metabotId: 7, role: 'chair' });
    groupTaskStore.updateTaskStatus(task3.id, 'executing');

    // task4: member bot 7, done + rated but two days earlier — outside the window
    const task4 = groupTaskStore.createTask({
      groupId: 'group-dream-4', title: '老任务', goal: 'G', chairMetabotId: 7, createdBy: 'user',
    });
    groupTaskStore.addMember({ taskId: task4.id, metabotId: 7, role: 'chair' });
    groupTaskStore.updateTaskStatus(task4.id, 'done');
    groupTaskStore.updateTaskRating(task4.id, 1, '跑题了');
    db.run('UPDATE group_tasks SET closed_at = ?, rated_at = ? WHERE id = ?', [pinEarlier, pinEarlier, task4.id]);

    // task5: only bot 9 is a member — invisible to bot 7
    const task5 = groupTaskStore.createTask({
      groupId: 'group-dream-5', title: '别人的任务', goal: 'G', chairMetabotId: 9, createdBy: 'user',
    });
    groupTaskStore.addMember({ taskId: task5.id, metabotId: 9, role: 'chair' });
    groupTaskStore.updateTaskStatus(task5.id, 'done');
    groupTaskStore.updateTaskRating(task5.id, 3, null);
    db.run('UPDATE group_tasks SET closed_at = ?, rated_at = ? WHERE id = ?', [pinDay, pinDay, task5.id]);

    const activity = dreamStore.getActivityForDate(7, dayStart, dayEnd);
    assert.deepEqual(activity.groupTasks.map((task) => task.taskId), [task1.id, task2.id]);
    const first = activity.groupTasks[0];
    assert.equal(first.title, '海报设计');
    assert.equal(first.goal, '做一张发布会海报');
    assert.equal(first.memberRole, 'worker');
    assert.equal(first.rating, 5);
    assert.equal(first.ratingComment, '设计很好，下次继续保持');
    const second = activity.groupTasks[1];
    assert.equal(second.memberRole, 'chair');
    assert.equal(second.rating, null, 'unrated done tasks still surface, without a rating');
    assert.equal(second.ratingComment, null);

    // other bots see their own memberships only
    const bot8 = dreamStore.getActivityForDate(8, dayStart, dayEnd);
    assert.deepEqual(bot8.groupTasks.map((task) => task.taskId), [task1.id]);
    const bot9 = dreamStore.getActivityForDate(9, dayStart, dayEnd);
    assert.deepEqual(bot9.groupTasks.map((task) => task.taskId), [task5.id]);
    const bot42 = dreamStore.getActivityForDate(42, dayStart, dayEnd);
    assert.equal(bot42.groupTasks.length, 0);
  } finally {
    store.close();
  }
});
