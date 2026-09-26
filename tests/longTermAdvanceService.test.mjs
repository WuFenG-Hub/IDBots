import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { LongTermTaskStore } = require('../dist-electron/main/longTermTaskStore.js');
const { LongTermAdvanceService } = require('../dist-electron/main/services/longTermAdvanceService.js');

/**
 * LongTermAdvanceService (P1): the longterm.advance heartbeat handler. Real
 * store on a temp db; stub session-store/runner with recorded calls.
 */

const HOUR = 3_600_000;

function makeStubCowork() {
  const sessions = new Map();
  const calls = { create: [], update: [], message: [] };
  return {
    calls,
    createSession(title, cwd, systemPrompt, mode, skills, metabotId, sessionType) {
      const id = `sess-${sessions.size + 1}`;
      sessions.set(id, { id, title, sessionType, skills: [...(skills ?? [])] });
      calls.create.push({ title, sessionType, skills: [...(skills ?? [])], metabotId });
      return { id };
    },
    updateSession(id, patch) { calls.update.push({ id, patch }); },
    addMessage(id, msg) { calls.message.push({ id, msg }); },
    getSession(id) { return sessions.get(id) ?? null; },
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
