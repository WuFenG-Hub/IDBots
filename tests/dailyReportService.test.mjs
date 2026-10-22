// src/main/services/dailyReportService.ts — the daily-report scheduler.
//
// Contract under test (imports target dist-electron, compiled by
// compile:electron — same convention as tests/dreamRetryPolicy.test.mjs):
//   a. gates — experimental switch off / no twin / per-Twin disabled /
//      fresh-install deferral all block the fire (no claim row written);
//   b. scheduled fire — hour passed, app started before the hour → session
//      '每日汇报 <date>' created for the twin, assistant message with
//      metadata {origin:'daily_report'}, stream broadcast, run completed;
//   c. catch-up — app started past the hour → nothing before start+15min,
//      catchup trigger after;
//   d. skip — zero-activity window → 'skipped' row, NO session created;
//   e. retry — collector throws → 'failed' row; after the backoff the tick
//      re-arms, delivers and completes WITHOUT a duplicate session.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createNativeSqliteDatabase } = await import('../dist-electron/main/nativeSqliteDatabase.js');
const { DailyReportStore } = await import('../dist-electron/main/dailyReportStore.js');
const {
  startDailyReportService,
  decideDailyReportFire,
  DAILY_REPORT_SESSION_TITLE_PREFIX,
  DAILY_REPORT_CATCHUP_DELAY_MS,
} = await import('../dist-electron/main/services/dailyReportService.js');
const { isExperimentalAutomationAllowed } = await import('../dist-electron/main/services/coworkAutomationPreference.js');

const DAY_MS = 24 * 60 * 60 * 1000;
// Fixed local "now": 2026-10-22 09:00, hour default 08:00 → fire time passed.
const NOW_9AM = new Date(2026, 9, 22, 9, 0, 0).getTime();
const DATE_LABEL = '2026-10-22';

const activeFacts = (overrides = {}) => ({
  generatedAtMs: NOW_9AM,
  windowStartMs: NOW_9AM - DAY_MS,
  windowEndMs: NOW_9AM,
  pendingFollowUps: [{ sessionId: 'sess-1', title: 'Decide', botName: 'Twin', source: 'cerebellum', ageDays: 1, overdue: false }],
  ownerOrchestrations: [],
  humanSessions: [],
  machineActivity: {
    scheduledRuns: [],
    groupTaskTransitions: [],
    longTermEvents: [],
    longTermProgress: [],
    twinDelegateOrchestrationsInWindow: 0,
  },
  botDigests: [],
  onlineActivity: [],
  newSessionCount: 1,
  hasAnyActivity: true,
  ...overrides,
});

const setup = (input = {}) => {
  const db = input.db ?? createNativeSqliteDatabase(':memory:');
  const dailyReportStore = input.dailyReportStore ?? new DailyReportStore(db, () => {});
  const settings = input.settings ?? { 'dailyReport.enabled': '1', 'dailyReport.hour': '8' };
  const createdSessions = [];
  const addedMessages = [];
  const emitted = [];
  const metabots = input.metabots ?? [{ id: 7, metabot_type: 'twin' }];
  let failAddMessage = input.failFirstAddMessage ?? false;
  const deps = {
    coworkStore: {
      getConfig: () => ({ workingDirectory: '/tmp/ws' }),
      createSession: (title, cwd, systemPrompt, executionMode, activeSkillIds, metabotId) => {
        const session = { id: `sess-${createdSessions.length + 1}`, title, cwd, metabotId };
        createdSessions.push(session);
        return session;
      },
      addMessage: (sessionId, message) => {
        if (failAddMessage) {
          failAddMessage = false;
          throw new Error('renderer socket died');
        }
        addedMessages.push({ sessionId, message });
        return { id: `m-${addedMessages.length}`, sessionId, ...message, timestamp: NOW_9AM };
      },
    },
    metabotStore: {
      listMetabots: () => metabots,
      getMetabotSetting: (metabotId, key) => (key in settings ? settings[key] : null),
    },
    dailyReportStore,
    experimentalAutomationStore: { get: () => input.experimentalEnabled },
    backgroundDeferral: () => input.backgroundDeferral ?? null,
    isExperimentalAutomationAllowed,
    collectFacts: input.collectFacts ?? (() => activeFacts()),
    triageCandidates: async () => null,
    resolveBrain: () => null, // deterministic fallback path — no LLM in tests
    performChat: async () => { throw new Error('performChat must not be called without a brain'); },
    emitCoworkStreamMessage: (sessionId, message) => emitted.push({ sessionId, message }),
    getLocale: () => 'zh',
    reportDir: fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-test-')),
    resolveSessionCwd: (base, metabotId) => `/tmp/ws/bots/${metabotId}`,
    now: () => new Date(input.nowMs ?? NOW_9AM),
    serviceStartedAtMs: input.serviceStartedAtMs ?? (input.nowMs ?? NOW_9AM),
    tickIntervalMs: 60_000,
    log: () => {},
  };
  const service = startDailyReportService(deps);
  return { service, deps, dailyReportStore, createdSessions, addedMessages, emitted };
};

// ---------------------------------------------------------------------------
// Pure decision core
// ---------------------------------------------------------------------------

test('decideDailyReportFire: before the hour → nothing', () => {
  const nowMs = new Date(2026, 9, 22, 7, 30, 0).getTime();
  assert.equal(
    decideDailyReportFire({ nowMs, serviceStartedAtMs: nowMs - 60_000, hour: 8, run: null }),
    null,
  );
});

test('decideDailyReportFire: app running at the hour → scheduled', () => {
  const nowMs = new Date(2026, 9, 22, 8, 0, 1).getTime();
  assert.deepEqual(
    decideDailyReportFire({ nowMs, serviceStartedAtMs: nowMs - 3_600_000, hour: 8, run: null }),
    { trigger: 'scheduled', retryRun: null },
  );
});

test('decideDailyReportFire: started past the hour → catchup only after 15 min', () => {
  const startMs = new Date(2026, 9, 22, 8, 5, 0).getTime();
  assert.equal(
    decideDailyReportFire({ nowMs: startMs + 60_000, serviceStartedAtMs: startMs, hour: 8, run: null }),
    null,
    'before start+15min: nothing',
  );
  assert.deepEqual(
    decideDailyReportFire({ nowMs: startMs + DAILY_REPORT_CATCHUP_DELAY_MS + 1000, serviceStartedAtMs: startMs, hour: 8, run: null }),
    { trigger: 'catchup', retryRun: null },
  );
});

test('decideDailyReportFire: any settled row owns the day; failed rows retry with backoff', () => {
  const nowMs = NOW_9AM;
  const base = { reportDate: DATE_LABEL, triggerKind: 'scheduled', sessionId: null, windowStartMs: 0, windowEndMs: 0, factsJson: null, attemptCount: 1, createdAt: nowMs, completedAt: nowMs };
  assert.equal(decideDailyReportFire({ nowMs, serviceStartedAtMs: nowMs - 3_600_000, hour: 8, run: { ...base, status: 'completed' } }), null);
  assert.equal(decideDailyReportFire({ nowMs, serviceStartedAtMs: nowMs - 3_600_000, hour: 8, run: { ...base, status: 'skipped' } }), null);
  assert.equal(decideDailyReportFire({ nowMs, serviceStartedAtMs: nowMs - 3_600_000, hour: 8, run: { ...base, status: 'running' } }), null);
  // failed, backoff (2 min first attempt) not yet expired
  const justFailed = { ...base, status: 'failed', error: 'fetch failed', completedAt: nowMs - 60_000 };
  assert.equal(decideDailyReportFire({ nowMs, serviceStartedAtMs: nowMs - 3_600_000, hour: 8, run: justFailed }), null);
  const cooledDown = { ...justFailed, completedAt: nowMs - 3 * 60_000 };
  const decision = decideDailyReportFire({ nowMs, serviceStartedAtMs: nowMs - 3_600_000, hour: 8, run: cooledDown });
  assert.equal(decision?.trigger, 'retry');
  // terminal provider rejection never retries; exhausted budget never retries
  const terminal = { ...base, status: 'failed', error: 'LLM request failed: 400 invalid_request_error', completedAt: nowMs - 3_600_000 };
  assert.equal(decideDailyReportFire({ nowMs, serviceStartedAtMs: nowMs - 3_600_000, hour: 8, run: terminal }), null);
  const exhausted = { ...cooledDown, attemptCount: 5 };
  assert.equal(decideDailyReportFire({ nowMs, serviceStartedAtMs: nowMs - 3_600_000, hour: 8, run: exhausted }), null);
});

// ---------------------------------------------------------------------------
// Service integration over a real in-memory store
// ---------------------------------------------------------------------------

test('gates block the fire: disabled twin / experimental off / deferral / no twin', async () => {
  for (const input of [
    { settings: { 'dailyReport.hour': '8' }, label: 'per-twin disabled (default OFF)' },
    { experimentalEnabled: '0', label: 'experimental master switch off' },
    { backgroundDeferral: 'fresh install', label: 'fresh-install deferral' },
    { metabots: [], label: 'no twin' },
  ]) {
    const { service, dailyReportStore, createdSessions } = setup({ ...input, nowMs: NOW_9AM });
    await service.tickNow();
    assert.equal(createdSessions.length, 0, `${input.label}: no session`);
    assert.equal(dailyReportStore.getRunForDate(DATE_LABEL), null, `${input.label}: no claim row`);
    service.stop();
  }
});

test('scheduled fire: twin session + daily_report message + completed row', async () => {
  const { service, deps, dailyReportStore, createdSessions, addedMessages, emitted } = setup({
    nowMs: NOW_9AM,
    // app started before the configured hour → the normal scheduled path
    serviceStartedAtMs: new Date(2026, 9, 22, 6, 0, 0).getTime(),
  });
  await service.tickNow();
  assert.equal(createdSessions.length, 1);
  assert.equal(createdSessions[0].title, `${DAILY_REPORT_SESSION_TITLE_PREFIX} ${DATE_LABEL}`);
  assert.equal(createdSessions[0].metabotId, 7, 'bound to the twin');
  assert.equal(createdSessions[0].cwd, '/tmp/ws/bots/7', 'twin bot-workspace cwd convention');
  assert.equal(addedMessages.length, 1);
  assert.equal(addedMessages[0].sessionId, createdSessions[0].id);
  assert.equal(addedMessages[0].message.type, 'assistant');
  assert.deepEqual(addedMessages[0].message.metadata, { origin: 'daily_report', originLabel: DATE_LABEL });
  assert.match(addedMessages[0].message.content, /idbots:\/\/session\/sess-1/);
  assert.match(addedMessages[0].message.content, /file:\/\//, 'message ends with the report file link');
  assert.equal(emitted.length, 1, 'stream broadcast for the renderer');
  const run = dailyReportStore.getRunForDate(DATE_LABEL);
  assert.equal(run.status, 'completed');
  assert.equal(run.sessionId, createdSessions[0].id);
  assert.equal(run.triggerKind, 'scheduled');
  const stats = JSON.parse(run.factsJson);
  assert.equal(stats.usedFallback, true, 'no brain in tests → deterministic fallback');
  assert.equal(stats.counts.pendingFollowUps, 1);
  // idempotent: a second tick on the same day never double-fires
  await service.tickNow();
  assert.equal(createdSessions.length, 1, 'no duplicate session');
  service.stop();
  fs.rmSync(deps.reportDir, { recursive: true, force: true });
});

test('catch-up fire: nothing before start+15min, catchup trigger after', async () => {
  const startMs = new Date(2026, 9, 22, 8, 30, 0).getTime();
  const { service, dailyReportStore, createdSessions } = setup({
    nowMs: startMs + 60_000,
    serviceStartedAtMs: startMs,
  });
  await service.tickNow();
  assert.equal(createdSessions.length, 0);
  assert.equal(dailyReportStore.getRunForDate(DATE_LABEL), null);
  service.stop();

  const late = setup({
    nowMs: startMs + DAILY_REPORT_CATCHUP_DELAY_MS + 1000,
    serviceStartedAtMs: startMs,
  });
  await late.service.tickNow();
  assert.equal(late.createdSessions.length, 1, 'catch-up fired once the 15-min delay elapsed');
  const run = late.dailyReportStore.getRunForDate(DATE_LABEL);
  assert.equal(run.status, 'completed');
  assert.equal(run.triggerKind, 'catchup');
  late.service.stop();
});

test('skip: zero-activity window records skipped and sends nothing', async () => {
  const { service, dailyReportStore, createdSessions } = setup({
    nowMs: NOW_9AM,
    serviceStartedAtMs: new Date(2026, 9, 22, 6, 0, 0).getTime(),
    collectFacts: () => activeFacts({ pendingFollowUps: [], newSessionCount: 0, hasAnyActivity: false }),
  });
  await service.tickNow();
  const run = dailyReportStore.getRunForDate(DATE_LABEL);
  assert.equal(run.status, 'skipped');
  assert.equal(run.sessionId, null);
  assert.equal(createdSessions.length, 0, 'no session on a skipped day');
  service.stop();
});

test('retry: failure after session delivery reuses the session (never a duplicate)', async () => {
  // One shared store across the three service instances (same "day").
  const sharedDb = createNativeSqliteDatabase(':memory:');
  const sharedStore = new DailyReportStore(sharedDb, () => {});
  // First attempt: session created, delivery (addMessage) dies → failed row
  // already carrying session_id.
  const first = setup({
    db: sharedDb,
    dailyReportStore: sharedStore,
    nowMs: NOW_9AM,
    serviceStartedAtMs: new Date(2026, 9, 22, 6, 0, 0).getTime(),
    failFirstAddMessage: true,
  });
  await first.service.tickNow();
  let run = sharedStore.getRunForDate(DATE_LABEL);
  assert.equal(run.status, 'failed');
  assert.equal(run.attemptCount, 1);
  assert.equal(run.sessionId, 'sess-1', 'session id persisted before delivery settled');
  assert.equal(first.addedMessages.length, 0);
  first.service.stop();

  // Backoff (2 min) not yet expired at +60s → still failed.
  const early = setup({ db: sharedDb, dailyReportStore: sharedStore, nowMs: NOW_9AM + 60_000 });
  await early.service.tickNow();
  run = sharedStore.getRunForDate(DATE_LABEL);
  assert.equal(run.status, 'failed');
  assert.equal(run.attemptCount, 1, 'no re-arm inside the backoff window');
  early.service.stop();

  // After the backoff: re-arms, reuses sess-1, delivers, completes.
  const late = setup({
    db: sharedDb,
    dailyReportStore: sharedStore,
    nowMs: NOW_9AM + 5 * 60_000,
    serviceStartedAtMs: new Date(2026, 9, 22, 6, 0, 0).getTime(),
  });
  await late.service.tickNow();
  run = sharedStore.getRunForDate(DATE_LABEL);
  assert.equal(run.status, 'completed');
  assert.equal(run.attemptCount, 2);
  assert.equal(run.triggerKind, 'retry');
  assert.equal(late.createdSessions.length, 0, 'NO new session — the retry reused the claimed one');
  assert.equal(late.addedMessages.length, 1);
  assert.equal(late.addedMessages[0].sessionId, 'sess-1');
  late.service.stop();
});

test('double-fire guard: pre-existing running row blocks a second claim', async () => {
  const { service, dailyReportStore, createdSessions } = setup({ nowMs: NOW_9AM });
  const claimed = dailyReportStore.claimRun({
    reportDate: DATE_LABEL,
    triggerKind: 'scheduled',
    windowStartMs: NOW_9AM - DAY_MS,
    windowEndMs: NOW_9AM,
  });
  assert.ok(claimed);
  assert.equal(
    dailyReportStore.claimRun({
      reportDate: DATE_LABEL,
      triggerKind: 'catchup',
      windowStartMs: NOW_9AM - DAY_MS,
      windowEndMs: NOW_9AM,
    }),
    null,
    'UNIQUE(report_date) rejects the second claim',
  );
  await service.tickNow();
  assert.equal(createdSessions.length, 0, 'a running row owns the day');
  service.stop();
});

// ---------------------------------------------------------------------------
// Manual "run now" (W9)
// ---------------------------------------------------------------------------

test('runNow: manual happy path delivers a fresh report with trigger manual', async () => {
  const { service, dailyReportStore, createdSessions, addedMessages, emitted } = setup({
    nowMs: NOW_9AM,
  });
  const result = await service.runNow();
  assert.deepEqual(result, { status: 'completed', sessionId: createdSessions[0].id });
  assert.equal(createdSessions.length, 1);
  assert.equal(createdSessions[0].title, `${DAILY_REPORT_SESSION_TITLE_PREFIX} ${DATE_LABEL}`);
  assert.equal(addedMessages.length, 1);
  assert.deepEqual(addedMessages[0].message.metadata, { origin: 'daily_report', originLabel: DATE_LABEL });
  assert.equal(emitted.length, 1);
  const run = dailyReportStore.getRunForDate(DATE_LABEL);
  assert.equal(run.status, 'completed');
  assert.equal(run.triggerKind, 'manual');
  assert.equal(run.attemptCount, 1);
  service.stop();
});

test('runNow: re-run same day is allowed — NEW session, no UNIQUE refusal, attempt_count increments', async () => {
  const { service, dailyReportStore, createdSessions } = setup({ nowMs: NOW_9AM });
  const first = await service.runNow();
  assert.equal(first.status, 'completed');
  const second = await service.runNow();
  assert.equal(second.status, 'completed');
  assert.equal(createdSessions.length, 2, 'each manual run delivers a NEW session');
  assert.notEqual(second.sessionId, first.sessionId);
  const run = dailyReportStore.getRunForDate(DATE_LABEL);
  assert.equal(run.status, 'completed');
  assert.equal(run.triggerKind, 'manual');
  assert.equal(run.attemptCount, 2, 'attempt_count climbs per manual attempt');
  assert.equal(run.sessionId, second.sessionId, 'row points at the latest session');
  service.stop();
});

test('runNow: gates enforced — disabled / experimental off / no twin / deferral', async () => {
  // Per-Twin toggle off (default OFF).
  const disabled = setup({ settings: { 'dailyReport.hour': '8' } });
  assert.deepEqual(await disabled.service.runNow(), { status: 'unavailable', reason: 'feature_disabled' });
  disabled.service.stop();

  // Experimental master switch off.
  const experimentalOff = setup({ experimentalEnabled: '0' });
  assert.deepEqual(await experimentalOff.service.runNow(), { status: 'unavailable', reason: 'experimental_disabled' });
  experimentalOff.service.stop();

  // No twin.
  const noTwin = setup({ metabots: [{ id: 1, metabot_type: 'worker' }] });
  assert.deepEqual(await noTwin.service.runNow(), { status: 'unavailable', reason: 'no_twin' });
  noTwin.service.stop();

  // Fresh-install deferral blocks a plain manual run (and writes no row).
  const deferred = setup({ backgroundDeferral: 'fresh install' });
  assert.deepEqual(await deferred.service.runNow(), { status: 'unavailable', reason: 'deferred' });
  assert.equal(deferred.dailyReportStore.getRunForDate(DATE_LABEL), null, 'no claim row while deferred');
  deferred.service.stop();
});

test('runNow: force bypasses ONLY the deferral and hasAnyActivity gates', async () => {
  // force:true passes the fresh-install deferral (still needs the other gates).
  const forced = setup({ backgroundDeferral: 'fresh install' });
  const forcedResult = await forced.service.runNow({ force: true });
  assert.equal(forcedResult.status, 'completed', 'force bypasses the deferral');
  forced.service.stop();

  // Empty window: plain run skips; force ships the report anyway.
  const empty = setup({
    collectFacts: () => activeFacts({ pendingFollowUps: [], newSessionCount: 0, hasAnyActivity: false }),
  });
  const skipped = await empty.service.runNow();
  assert.deepEqual(skipped, { status: 'skipped', reason: 'no_activity' });
  const forcedEmpty = await empty.service.runNow({ force: true });
  assert.equal(forcedEmpty.status, 'completed', 'force bypasses the empty-window skip');
  assert.equal(empty.createdSessions.length, 1);
  empty.service.stop();
});

test('runNow: a run in flight → unavailable (no double-running)', async () => {
  let releaseTriage;
  const triageGate = new Promise((resolve) => { releaseTriage = resolve; });
  const { service, createdSessions } = setup({
    triageCandidates: () => triageGate.then(() => null),
  });
  const first = service.runNow();
  // The first run holds the firing flag from the moment it starts.
  const second = await service.runNow();
  assert.deepEqual(second, { status: 'unavailable', reason: 'already_running' });
  releaseTriage(null);
  const firstResult = await first;
  assert.equal(firstResult.status, 'completed');
  assert.equal(createdSessions.length, 1, 'exactly one session from the two overlapping calls');
  service.stop();
});

test('runNow: stopped service reports unavailable instead of throwing', async () => {
  const { service } = setup({ nowMs: NOW_9AM });
  service.stop();
  assert.deepEqual(await service.runNow(), { status: 'unavailable', reason: 'service_stopped' });
});
