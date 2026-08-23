import test from 'node:test';
import assert from 'node:assert/strict';

const { createNativeSqliteDatabase } = await import('../dist-electron/main/nativeSqliteDatabase.js')
  .catch(() => import('../dist-electron/nativeSqliteDatabase.js'));
const {
  MetawebStudyJobStore,
  ensureMetawebStudyJobSchema,
  normalizeStudyTopic,
  studyTopicFingerprintOf,
  DEFAULT_STUDY_PIN_BUDGET_PER_NIGHT,
} = await import('../dist-electron/main/metawebStudyJobStore.js')
  .catch(() => import('../dist-electron/metawebStudyJobStore.js'));

const setup = () => {
  const db = createNativeSqliteDatabase(':memory:');
  assert.ok(db, 'native sqlite available in test runtime');
  const store = new MetawebStudyJobStore(db, () => {});
  return { db, store };
};

const makeJob = (overrides = {}) => ({
  id: 'study-test-1',
  metabotId: 7,
  topic: 'game development',
  topicFingerprint: 'game development',
  status: 'pending',
  budgetPins: DEFAULT_STUDY_PIN_BUDGET_PER_NIGHT,
  processedPinIds: [],
  runCount: 0,
  consecutiveFailures: 0,
  lastRunAt: null,
  lastRunSummary: null,
  lastError: null,
  createdAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:00.000Z',
  ...overrides,
});

test('schema creation is idempotent', () => {
  const { db } = setup();
  ensureMetawebStudyJobSchema(db);
  ensureMetawebStudyJobSchema(db);
});

test('legacy table without consecutive_failures gains the column, rows intact', () => {
  const db = createNativeSqliteDatabase(':memory:');
  db.run(`
    CREATE TABLE metaweb_study_jobs (
      id TEXT PRIMARY KEY,
      metabot_id INTEGER NOT NULL,
      topic TEXT NOT NULL,
      topic_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      budget_pins INTEGER NOT NULL DEFAULT 20,
      processed_pin_ids TEXT NOT NULL DEFAULT '[]',
      run_count INTEGER NOT NULL DEFAULT 0,
      last_run_at TEXT,
      last_run_summary TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.run(`INSERT INTO metaweb_study_jobs (id, metabot_id, topic, topic_fingerprint, created_at, updated_at)
          VALUES ('legacy-1', 7, 'old topic', 'old topic', 'x', 'x')`);
  ensureMetawebStudyJobSchema(db);
  const store = new MetawebStudyJobStore(db, () => {});
  const job = store.getById('legacy-1');
  assert.equal(job.topic, 'old topic');
  assert.equal(job.consecutiveFailures, 0, 'migrated rows default to zero failures');
});

test('topic normalization and fingerprint are case/whitespace insensitive', () => {
  assert.equal(normalizeStudyTopic('  Game   Development\n'), 'Game Development');
  assert.equal(studyTopicFingerprintOf('Game  Development'), 'game development');
  assert.equal(normalizeStudyTopic('   '), '');
});

test('insert + getById + listByMetabot newest first', () => {
  const { store } = setup();
  store.insert(makeJob({ id: 'a', createdAt: '2026-08-23T00:00:00.000Z' }));
  store.insert(makeJob({ id: 'b', topic: 'video', topicFingerprint: 'video', createdAt: '2026-08-24T00:00:00.000Z' }));
  const one = store.getById('a');
  assert.equal(one.topic, 'game development');
  assert.equal(one.status, 'pending');
  const list = store.listByMetabot(7);
  assert.deepEqual(list.map((job) => job.id), ['b', 'a']);
  assert.deepEqual(store.listByMetabot(999), []);
});

test('findActiveByFingerprint matches pending/running only', () => {
  const { store } = setup();
  store.insert(makeJob({ id: 'a', status: 'done' }));
  assert.equal(store.findActiveByFingerprint(7, 'game development'), null);
  store.insert(makeJob({ id: 'b', status: 'pending', createdAt: '2026-08-24T00:00:00.000Z' }));
  assert.equal(store.findActiveByFingerprint(7, 'game development').id, 'b');
  assert.equal(store.findActiveByFingerprint(8, 'game development'), null);
});

test('markRunning + recordRun persist outcome, bump run_count, set consecutive_failures', () => {
  const { store } = setup();
  store.insert(makeJob({ id: 'a' }));
  store.markRunning('a', '2026-08-24T00:00:00.000Z');
  assert.equal(store.getById('a').status, 'running');
  store.recordRun('a', {
    nextStatus: 'pending',
    processedPinIds: ['pin1i0', 'pin2i0'],
    consecutiveFailures: 0,
    summary: 'saved 2 pins',
    error: null,
    nowIso: '2026-08-24T01:00:00.000Z',
  });
  const job = store.getById('a');
  assert.equal(job.status, 'pending');
  assert.equal(job.runCount, 1);
  assert.equal(job.consecutiveFailures, 0);
  assert.deepEqual(job.processedPinIds, ['pin1i0', 'pin2i0']);
  assert.equal(job.lastRunAt, '2026-08-24T01:00:00.000Z');
  assert.equal(job.lastRunSummary, 'saved 2 pins');
  store.recordRun('a', {
    nextStatus: 'pending',
    processedPinIds: ['pin1i0', 'pin2i0'],
    consecutiveFailures: 2,
    summary: null,
    error: 'boom',
    nowIso: '2026-08-25T01:00:00.000Z',
  });
  const failed = store.getById('a');
  assert.equal(failed.status, 'pending', 'below the failure threshold the job stays retryable');
  assert.equal(failed.consecutiveFailures, 2);
  assert.equal(failed.runCount, 2);
  assert.equal(failed.lastError, 'boom');
});

test('listPending is oldest-first across bots; resetRunningToPending recovers crashed runs', () => {
  const { store } = setup();
  store.insert(makeJob({ id: 'a', metabotId: 7, createdAt: '2026-08-24T00:00:00.000Z' }));
  store.insert(makeJob({ id: 'b', metabotId: 8, topic: 'v', topicFingerprint: 'v', createdAt: '2026-08-23T00:00:00.000Z' }));
  store.insert(makeJob({ id: 'c', metabotId: 9, topic: 'x', topicFingerprint: 'x', status: 'done', createdAt: '2026-08-22T00:00:00.000Z' }));
  assert.deepEqual(store.listPending().map((job) => job.id), ['b', 'a']);
  store.markRunning('a', '2026-08-24T02:00:00.000Z');
  assert.deepEqual(store.listPending().map((job) => job.id), ['b']);
  store.resetRunningToPending('2026-08-24T03:00:00.000Z');
  assert.equal(store.getById('a').status, 'pending');
});

test('resetRunningToPending excludes a job still running in this process', () => {
  const { store } = setup();
  store.insert(makeJob({ id: 'alive', createdAt: '2026-08-23T00:00:00.000Z' }));
  store.insert(makeJob({ id: 'crashed', topic: 'v', topicFingerprint: 'v', createdAt: '2026-08-23T01:00:00.000Z' }));
  store.markRunning('alive', '2026-08-24T02:00:00.000Z');
  store.markRunning('crashed', '2026-08-24T02:01:00.000Z');
  store.resetRunningToPending('2026-08-24T03:00:00.000Z', 'alive');
  assert.equal(store.getById('alive').status, 'running', 'in-process run keeps its claim');
  assert.equal(store.getById('crashed').status, 'pending');
});

test('malformed processed_pin_ids JSON degrades to an empty list', () => {
  const { db, store } = setup();
  store.insert(makeJob({ id: 'a' }));
  db.run(`UPDATE metaweb_study_jobs SET processed_pin_ids = 'not-json' WHERE id = 'a'`);
  assert.deepEqual(store.getById('a').processedPinIds, []);
});
