import test from 'node:test';
import assert from 'node:assert/strict';

const { createNativeSqliteDatabase } = await import('../dist-electron/main/nativeSqliteDatabase.js')
  .catch(() => import('../dist-electron/nativeSqliteDatabase.js'));
const {
  MetawebStudyJobStore,
  MAX_STUDY_RUNS_PER_JOB,
  MAX_STUDY_CONSECUTIVE_FAILURES,
} = await import('../dist-electron/main/metawebStudyJobStore.js')
  .catch(() => import('../dist-electron/metawebStudyJobStore.js'));
const {
  MetawebStudyService,
  buildMetawebStudySessionPrompt,
  parseMetawebStudyRunReport,
} = await import('../dist-electron/main/services/metawebStudyService.js')
  .catch(() => import('../dist-electron/services/metawebStudyService.js'));

const NIGHT = new Date('2026-08-24T02:00:00'); // local 02:00 — inside [00:00, 06:00)
const DAY = new Date('2026-08-24T12:00:00'); // local noon — outside

const setup = (overrides = {}) => {
  const db = createNativeSqliteDatabase(':memory:');
  assert.ok(db, 'native sqlite available in test runtime');
  const store = new MetawebStudyJobStore(db, () => {});
  let nowValue = NIGHT;
  const runs = [];
  const service = new MetawebStudyService({
    store,
    now: () => nowValue,
    isMemoryEnabled: overrides.isMemoryEnabled,
    runStudyJob: overrides.runStudyJob ?? (async (job) => {
      runs.push(job.id);
      return { newPinIds: [`pin-${job.runCount + 1}i0`], summary: 'saved one pin' };
    }),
  });
  return {
    store,
    service,
    runs,
    setNow: (value) => { nowValue = value; },
  };
};

test('enqueue normalizes, defaults the budget, and dedupes active jobs by fingerprint', () => {
  const { service } = setup();
  const first = service.enqueueStudyJob(7, { topic: '  Game   Development ' });
  assert.equal(first.created, true);
  assert.equal(first.job.topic, 'Game Development');
  assert.equal(first.job.budgetPins, 20);
  const dupe = service.enqueueStudyJob(7, { topic: 'game development' });
  assert.equal(dupe.created, false);
  assert.equal(dupe.job.id, first.job.id);
  const otherBot = service.enqueueStudyJob(8, { topic: 'game development', budgetPins: 999 });
  assert.equal(otherBot.created, true);
  assert.equal(otherBot.job.budgetPins, 50, 'budget clamps to the 50 ceiling');
  assert.throws(() => service.enqueueStudyJob(7, { topic: '   ' }), /topic is required/i);
});

test('a done job with the same topic does not block re-enqueue', () => {
  const { service, store } = setup();
  const first = service.enqueueStudyJob(7, { topic: 'video' }).job;
  store.recordRun(first.id, {
    nextStatus: 'done',
    processedPinIds: ['p1i0'],
    consecutiveFailures: 0,
    summary: 'done',
    error: null,
    nowIso: NIGHT.toISOString(),
  });
  const second = service.enqueueStudyJob(7, { topic: 'video' });
  assert.equal(second.created, true);
  assert.notEqual(second.job.id, first.id);
});

test('runTick does nothing outside the nightly window', async () => {
  const { service, runs, setNow } = setup();
  service.enqueueStudyJob(7, { topic: 'video' });
  setNow(DAY);
  const result = await service.runTick();
  assert.equal(result.ran, 0);
  assert.deepEqual(runs, []);
});

test('a run saving new pins keeps the job pending for the next night', async () => {
  const { service, store } = setup();
  const job = service.enqueueStudyJob(7, { topic: 'video' }).job;
  const result = await service.runTick();
  assert.equal(result.ran, 1);
  const after = store.getById(job.id);
  assert.equal(after.status, 'pending');
  assert.equal(after.runCount, 1);
  assert.equal(after.consecutiveFailures, 0);
  assert.deepEqual(after.processedPinIds, ['pin-1i0']);
  assert.equal(after.lastRunSummary, 'saved one pin');
});

test('a run saving nothing new completes the job', async () => {
  const { service, store } = setup({
    runStudyJob: async () => ({ newPinIds: [], summary: 'corpus exhausted' }),
  });
  const job = service.enqueueStudyJob(7, { topic: 'video' }).job;
  await service.runTick();
  const after = store.getById(job.id);
  assert.equal(after.status, 'done');
  assert.equal(after.lastRunSummary, 'corpus exhausted');
});

test('reaching the run-count safety cap completes the job even with new pins', async () => {
  const { service, store } = setup();
  const job = service.enqueueStudyJob(7, { topic: 'video' }).job;
  for (let index = 0; index < MAX_STUDY_RUNS_PER_JOB - 1; index += 1) {
    store.recordRun(job.id, {
      nextStatus: 'pending',
      processedPinIds: [`old-${index}i0`],
      consecutiveFailures: 0,
      summary: 'x',
      error: null,
      nowIso: NIGHT.toISOString(),
    });
  }
  await service.runTick();
  const after = store.getById(job.id);
  assert.equal(after.status, 'done');
  assert.equal(after.runCount, MAX_STUDY_RUNS_PER_JOB);
  assert.match(after.lastRunSummary, /safety cap/);
});

test('a failing run keeps the job pending until the consecutive-failure threshold', async () => {
  const { service, store } = setup({
    runStudyJob: async () => { throw new Error('LLM exploded'); },
  });
  const job = service.enqueueStudyJob(7, { topic: 'bad' }).job;
  for (let round = 1; round < MAX_STUDY_CONSECUTIVE_FAILURES; round += 1) {
    await service.runTick();
    const mid = store.getById(job.id);
    assert.equal(mid.status, 'pending', `failure ${round} stays retryable`);
    assert.equal(mid.consecutiveFailures, round);
    assert.match(mid.lastError, /LLM exploded/);
  }
  await service.runTick();
  const terminal = store.getById(job.id);
  assert.equal(terminal.status, 'failed', 'threshold reached → failed');
  assert.equal(terminal.consecutiveFailures, MAX_STUDY_CONSECUTIVE_FAILURES);
});

test('a successful run resets the consecutive-failure counter', async () => {
  let shouldFail = true;
  const { service, store } = setup({
    runStudyJob: async () => {
      if (shouldFail) throw new Error('flaky');
      return { newPinIds: ['ok-1i0'], summary: 'recovered' };
    },
  });
  const job = service.enqueueStudyJob(7, { topic: 'flaky topic' }).job;
  await service.runTick();
  assert.equal(store.getById(job.id).consecutiveFailures, 1);
  shouldFail = false;
  await service.runTick();
  const after = store.getById(job.id);
  assert.equal(after.consecutiveFailures, 0);
  assert.equal(after.status, 'pending');
  assert.deepEqual(after.processedPinIds, ['ok-1i0']);
});

test('one job\'s failure does not stop the batch', async () => {
  const { service, store } = setup({
    runStudyJob: async (job) => {
      if (job.topic === 'bad') throw new Error('LLM exploded');
      return { newPinIds: ['ok-1i0'], summary: 'fine' };
    },
  });
  const bad = service.enqueueStudyJob(7, { topic: 'bad' }).job;
  const good = service.enqueueStudyJob(7, { topic: 'good' }).job;
  const result = await service.runTick();
  assert.equal(result.ran, 2);
  assert.equal(store.getById(bad.id).consecutiveFailures, 1);
  assert.equal(store.getById(good.id).status, 'pending');
  assert.deepEqual(store.getById(good.id).processedPinIds, ['ok-1i0']);
});

test('parseMetawebStudyRunReport reads the last json fence', () => {
  const report = parseMetawebStudyRunReport(
    'I saved things. Example: ```json\n{"processedPinIds": []}\n```\nFinal:\n```json\n{"processedPinIds": ["a1i0", "b2i0", "a1i0"], "summary": "two pins"}\n```',
  );
  assert.deepEqual(report.newPinIds, ['a1i0', 'b2i0']);
  assert.equal(report.summary, 'two pins');
});

test('parseMetawebStudyRunReport accepts bare JSON and defaults a missing summary', () => {
  const report = parseMetawebStudyRunReport('{"processedPinIds": ["x9i0"]}');
  assert.deepEqual(report.newPinIds, ['x9i0']);
  assert.match(report.summary, /did not provide a summary/);
});

test('parseMetawebStudyRunReport throws on prose-only replies', () => {
  assert.throws(() => parseMetawebStudyRunReport('I studied a lot but wrote no report.'), /did not return/);
});

test('buildMetawebStudySessionPrompt carries topic, budget and already-processed pins', () => {
  const { service } = setup();
  const job = service.enqueueStudyJob(7, { topic: 'game development', budgetPins: 5 }).job;
  const prompt = buildMetawebStudySessionPrompt({ ...job, processedPinIds: ['old1i0', 'old2i0'] });
  assert.match(prompt, /game development/);
  assert.match(prompt, /AT MOST 5 NEW pins/);
  assert.match(prompt, /old1i0/);
  assert.match(prompt, /unattended/i);
});

test('memory disabled fails the job loudly without launching a session or consuming a run', async () => {
  const { service, store, runs } = setup({ isMemoryEnabled: (metabotId) => metabotId !== 7 });
  const blocked = service.enqueueStudyJob(7, { topic: 'video' }).job;
  const allowed = service.enqueueStudyJob(8, { topic: 'music' }).job;
  const result = await service.runTick();
  assert.equal(result.ran, 1, 'only the memory-enabled bot ran a session');
  assert.deepEqual(runs, [allowed.id]);
  const blockedAfter = store.getById(blocked.id);
  assert.equal(blockedAfter.status, 'failed');
  assert.equal(blockedAfter.runCount, 0, 'no session ran, so no run is consumed');
  assert.equal(blockedAfter.consecutiveFailures, 0);
  assert.deepEqual(blockedAfter.processedPinIds, []);
  assert.match(blockedAfter.lastError, /Memory is disabled/);
  assert.match(blockedAfter.lastError, /re-enqueue/);
  assert.equal(store.getById(allowed.id).status, 'pending');
});

test('an unreadable memory policy leaves the job pending for the next tick', async () => {
  const { service, store, runs } = setup({
    isMemoryEnabled: () => { throw new Error('sqlite recovering'); },
  });
  const job = service.enqueueStudyJob(7, { topic: 'video' }).job;
  const result = await service.runTick();
  assert.equal(result.ran, 0);
  assert.deepEqual(runs, []);
  const after = store.getById(job.id);
  assert.equal(after.status, 'pending');
  assert.equal(after.runCount, 0);
});

test('omitting the memory gate preserves the previous always-run behavior', async () => {
  const { service, store, runs } = setup();
  const job = service.enqueueStudyJob(7, { topic: 'video' }).job;
  const result = await service.runTick();
  assert.equal(result.ran, 1);
  assert.deepEqual(runs, [job.id]);
  assert.equal(store.getById(job.id).status, 'pending');
});
