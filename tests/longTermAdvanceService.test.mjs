import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { LongTermTaskStore } = require('../dist-electron/main/longTermTaskStore.js');
const { OrchestrationStore } = require('../dist-electron/main/orchestrationStore.js');
const { LongTermAdvanceService } = require('../dist-electron/main/services/longTermAdvanceService.js');

/**
 * LongTermAdvanceService (P1): the longterm.advance heartbeat handler. Real
 * store on a temp db; stub session-store/runner with recorded calls.
 */

const HOUR = 3_600_000;

function makeStubCowork() {
  const sessions = new Map();
  const counts = new Map();
  const calls = { create: [], update: [], message: [] };
  return {
    calls,
    counts,
    createSession(title, cwd, systemPrompt, mode, skills, metabotId, sessionType) {
      const id = `sess-${sessions.size + 1}`;
      sessions.set(id, { id, title, sessionType, skills: [...(skills ?? [])] });
      calls.create.push({ title, sessionType, skills: [...(skills ?? [])], metabotId });
      return { id };
    },
    updateSession(id, patch) { calls.update.push({ id, patch }); },
    addMessage(id, msg) { counts.set(id, (counts.get(id) ?? 0) + 1); calls.message.push({ id, msg }); },
    getSession(id) { return sessions.get(id) ?? null; },
    countSessionMessages(id) { return counts.get(id) ?? 0; },
  };
}

function makeRunner() {
  return {
    starts: [],
    active: new Set(),
    async startSession(sessionId, prompt) { this.starts.push({ sessionId, prompt }); },
    isSessionActive(sessionId) { return this.active.has(sessionId); },
  };
}

async function openWorld() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-lt-advance-'));
  const sqliteStore = await SqliteStore.create(dir);
  const store = new LongTermTaskStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  const cowork = makeStubCowork();
  const runner = makeRunner();
  const deps = {
    store: () => store,
    coworkStore: () => cowork,
    coworkRunner: () => runner,
    resolveTwinMetabotId: () => 7,
    resolveWorkingDirectory: () => '/tmp/lt',
    getBaseSystemPrompt: () => 'base',
    getSkillsPrompt: async () => null,
  };
  const advance = new LongTermAdvanceService(deps);
  return { store, cowork, runner, advance, deps };
}

const SPEC = {
  title: 'Game hub',
  goal: 'Ship the on-chain game hub.',
  subtasks: [{ title: 'Blueprint match loop' }, { title: 'Spectate & replay', dependsOnOrdinals: [1] }],
};

async function createActive(store) {
  const created = store.createTask(SPEC, 'owner');
  assert.ok(created.ok, JSON.stringify(created));
  assert.ok(store.activateTask(created.value.id, 'owner').ok);
  return created.value.id;
}

test('pending current sub-project → escalates: opens a longterm session, binds it, journals nudged, starts a turn', async () => {
  const { store, cowork, runner, advance } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  const report = await advance.run(now);

  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  const hit = report.escalated[0];
  assert.equal(hit.taskId, taskId);
  assert.equal(hit.reusedSession, false);
  assert.match(hit.reasons[0], /pending/);

  assert.equal(cowork.calls.create.length, 1);
  assert.match(cowork.calls.create[0].title, /^\[长期\] Game hub/);
  assert.equal(cowork.calls.create[0].sessionType, 'longterm');
  assert.deepEqual(cowork.calls.create[0].skills, ['long-term-task-exec']);
  assert.equal(cowork.calls.create[0].metabotId, 7);

  const subtask = store.getTask(taskId).subtasks[0];
  assert.equal(subtask.sessionId, hit.sessionId, 'sub-project bound to the opened session');
  assert.equal(runner.starts.length, 1);
  assert.equal(runner.starts[0].sessionId, hit.sessionId);
  assert.match(runner.starts[0].prompt, /longterm_task_get/);

  const events = store.getTask(taskId).events;
  assert.equal(events[0].kind, 'nudged');
  assert.equal(events[0].actor, 'system');
  const nudgeState = store.getNudgeState(taskId);
  assert.equal(nudgeState.lastNudgeAtMs, now);
  assert.equal(nudgeState.lastEventId, events[0].id, 'throttle state stores the post-nudge journal position');
});

test('throttle: a second run within the window and no new events does not re-escalate', async () => {
  const { store, runner, advance } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  await advance.run(now);
  assert.equal(runner.starts.length, 1);

  const second = await advance.run(now + 60_000);
  assert.equal(second.escalated.length, 0, JSON.stringify(second));
  assert.match(second.skipped.find((s) => s.taskId === taskId)?.reason ?? '', /throttled/);
  assert.equal(runner.starts.length, 1);
});

test('timed external wait expired → escalates even inside the throttle window', async () => {
  const { store, runner, advance } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  await advance.run(now);
  assert.equal(runner.starts.length, 1);

  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(
    store.waitSubtask(subtask.id, {
      kind: 'external',
      note: 'notarization',
      waitUntil: new Date(now - HOUR).toISOString(),
    }, 'twin').ok,
  );
  const report = await advance.run(now + 60_000);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.match(report.escalated[0].reasons[0], /timed wait expired/);
  assert.equal(report.escalated[0].reusedSession, true, 'the bound session is reused, never duplicated');
  assert.equal(store.getTask(taskId).subtasks[0].sessionId, runner.starts[1].sessionId);
});

test('owner decision quiet beyond the reminder window → reminder escalation', async () => {
  const { store, advance } = await openWorld();
  const taskId = await createActive(store);
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(store.waitSubtask(subtask.id, { kind: 'owner', note: 'need a channel decision' }, 'twin').ok);

  const report = await advance.run(Date.now() + 5 * HOUR);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.match(report.escalated[0].reasons[0], /owner decision still pending/);
});

test('owner wait with a future waitUntil stays silent inside the promised quiet window', async () => {
  const { store, advance } = await openWorld();
  const taskId = await createActive(store);
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(
    store.waitSubtask(subtask.id, {
      kind: 'owner',
      note: 'need a channel decision',
      waitUntil: new Date(Date.now() + 12 * HOUR).toISOString(),
    }, 'twin').ok,
  );

  const report = await advance.run(Date.now() + 5 * HOUR);
  assert.equal(report.escalated.length, 0, JSON.stringify(report));
  assert.match(report.skipped.find((s) => s.taskId === taskId)?.reason ?? '', /nothing due/);
});

test('owner wait: the first tick after the quiet window passes re-escalates as a window-ended re-presentation', async () => {
  const { store, advance } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(
    store.waitSubtask(subtask.id, {
      kind: 'owner',
      note: 'need a channel decision',
      waitUntil: new Date(now + HOUR).toISOString(),
    }, 'twin').ok,
  );

  const report = await advance.run(now + 5 * HOUR);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.match(report.escalated[0].reasons[0], /quiet window ended/);
});

test('stale owner wait: twin work after the wait was parked → convergence escalation, not an owner reminder', async () => {
  const { store, advance } = await openWorld();
  const taskId = await createActive(store);
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(store.waitSubtask(subtask.id, { kind: 'owner', note: 'waiting for owner to start first game' }, 'twin').ok);
  // The Twin works past the parked wait (journal note) but never clears it.
  assert.ok(store.addNote(taskId, subtask.id, 'proceeded autonomously: first bot-vs-bot game started', 'twin').ok);

  const report = await advance.run(Date.now());
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.match(report.escalated[0].reasons[0], /stale owner wait/);
  assert.doesNotMatch(report.escalated[0].reasons[0], /owner decision still pending/);
});

test('stale owner wait converges: after the Twin re-records the wait, reminders return to the normal cadence', async () => {
  const { store, advance } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(store.waitSubtask(subtask.id, { kind: 'owner', note: 'need a channel decision' }, 'twin').ok);
  assert.ok(store.addNote(taskId, subtask.id, 'side work while waiting', 'twin').ok);
  // The convergence turn re-records the wait — fresh anchor, nothing after it.
  assert.ok(
    store.waitSubtask(subtask.id, { kind: 'owner', note: 'need a channel decision (re-confirmed)' }, 'twin').ok,
  );

  const report = await advance.run(now + 5 * HOUR);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.match(report.escalated[0].reasons[0], /owner decision still pending/);
});

test('proposing from an external wait leaves reminders un-silenced; the session-bind note is not "work"', async () => {
  const { store, deps } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(
    store.waitSubtask(
      subtask.id,
      { kind: 'external', note: 'notarization', waitUntil: new Date(now + 12 * HOUR).toISOString() },
      'twin',
    ).ok,
  );
  assert.ok(store.proposeSubtask(subtask.id, { evidence: [{ kind: 'dir', uri: '/tmp/deliverable' }], summary: 'criteria met' }, 'twin').ok);

  const advance = new LongTermAdvanceService(deps);
  // The fresh proposal escalates immediately (一提请就叫你) — this first
  // escalation also binds the session, journaling a system note AFTER the
  // proposal anchor.
  const first = await advance.run(now + 60_000);
  assert.equal(first.escalated.length, 1, JSON.stringify(first));
  // Hours later the pending decision still reminds as a plain reminder —
  // the residual external window is gone and the bind note must not trip
  // stale-wait convergence.
  const later = await advance.run(now + 5 * HOUR);
  assert.equal(later.escalated.length, 1, JSON.stringify(later));
  assert.match(later.escalated[0].reasons[0], /owner decision still pending/);
  assert.doesNotMatch(later.escalated[0].reasons[0], /stale owner wait/);
});

test('stale detection survives the 200-event detail cap (direct queries, not sliced journal)', async () => {
  const { store, deps } = await openWorld();
  const taskId = await createActive(store);
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(store.waitSubtask(subtask.id, { kind: 'owner', note: 'waiting for owner' }, 'twin').ok);
  assert.ok(store.addNote(taskId, subtask.id, 'worked past the wait', 'twin').ok);
  // Bury the anchor and the work beyond the 200-event projection with noise.
  for (let i = 0; i < 205; i += 1) store.recordNudge(taskId, subtask.id, `noise ${i}`);
  assert.equal(store.getTask(taskId).events.length, 200, 'the detail journal projection is capped');

  const advance = new LongTermAdvanceService(deps);
  const report = await advance.run(Date.now() + HOUR);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.match(report.escalated[0].reasons[0], /stale owner wait/);
});

test('session rotation: an over-budget bound session is rotated with a continuity preamble', async () => {
  const { store, cowork, runner, deps } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  await new LongTermAdvanceService(deps).run(now); // opens + binds session 1
  const firstSessionId = store.getTask(taskId).subtasks[0].sessionId;
  cowork.counts.set(firstSessionId, 60); // over the default budget

  const report = await new LongTermAdvanceService(deps).run(now + 2 * HOUR);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  const hit = report.escalated[0];
  assert.equal(hit.reusedSession, false, 'rotation opens a fresh session');
  assert.notEqual(hit.sessionId, firstSessionId);
  assert.equal(store.getTask(taskId).subtasks[0].sessionId, hit.sessionId, 'sub-project rebound to the new session');
  assert.match(runner.starts[1].prompt, /SESSION ROTATION/);
  assert.ok(runner.starts[1].prompt.includes('60 messages'), 'rotation budget stated in the preamble');
  // The rotation is journaled as a system note (excluded from stale-work detection).
  const events = store.getTask(taskId).events;
  assert.ok(events.some((event) => event.kind === 'note' && event.actor === 'system' && /session rotated/.test(event.detail)));
});

test('session rotation: under-budget bound sessions are reused as before', async () => {
  const { store, cowork, deps } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  await new LongTermAdvanceService(deps).run(now);
  const firstSessionId = store.getTask(taskId).subtasks[0].sessionId;
  cowork.counts.set(firstSessionId, 12);

  const report = await new LongTermAdvanceService(deps).run(now + 2 * HOUR);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.equal(report.escalated[0].reusedSession, true);
  assert.equal(report.escalated[0].sessionId, firstSessionId);
});

test('convergence churn breaker: repeated stale-wait convergence escalates to the owner instead of looping', async () => {
  const { store, deps } = await openWorld();
  const taskId = await createActive(store);
  const subtask = store.getTask(taskId).subtasks[0];
  const advance = new LongTermAdvanceService(deps);
  const now = Date.now();
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  // Three stale cycles inside the churn window: each is an ordinary
  // convergence turn (Twin re-parks the wait, works past it again).
  for (let round = 0; round < 3; round += 1) {
    assert.ok(store.waitSubtask(subtask.id, { kind: 'owner', note: `decision ${round}` }, 'twin').ok);
    assert.ok(store.addNote(taskId, subtask.id, `worked past wait ${round}`, 'twin').ok);
    const report = await advance.run(now + (round + 1) * 10 * 60_000);
    assert.equal(report.escalated.length, 1, JSON.stringify(report));
    assert.match(report.escalated[0].reasons[0], /stale owner wait/);
  }
  // The fourth stale cycle inside the window trips the churn breaker.
  assert.ok(store.waitSubtask(subtask.id, { kind: 'owner', note: 'decision 3' }, 'twin').ok);
  assert.ok(store.addNote(taskId, subtask.id, 'worked past wait 3', 'twin').ok);
  const report = await advance.run(now + 45 * 60_000);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.match(report.escalated[0].reasons[0], /convergence churn/);
});

test('supervision: a leading streak of failed worker dispatches trips a supervise turn, once per new failure', async () => {
  const { store, runner, deps } = await openWorld();
  const taskId = await createActive(store);
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  const now = Date.now();
  const attempts = [
    { id: 'a1', label: 'ltt_x_step_v1', status: 'completed', startedAtMs: now - 9 * HOUR, finishedAtMs: now - 8 * HOUR },
    { id: 'a2', label: 'ltt_x_step_v2', status: 'failed', startedAtMs: now - 7 * HOUR, finishedAtMs: now - 6 * HOUR },
    { id: 'a3', label: 'ltt_x_step_v3', status: 'timed_out', startedAtMs: now - 5 * HOUR, finishedAtMs: now - 4 * HOUR },
  ];
  deps.listWorkerAttempts = () => attempts;
  const supervisor = new LongTermAdvanceService(deps);

  const first = await supervisor.run(now);
  assert.equal(first.escalated.length, 1, JSON.stringify(first));
  assert.match(first.escalated[0].reasons[0], /supervision: 2 consecutive failed\/timed-out worker dispatches/);

  // Signature already consumed: later runs fall back to ordinary logic (a
  // quiet push at most) — never a repeated supervision for the same failures.
  const second = await supervisor.run(now + 45 * 60_000);
  assert.ok(second.escalated.every((hit) => !hit.reasons[0].startsWith('supervision:')), JSON.stringify(second));

  // A NEW failure changes the signature: supervision re-fires — and bypasses
  // the 30-min noise throttle (last nudge was 5 min ago).
  const fourth = { id: 'a4', label: 'ltt_x_step_v4', status: 'failed', startedAtMs: now - 3 * HOUR, finishedAtMs: now - 2 * HOUR };
  deps.listWorkerAttempts = () => [...attempts, fourth];
  const third = await supervisor.run(now + 50 * 60_000);
  assert.equal(third.escalated.length, 1, JSON.stringify(third));
  assert.match(third.escalated[0].reasons[0], /supervision: 3 consecutive/);
  assert.equal(runner.starts.length, 3, 'three turns total: supervise, quiet push, re-supervise');
});

test('supervision: duration overrun past the expected budget trips a supervise turn, re-armed once per budget window', async () => {
  const { store, deps } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(store.updateSubtask({ subtaskId: subtask.id, expectedMinutes: 60 }, 'twin').ok);
  const supervisor = new LongTermAdvanceService(deps);

  const first = await supervisor.run(now + 90 * 60_000); // 1.5x the budget
  assert.equal(first.escalated.length, 1, JSON.stringify(first));
  assert.match(first.escalated[0].reasons[0], /supervision: in progress for >\d+h without converging \(budget 60min\)/);

  // Inside the re-arm window since that supervision: no second supervision.
  const second = await supervisor.run(now + 2 * HOUR);
  assert.ok(second.escalated.every((hit) => !hit.reasons[0].startsWith('supervision:')), JSON.stringify(second));

  // A full budget window after the last supervision: it fires again.
  const third = await supervisor.run(now + 4 * HOUR);
  assert.equal(third.escalated.filter((hit) => hit.reasons[0].startsWith('supervision:')).length, 1, JSON.stringify(third));
});

test('P1-A regression: a duration turn does not reset the failure-streak dedup (no paired supervision)', async () => {
  const { store, runner, deps } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(store.updateSubtask({ subtaskId: subtask.id, expectedMinutes: 60 }, 'twin').ok);
  deps.listWorkerAttempts = () => [
    { id: 'a1', label: 'v1', status: 'failed', startedAtMs: now - 3 * HOUR, finishedAtMs: now - 2.5 * HOUR },
    { id: 'a2', label: 'v2', status: 'failed', startedAtMs: now - 2 * HOUR, finishedAtMs: now - 1.5 * HOUR },
  ];
  const supervisor = new LongTermAdvanceService(deps);

  // Failure-streak supervision consumes its signature.
  const first = await supervisor.run(now);
  assert.equal(first.escalated.length, 1, JSON.stringify(first));
  assert.match(first.escalated[0].reasons[0], /supervision: 2 consecutive/);

  // One budget window later (no new failures): duration supervision fires.
  const second = await supervisor.run(now + 90 * 60_000);
  assert.equal(second.escalated.length, 1, JSON.stringify(second));
  assert.match(second.escalated[0].reasons[0], /supervision: in progress for >\d+h without converging/);

  // Five minutes after that duration turn — still no new failures, and the
  // last nudge is 5 min old (inside the 30-min noise throttle): the OLD
  // failure signature must NOT look fresh again. With the shared-slot bug
  // this spurious turn fired and bypassed the throttle.
  const third = await supervisor.run(now + 95 * 60_000);
  assert.equal(third.escalated.length, 0, JSON.stringify(third));
  assert.equal(runner.starts.length, 2, 'exactly two supervision turns total');
});

test('supervision turn prompt carries the verdict contract, responsibility chain, and dispatch record', async () => {
  const { store, runner, deps } = await openWorld();
  const taskId = await createActive(store);
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  const now = Date.now();
  deps.listWorkerAttempts = () => [
    { id: 'a1', label: 'ltt_x_v1', status: 'completed', startedAtMs: now - 9 * HOUR, finishedAtMs: now - 8 * HOUR },
    { id: 'a2', label: 'ltt_x_v2', status: 'failed', startedAtMs: now - 7 * HOUR, finishedAtMs: now - 6 * HOUR },
    { id: 'a3', label: 'ltt_x_v3', status: 'timed_out', startedAtMs: now - 4 * HOUR, finishedAtMs: now - 3 * HOUR },
  ];
  const supervisor = new LongTermAdvanceService(deps);
  const report = await supervisor.run(now);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  const prompt = runner.starts[0].prompt;
  assert.match(prompt, /SUPERVISION check on delegated work/i);
  assert.match(prompt, /three questions/i);
  assert.match(prompt, /Responsibility chain/i);
  assert.match(prompt, /third identical retry is forbidden/i);
  assert.ok(prompt.includes('ltt_x_v3: timed_out (60min)'), 'dispatch record embedded with duration');
  assert.ok(prompt.includes('ltt_x_v2: failed (60min)'), 'failed dispatch visible');
});

test('routine (non-supervision) turns carry no supervision block', async () => {
  const { store, runner, deps } = await openWorld();
  const advance = new LongTermAdvanceService(deps);
  await createActive(store);
  await advance.run(Date.now());
  assert.doesNotMatch(runner.starts[0].prompt, /SUPERVISION check on delegated work/i);
});

test('telemetry wiring: real OrchestrationStore attempts sourced from the bound session drive the failure streak', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-lt-telemetry-'));
  const sqliteStore = await SqliteStore.create(dir);
  const store = new LongTermTaskStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  const orchestration = new OrchestrationStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  const cowork = makeStubCowork();
  const runner = makeRunner();
  const deps = {
    store: () => store,
    coworkStore: () => cowork,
    coworkRunner: () => runner,
    resolveTwinMetabotId: () => 7,
    resolveWorkingDirectory: () => '/tmp/lt',
    getBaseSystemPrompt: () => 'base',
    getSkillsPrompt: async () => null,
    // Mirrors the main.ts adapter: attempts sourced from every session EVER
    // bound to this sub-project (rotation-safe), and only this sub-project's.
    listWorkerAttempts: (taskId, subtaskId) => {
      const subtask = store.getSubtask(subtaskId);
      if (!subtask) return [];
      const sessionIds = subtask.sessionHistory.length > 0
        ? subtask.sessionHistory
        : (subtask.sessionId ? [subtask.sessionId] : []);
      if (sessionIds.length === 0) return [];
      return orchestration.listAttemptsForSourceSessions(sessionIds).map((attempt) => ({
        id: attempt.id,
        label: attempt.idempotencyKey,
        status: attempt.status,
        startedAtMs: attempt.startedAt ? Date.parse(attempt.startedAt) : null,
        finishedAtMs: attempt.finishedAt ? Date.parse(attempt.finishedAt) : null,
      }));
    },
  };
  const advance = new LongTermAdvanceService(deps);
  const taskId = await createActive(store);
  const now = Date.now();
  // First escalation while the sub-project is pending opens + binds the session.
  await advance.run(now);
  const boundSessionId = store.getTask(taskId).subtasks[0].sessionId;
  assert.ok(boundSessionId, 'session bound by the first escalation');

  // Two failed dispatches sourced from an UNRELATED session: must not trip
  // supervision for this sub-project.
  const stranger = orchestration.createTask({
    ownerIntent: 'someone else', sourceSessionId: 'unrelated-session',
    twinMetabotId: 7, ownerGlobalMetaId: 'owner-global', origin: 'twin_delegate',
  });
  const strangerStep = orchestration.createStep({ taskId: stranger.id, ordinal: 1, title: 's', objective: 'o' });
  const s1 = orchestration.createAttempt({ stepId: strangerStep.id, idempotencyKey: 'other_v1', workerMetabotId: 15, prompt: 'go' });
  orchestration.updateAttempt(s1.id, 'failed', { error: 'boom' });
  const s2 = orchestration.createAttempt({ stepId: strangerStep.id, idempotencyKey: 'other_v2', workerMetabotId: 15, prompt: 'go' });
  orchestration.updateAttempt(s2.id, 'failed', { error: 'boom' });

  // The Twin begins. With only the unrelated session's failures visible, the
  // next turn is an ordinary quiet push — never supervision.
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  const midRun = await advance.run(now + 45 * 60_000);
  assert.ok(midRun.escalated.length === 1 && !midRun.escalated[0].reasons[0].startsWith('supervision:'), JSON.stringify(midRun));

  // Dispatches from THIS session then both fail → supervision fires.
  const orch = orchestration.createTask({
    ownerIntent: 'build the thing',
    sourceSessionId: boundSessionId,
    twinMetabotId: 7,
    ownerGlobalMetaId: 'owner-global',
    origin: 'twin_delegate',
  });
  const step = orchestration.createStep({ taskId: orch.id, ordinal: 1, title: 's', objective: 'o' });
  const first = orchestration.createAttempt({ stepId: step.id, idempotencyKey: 'ltt_x_v1', workerMetabotId: 15, prompt: 'go' });
  orchestration.updateAttempt(first.id, 'failed', { error: 'boom' });
  const second = orchestration.createAttempt({ stepId: step.id, idempotencyKey: 'ltt_x_v2', workerMetabotId: 15, prompt: 'go again' });
  orchestration.updateAttempt(second.id, 'failed', { error: 'boom again' });

  const report = await advance.run(now + 50 * 60_000);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.match(report.escalated[0].reasons[0], /supervision: 2 consecutive failed\/timed-out worker dispatches/);
  // The dispatch record embedded in the supervision prompt comes from the real store.
  assert.ok(runner.starts[2].prompt.includes('ltt_x_v2: failed'), 'real attempt rendered in the prompt');
  // Supervision turns journal as 'supervised' (distinct from routine 'nudged').
  const events = store.getTask(taskId).events;
  assert.equal(events[0].kind, 'supervised');
  assert.equal(events[0].actor, 'system');
});

test('session rotation does not blind the failure streak (history spans all bound sessions)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-lt-rotate-'));
  const sqliteStore = await SqliteStore.create(dir);
  const store = new LongTermTaskStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  const orchestration = new OrchestrationStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  const cowork = makeStubCowork();
  const runner = makeRunner();
  const deps = {
    store: () => store,
    coworkStore: () => cowork,
    coworkRunner: () => runner,
    resolveTwinMetabotId: () => 7,
    resolveWorkingDirectory: () => '/tmp/lt',
    getBaseSystemPrompt: () => 'base',
    getSkillsPrompt: async () => null,
    listWorkerAttempts: (taskId, subtaskId) => {
      const subtask = store.getSubtask(subtaskId);
      if (!subtask) return [];
      const sessionIds = subtask.sessionHistory.length > 0
        ? subtask.sessionHistory
        : (subtask.sessionId ? [subtask.sessionId] : []);
      if (sessionIds.length === 0) return [];
      return orchestration.listAttemptsForSourceSessions(sessionIds).map((attempt) => ({
        id: attempt.id,
        label: attempt.idempotencyKey,
        status: attempt.status,
        startedAtMs: attempt.startedAt ? Date.parse(attempt.startedAt) : null,
        finishedAtMs: attempt.finishedAt ? Date.parse(attempt.finishedAt) : null,
      }));
    },
  };
  const advance = new LongTermAdvanceService(deps);
  const taskId = await createActive(store);
  const now = Date.now();
  await advance.run(now); // pending escalation → binds session 1
  const firstSessionId = store.getTask(taskId).subtasks[0].sessionId;
  assert.ok(firstSessionId);

  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  const orch = orchestration.createTask({
    ownerIntent: 'build the thing', sourceSessionId: firstSessionId,
    twinMetabotId: 7, ownerGlobalMetaId: 'owner-global', origin: 'twin_delegate',
  });
  const step = orchestration.createStep({ taskId: orch.id, ordinal: 1, title: 's', objective: 'o' });
  const a1 = orchestration.createAttempt({ stepId: step.id, idempotencyKey: 'rot_v1', workerMetabotId: 15, prompt: 'go' });
  orchestration.updateAttempt(a1.id, 'failed', { error: 'boom' });
  const a2 = orchestration.createAttempt({ stepId: step.id, idempotencyKey: 'rot_v2', workerMetabotId: 15, prompt: 'go' });
  orchestration.updateAttempt(a2.id, 'failed', { error: 'boom' });

  // Push the bound session over the rotation budget: the NEXT escalation must
  // rotate — and the streak from the OLD session must still trip supervision.
  cowork.counts.set(firstSessionId, 60);
  const report = await advance.run(now + 10 * 60_000);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.match(report.escalated[0].reasons[0], /supervision: 2 consecutive failed\/timed-out worker dispatches/);
  assert.equal(report.escalated[0].reusedSession, false, 'the bound session rotated');
  assert.notEqual(report.escalated[0].sessionId, firstSessionId);
  const after = store.getTask(taskId).subtasks[0];
  assert.deepEqual(after.sessionHistory, [firstSessionId, report.escalated[0].sessionId], 'history spans both sessions');
});

test('in_progress with fresh work events is NOT re-pushed (quiet rule)', async () => {
  const { store, advance } = await openWorld();
  const taskId = await createActive(store);
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok, 'a turn just began it');

  const report = await advance.run(Date.now());
  assert.equal(report.escalated.length, 0, JSON.stringify(report));
});

test('never stacks a turn onto an already-running session', async () => {
  const { store, runner, advance } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  await advance.run(now);
  const sessionId = store.getTask(taskId).subtasks[0].sessionId;
  runner.active.add(sessionId);

  const report = await advance.run(now + 2 * HOUR);
  assert.equal(report.escalated.length, 0, JSON.stringify(report));
  assert.match(report.skipped.find((s) => s.taskId === taskId)?.reason ?? '', /already running/);
});

test('run escalation budget: at most maxEscalationsPerRun escalations per run', async () => {
  const { store, advance, deps } = await openWorld();
  deps.maxEscalationsPerRun = 2;
  const capped = new LongTermAdvanceService(deps);
  await createActive(store);
  await createActive(store);
  await createActive(store);

  const report = await capped.run(Date.now());
  assert.equal(report.escalated.length, 2, JSON.stringify(report));
  assert.ok(report.skipped.some((s) => s.reason.includes('budget')));
});

test('paused / defining / done tasks are never escalated', async () => {
  const { store, advance } = await openWorld();
  const activeId = await createActive(store);
  assert.ok(store.pauseTask(activeId, 'owner').ok);
  const draft = store.createTask(SPEC, 'twin');
  assert.ok(draft.ok);
  assert.equal(draft.value.stage, 'defining');

  const report = await advance.run(Date.now());
  assert.equal(report.checkedTasks, 0);
  assert.equal(report.escalated.length, 0);
});

test('a fresh acceptance proposal escalates at the next tick (一提请就叫你), not after the reminder window', async () => {
  const { store, advance, runner } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  // One escalation to establish the session + nudge state.
  await advance.run(now);
  assert.equal(runner.starts.length, 1);

  // Twin begins and proposes acceptance with evidence — 2 minutes ago.
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(store.proposeSubtask(subtask.id, { evidence: [{ kind: 'dir', uri: '/tmp/deliverable' }], summary: 'criteria met' }, 'twin').ok);
  assert.equal(store.getTask(taskId).column, 'waiting_owner');

  // Next tick, 2 minutes later: fresh proposed event → immediate escalation.
  const report = await advance.run(now + 2 * 60_000);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.match(report.escalated[0].reasons[0], /acceptance proposal/);
});

test('nudge prompt follows the owner locale (zh owners get the Chinese hand-off)', async () => {
  const { store, runner, deps } = await openWorld();
  deps.getAppLanguage = () => 'zh';
  const advance = new LongTermAdvanceService(deps);
  await createActive(store);
  await advance.run(Date.now());
  assert.equal(runner.starts.length, 1);
  assert.match(runner.starts[0].prompt, /心跳自动开启/);
  assert.match(runner.starts[0].prompt, /用主人的语言回复/);
  assert.match(runner.starts[0].prompt, /本地时区/);
});

test('nudge prompt anchors the turn to the goal + acceptance criteria (anti-drift)', async () => {
  const { store, runner, deps } = await openWorld();
  const advance = new LongTermAdvanceService(deps);
  await createActive(store);
  await advance.run(Date.now());
  const prompt = runner.starts[0].prompt;
  // The task goal (done-ness definition) rides every heartbeat turn.
  assert.ok(prompt.includes('Ship the on-chain game hub.'), 'goal text missing from the nudge prompt');
  // The turn must restate understanding before acting, and escalate new infra as a question.
  assert.match(prompt, /复述.*理解|restate your understanding/i);
  assert.match(prompt, /自行拍板|never your call alone/i);
  assert.match(prompt, /local timezone/i);
});

test('nudge prompt embeds acceptance criteria lines', async () => {
  const { store, runner, deps } = await openWorld();
  const advance = new LongTermAdvanceService(deps);
  const withCriteria = store.createTask(
    { title: 't1', goal: 'g', subtasks: [{ title: 's1', acceptanceCriteria: ['criterion one', 'criterion two'] }] },
    'owner',
  );
  assert.ok(withCriteria.ok);
  assert.ok(store.activateTask(withCriteria.value.id, 'owner').ok);
  await advance.run(Date.now());
  assert.ok(runner.starts[0].prompt.includes('criterion one'), 'criteria lines missing');
});

test('waiting-owner nudge prompt carries the full-restatement contract and the wait note', async () => {
  const { store, runner, deps } = await openWorld();
  const taskId = await createActive(store);
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(store.waitSubtask(subtask.id, { kind: 'owner', note: 'pick channel A or B' }, 'twin').ok);

  const advance = new LongTermAdvanceService(deps);
  const report = await advance.run(Date.now() + 5 * HOUR);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  const prompt = runner.starts[0].prompt;
  assert.match(prompt, /waiting on the owner/i);
  assert.match(prompt, /full re-presentation/i);
  assert.match(prompt, /no change/);
  assert.ok(prompt.includes('pick channel A or B'), 'wait note embedded in the prompt');
});

test('non-waiting nudge prompts carry no restatement contract', async () => {
  const { store, runner, deps } = await openWorld();
  const advance = new LongTermAdvanceService(deps);
  await createActive(store);
  await advance.run(Date.now());
  assert.doesNotMatch(runner.starts[0].prompt, /SPECIAL REQUIREMENT/);
});
