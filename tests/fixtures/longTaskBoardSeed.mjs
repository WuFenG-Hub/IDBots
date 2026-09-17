/**
 * Shared seed fixture for the IDBots long-task board (v1).
 *
 * Everyone — backend, frontend, acceptance — reads the SAME deterministic
 * dataset, so an assertion about a board column means the same thing in every
 * participant's run.
 *
 * Design rules (do not relax):
 *  - RAW SQL only. This file never imports the board's own derivation or
 *    statistics code, so an acceptance script built on top of it stays
 *    independent of the implementation under test (see the L4 position on
 *    recomputation independence).
 *  - The clock anchor is recorded in the manifest as `anchorAtMs`. Activity
 *    ages are relative to it, so a run can allow a tolerance instead of racing
 *    the wall clock.
 *  - Threshold boundary cases sit +/-10 minutes away from a threshold, leaving
 *    a documented 5-minute validity window after seeding. Re-seed before each
 *    acceptance run.
 *
 * Usage (from the worktree root, after `npm run compile:electron`):
 *   node tests/fixtures/longTaskBoardSeed.mjs
 *   node tests/fixtures/longTaskBoardSeed.mjs --out <dir>
 *   node tests/fixtures/longTaskBoardSeed.mjs --anchor 2026-09-17T12:00:00.000Z
 *   node tests/fixtures/longTaskBoardSeed.mjs --out <dir> --check
 *
 * `--check` re-reads every seeded task through OrchestrationStore (the ledger's
 * own read path) and fails when a row is missing or differs from the manifest.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../../dist-electron/main/sqliteStore.js');
const { OrchestrationStore } = require('../../dist-electron/main/orchestrationStore.js');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Board columns (acceptance criterion 4). */
export const BOARD_COLUMNS = {
  decide: '待你拍板',
  active: '进行中',
  blocked: '等外部·阻塞',
  closed: '已收口',
};

/** Zombie buckets (acceptance criterion 3). */
export const ZOMBIE_STATES = {
  none: 'no signal',
  warn: 'stale > 1 day',
  zombie: 'zombie > 2 days -> auto 待收口 + one-line closing suggestion',
};

/** Validity window for threshold boundary cases, after seeding. */
export const SEED_TOLERANCE_MS = 5 * MIN;

const OWNER_GLOBAL_META_ID = 'idq1t3lzq0q4rec8edujklp4w8hfmgceqxth82a7m9';
const TWIN_METABOT_ID = 1;
const WORKER_METABOT_ID = 2;

const DELIVERABLE_PIN = 'a'.repeat(64) + 'i0';

function isoAt(anchorMs, deltaMs) {
  return new Date(anchorMs + deltaMs).toISOString();
}

function q(value) {
  return JSON.stringify(value ?? []);
}

/**
 * Builds the case table. `anchorMs` is the seed clock; every age is exact and
 * recorded in the manifest.
 */
function buildCases(anchorMs) {
  const at = (delta) => isoAt(anchorMs, delta);
  const cases = [];

  const add = (spec, rows) => {
    cases.push({ spec, rows });
  };

  // --- SEED-01: task in review, every step completed -> 待你拍板 -------------
  add(
    {
      id: 'SEED-01',
      title: 'task review, all steps completed',
      boardColumn: 'decide',
      zombie: 'none',
      activityAgeMs: 2 * HOUR,
      activityAnchor: 'task.updated_at',
      note: 'task.status=review is the existing 待你拍板 landing point',
    },
    {
      tasks: [{ id: 'seed-task-01', status: 'review', updatedDelta: -2 * HOUR }],
      steps: [
        { id: 'seed-step-01a', taskId: 'seed-task-01', ordinal: 1, status: 'completed', updatedDelta: -3 * HOUR },
        { id: 'seed-step-01b', taskId: 'seed-task-01', ordinal: 2, status: 'completed', updatedDelta: -2 * HOUR },
      ],
    },
  );

  // --- SEED-02: step waiting_input -> 待你拍板 ------------------------------
  add(
    {
      id: 'SEED-02',
      title: 'step waiting_input',
      boardColumn: 'decide',
      zombie: 'none',
      activityAgeMs: 15 * MIN,
      activityAnchor: 'step.updated_at',
      note:
        'Corrected against the architecture contract §2.2 ②: step-level waiting_input lands in 待你拍板, '
        + 'not 等外部·阻塞. Only blocked-with-unmet-dependencies is 等外部·阻塞 (§2.2 ①, §2.4 E2).',
    },
    {
      tasks: [{ id: 'seed-task-02', status: 'running', updatedDelta: -15 * MIN }],
      steps: [
        { id: 'seed-step-02a', taskId: 'seed-task-02', ordinal: 1, status: 'waiting_input', updatedDelta: -15 * MIN },
      ],
    },
  );

  // --- SEED-03: blocked step whose dependency is unmet ---------------------
  add(
    {
      id: 'SEED-03',
      title: 'step blocked, dependency not satisfied',
      boardColumn: 'blocked',
      zombie: 'none',
      activityAgeMs: 3 * HOUR,
      activityAnchor: 'task.updated_at',
      note: 'dependencyStepIds points at a step that is not completed',
    },
    {
      tasks: [{ id: 'seed-task-03', status: 'running', updatedDelta: -3 * HOUR }],
      steps: [
        { id: 'seed-step-03a', taskId: 'seed-task-03', ordinal: 1, status: 'running', updatedDelta: -3 * HOUR },
        {
          id: 'seed-step-03b',
          taskId: 'seed-task-03',
          ordinal: 2,
          status: 'blocked',
          dependencyStepIds: ['seed-step-03a'],
          updatedDelta: -3 * HOUR,
        },
      ],
    },
  );

  // --- SEED-04: dependency released -> 进行中 ------------------------------
  add(
    {
      id: 'SEED-04',
      title: 'dependency released (step1 completed, step2 ready)',
      boardColumn: 'active',
      zombie: 'none',
      activityAgeMs: 30 * MIN,
      activityAnchor: 'step.updated_at',
      note: 'derivation rule: dependency released',
    },
    {
      tasks: [{ id: 'seed-task-04', status: 'running', updatedDelta: -2 * HOUR }],
      steps: [
        { id: 'seed-step-04a', taskId: 'seed-task-04', ordinal: 1, status: 'completed', updatedDelta: -2 * HOUR },
        {
          id: 'seed-step-04b',
          taskId: 'seed-task-04',
          ordinal: 2,
          status: 'ready',
          dependencyStepIds: ['seed-step-04a'],
          updatedDelta: -30 * MIN,
        },
      ],
    },
  );

  // --- SEED-05: healthy running task, no steps -----------------------------
  add(
    {
      id: 'SEED-05',
      title: 'running task without steps, fresh activity',
      boardColumn: 'active',
      zombie: 'none',
      activityAgeMs: 5 * HOUR,
      activityAnchor: 'task.updated_at',
      sourceSessionId: 'seed-session-standalone-05',
    },
    {
      tasks: [
        {
          id: 'seed-task-05',
          status: 'running',
          updatedDelta: -5 * HOUR,
          sourceSessionId: 'seed-session-standalone-05',
        },
      ],
      sessions: [{ id: 'seed-session-standalone-05', status: 'running' }],
    },
  );

  // --- SEED-06: planning -> 进行中 ----------------------------------------
  add(
    {
      id: 'SEED-06',
      title: 'planning task',
      boardColumn: 'active',
      zombie: 'none',
      activityAgeMs: 1 * HOUR,
      activityAnchor: 'task.updated_at',
    },
    { tasks: [{ id: 'seed-task-06', status: 'planning', updatedDelta: -1 * HOUR }] },
  );

  // --- SEED-07: activity-anchor trap #1 (fresh step, stale task) -----------
  add(
    {
      id: 'SEED-07',
      title: 'fresh step progress, task.updated_at 3 days old',
      boardColumn: 'active',
      zombie: 'none',
      activityAgeMs: 1 * HOUR,
      activityAnchor: 'step.updated_at',
      note: 'TRAP: task.updated_at alone would report this as a zombie (false positive)',
    },
    {
      tasks: [{ id: 'seed-task-07', status: 'running', updatedDelta: -3 * DAY }],
      steps: [
        { id: 'seed-step-07a', taskId: 'seed-task-07', ordinal: 1, status: 'running', updatedDelta: -1 * HOUR },
      ],
      attempts: [
        {
          id: 'seed-attempt-07a',
          stepId: 'seed-step-07a',
          status: 'running',
          queuedDelta: -1 * HOUR,
          startedDelta: -1 * HOUR,
          workerSessionId: 'seed-session-worker-07',
        },
      ],
      sessions: [{ id: 'seed-session-worker-07', status: 'running' }],
    },
  );

  // --- SEED-08: activity-anchor trap #2 (fresh queued attempt) -------------
  add(
    {
      id: 'SEED-08',
      title: 'queued attempt 30 min old, task and step 5 days old',
      boardColumn: 'active',
      zombie: 'none',
      activityAgeMs: 30 * MIN,
      activityAnchor: 'attempt.queued_at',
      note: 'TRAP: task/step timestamps alone would report this as a zombie',
    },
    {
      tasks: [{ id: 'seed-task-08', status: 'running', updatedDelta: -5 * DAY }],
      steps: [
        { id: 'seed-step-08a', taskId: 'seed-task-08', ordinal: 1, status: 'queued', updatedDelta: -5 * DAY },
      ],
      attempts: [
        {
          id: 'seed-attempt-08a',
          stepId: 'seed-step-08a',
          status: 'queued',
          queuedDelta: -30 * MIN,
        },
      ],
    },
  );

  // --- SEED-09..SEED-14: zombie thresholds ---------------------------------
  const threshold = (id, ageMs, boardColumn, zombie, note) => {
    add(
      {
        id,
        title: `idle for ${Math.round(ageMs / MIN)} min (threshold boundary)`,
        boardColumn,
        zombie,
        activityAgeMs: ageMs,
        activityAnchor: 'task.updated_at',
        pendingSpec: boardColumn === null && zombie === null,
        note,
      },
      { tasks: [{ id: `seed-task-${id.slice(-2)}`, status: 'running', updatedDelta: -ageMs }] },
    );
  };

  threshold('SEED-09', DAY - 10 * MIN, 'active', 'none', 'just under the >1 day warning threshold');
  threshold('SEED-10', DAY, 'active', 'none', 'EXACT 1 day: threshold uses strict >, so exactly 24h does NOT trip (contract §2.4 E3)');
  threshold('SEED-11', DAY + 10 * MIN, 'active', 'warn', 'just over the >1 day warning threshold');
  threshold('SEED-12', 2 * DAY - 10 * MIN, 'active', 'warn', 'just under the >2 day zombie threshold');
  threshold('SEED-13', 2 * DAY, 'active', 'warn', 'EXACT 2 days: strict > keeps it out of zombie, but it is still past the 1 day warning');
  threshold(
    'SEED-14',
    2 * DAY + 10 * MIN,
    'active',
    'zombie',
    'Zombie. Per the chair D1 ruling there is no fifth column: the card keeps its derived column '
    + '(here 进行中) and surfaces through closureDue=true -> top chip, count banner, filtered list, '
    + 'plus a one-line closing suggestion (criterion 3).',
  );

  // --- SEED-15: NULL updated_at is unreachable ----------------------------
  add(
    {
      id: 'SEED-15',
      title: 'NULL updated_at is unreachable (schema declares NOT NULL)',
      boardColumn: 'active',
      zombie: 'none',
      activityAgeMs: 45 * MIN,
      activityAnchor: 'task.updated_at',
      note:
        'SCHEMA FACT: orchestration_tasks.updated_at is TEXT NOT NULL, so the NULL-activity case cannot be '
        + 'constructed at the task level (the row is rejected). A valid recent timestamp is seeded instead; '
        + 'the implementation still needs a parse fallback for unparseable values.',
    },
    { tasks: [{ id: 'seed-task-15', status: 'running', updatedDelta: -45 * MIN }] },
  );

  // --- SEED-16 / SEED-17: closed (terminal status AND a written conclusion) --
  // Contract §2.4 E6: a terminal ledger status with a NULL conclusion is NOT
  // closed, so these two carry a conclusion to actually land in 已收口.
  add(
    {
      id: 'SEED-16',
      title: 'completed task with a closing conclusion',
      boardColumn: 'closed',
      zombie: 'none',
      activityAgeMs: 10 * DAY,
      activityAnchor: 'task.updated_at',
    },
    {
      tasks: [
        {
          id: 'seed-task-16',
          status: 'completed',
          updatedDelta: -10 * DAY,
          completedDelta: -10 * DAY,
          closureConclusion: 'seed: shipped and verified',
        },
      ],
      steps: [
        { id: 'seed-step-16a', taskId: 'seed-task-16', ordinal: 1, status: 'completed', updatedDelta: -10 * DAY },
      ],
    },
  );
  add(
    {
      id: 'SEED-17',
      title: 'cancelled task with a closing conclusion',
      boardColumn: 'closed',
      zombie: 'none',
      activityAgeMs: 10 * DAY,
      activityAnchor: 'task.updated_at',
    },
    {
      tasks: [
        {
          id: 'seed-task-17',
          status: 'cancelled',
          updatedDelta: -10 * DAY,
          completedDelta: -10 * DAY,
          closureConclusion: 'seed: cancelled by the owner',
        },
      ],
    },
  );

  // --- SEED-18: terminal without a conclusion --------------------------------
  add(
    {
      id: 'SEED-18',
      title: 'failed task without a closing conclusion',
      boardColumn: 'decide',
      zombie: 'none',
      activityAgeMs: 2 * DAY,
      activityAnchor: 'task.updated_at',
      closureDueLevel: 'terminal_no_conclusion',
      note: 'contract §2.4 E6 generalised: a terminal status with no conclusion is NOT closed',
    },
    { tasks: [{ id: 'seed-task-18', status: 'failed', updatedDelta: -2 * DAY }] },
  );

  // --- SEED-19: group task linked, still executing -------------------------
  add(
    {
      id: 'SEED-19',
      title: 'group task (executing) resolved back from source_session_id',
      boardColumn: 'active',
      zombie: 'none',
      activityAgeMs: 1 * HOUR,
      activityAnchor: 'task.updated_at',
      sourceSessionId: 'group-task:8301',
      note: 'reverse resolution: orchestration card -> group_tasks row',
    },
    {
      tasks: [
        {
          id: 'seed-task-19',
          status: 'running',
          updatedDelta: -1 * HOUR,
          sourceSessionId: 'group-task:8301',
        },
      ],
      groupTasks: [{
        id: 8301,
        orchestrationTaskId: 'seed-task-19',
        status: 'executing',
        sourceSessionId: 'seed-session-gt-8301',
      }],
      sessions: [{ id: 'seed-session-gt-8301', status: 'running', sessionType: 'group_task' }],
    },
  );

  // --- SEED-20: group task closed -> 已收口 --------------------------------
  add(
    {
      id: 'SEED-20',
      title: 'group task closed (done) with a conclusion -> card closed',
      boardColumn: 'closed',
      zombie: 'none',
      activityAgeMs: 3 * DAY,
      activityAnchor: 'task.updated_at',
      sourceSessionId: 'group-task:8302',
      note: 'derivation rule: group task closed',
    },
    {
      tasks: [
        {
          id: 'seed-task-20',
          status: 'completed',
          updatedDelta: -3 * DAY,
          completedDelta: -3 * DAY,
          sourceSessionId: 'group-task:8302',
          closureConclusion: 'seed: group task closed and accepted',
        },
      ],
      groupTasks: [{
        id: 8302,
        orchestrationTaskId: 'seed-task-20',
        status: 'done',
        sourceSessionId: 'seed-session-gt-8302',
      }],
      sessions: [{ id: 'seed-session-gt-8302', status: 'idle', sessionType: 'group_task' }],
    },
  );

  // --- SEED-21: scheduled task on a card (v1 gap) --------------------------
  add(
    {
      id: 'SEED-21',
      title: 'scheduled task attached via source_session_id (v1 gap)',
      boardColumn: 'active',
      zombie: 'none',
      activityAgeMs: 2 * HOUR,
      activityAnchor: 'task.updated_at',
      sourceSessionId: 'scheduled-task:seed-sched-01',
      note:
        'v1 GAP: scheduled_tasks has no orchestration_task_id column; the card is seedable through '
        + 'source_session_id only, and scheduled_task_runs.started_at is the run-level anchor',
    },
    {
      tasks: [
        {
          id: 'seed-task-21',
          status: 'running',
          updatedDelta: -2 * HOUR,
          sourceSessionId: 'scheduled-task:seed-sched-01',
        },
      ],
      scheduledTasks: [{ id: 'seed-sched-01', coworkSessionId: 'seed-session-sched-home-21' }],
      scheduledTaskRuns: [{
        id: 'seed-run-21',
        taskId: 'seed-sched-01',
        startedDelta: -2 * HOUR,
        sessionId: 'seed-session-sched-run-21',
      }],
      sessions: [
        { id: 'seed-session-sched-run-21', status: 'running' },
        { id: 'seed-session-sched-home-21', status: 'running' },
      ],
    },
  );

  // --- SEED-22: future timestamp (clock skew) ------------------------------
  add(
    {
      id: 'SEED-22',
      title: 'updated_at in the future (clock skew)',
      boardColumn: 'active',
      zombie: 'none',
      activityAgeMs: -45 * MIN,
      activityAnchor: 'task.updated_at',
      note: 'DEFENSIVE: a negative age is clamped to 0 and never reported as a zombie',
    },
    { tasks: [{ id: 'seed-task-22', status: 'running', updatedDelta: 45 * MIN }] },
  );

  // --- SEED-23: deliverable verifiable -------------------------------------
  add(
    {
      id: 'SEED-23',
      title: 'group task with a delivered on-chain artifact',
      boardColumn: 'active',
      zombie: 'none',
      activityAgeMs: 4 * HOUR,
      activityAnchor: 'task.updated_at',
      sourceSessionId: 'group-task:8303',
      note: 'derivation rule: deliverable verifiable (group_task_deliverables row)',
    },
    {
      tasks: [
        {
          id: 'seed-task-23',
          status: 'running',
          updatedDelta: -4 * HOUR,
          sourceSessionId: 'group-task:8303',
        },
      ],
      groupTasks: [{
        id: 8303,
        orchestrationTaskId: 'seed-task-23',
        status: 'executing',
        sourceSessionId: 'seed-session-gt-8303',
      }],
      sessions: [{ id: 'seed-session-gt-8303', status: 'running', sessionType: 'group_task' }],
      messages: [
        {
          pinId: 'b'.repeat(64) + 'i0',
          groupId: 'seed-group-8303',
          content: `shipped\n[DELIVERABLE] pin://${DELIVERABLE_PIN}\n`,
        },
        {
          pinId: 'c'.repeat(64) + 'i0',
          groupId: 'seed-group-8303',
          content: 'shipped\n[DELIVERABLE] pin://deadbeef\n',
        },
      ],
      deliverables: [
        {
          taskId: 8303,
          msgPinId: 'b'.repeat(64) + 'i0',
          uri: `pin://${DELIVERABLE_PIN}`,
          status: 'delivered',
          confirmation: 'confirmed',
          createdDelta: -4 * HOUR,
        },
        {
          taskId: 8303,
          msgPinId: 'c'.repeat(64) + 'i0',
          uri: 'pin://deadbeef',
          status: 'delivered',
          confirmation: 'unconfirmed',
          createdDelta: -4 * HOUR,
        },
      ],
    },
  );

  // --- SEED-24: conflicting signals -> precedence is a spec decision -------
  add(
    {
      id: 'SEED-24',
      title: 'task in review while a step is waiting_input',
      boardColumn: 'decide',
      zombie: 'none',
      activityAgeMs: 20 * MIN,
      activityAnchor: 'task.updated_at',
      note: 'PRECEDENCE: contract §2.2 — waiting_decision beats blocked_external',
    },
    {
      tasks: [{ id: 'seed-task-24', status: 'review', updatedDelta: -20 * MIN }],
      steps: [
        { id: 'seed-step-24a', taskId: 'seed-task-24', ordinal: 1, status: 'completed', updatedDelta: -1 * HOUR },
        {
          id: 'seed-step-24b',
          taskId: 'seed-task-24',
          ordinal: 2,
          status: 'waiting_input',
          updatedDelta: -20 * MIN,
        },
      ],
    },
  );

  // --- SEED-25: dangling source_session_id reference -----------------------
  add(
    {
      id: 'SEED-25',
      title: 'source_session_id references a group task that no longer exists',
      boardColumn: 'active',
      zombie: 'none',
      activityAgeMs: 3 * HOUR,
      activityAnchor: 'task.updated_at',
      sourceSessionId: 'group-task:9999',
      note: 'DEFENSIVE: dangling reference must still render a card, not throw',
    },
    {
      tasks: [
        {
          id: 'seed-task-25',
          status: 'running',
          updatedDelta: -3 * HOUR,
          sourceSessionId: 'group-task:9999',
        },
      ],
    },
  );

  // --- SEED-26: session ended -> closureDue, without forcing a column move ---
  add(
    {
      id: 'SEED-26',
      title: 'every linked session ended, nothing queued (contract R3)',
      boardColumn: 'active',
      zombie: 'none',
      activityAgeMs: 2 * HOUR,
      activityAnchor: 'task.updated_at',
      closureDueLevel: 'sessions_ended',
      sourceSessionId: 'seed-session-ended-26',
      note: 'session-ended triggers a closureDue assessment; it never auto-closes the card',
    },
    {
      tasks: [
        {
          id: 'seed-task-26',
          status: 'running',
          updatedDelta: -2 * HOUR,
          sourceSessionId: 'seed-session-ended-26',
        },
      ],
      sessions: [{ id: 'seed-session-ended-26', status: 'idle' }],
    },
  );

  // --- SEED-27: an independent session belongs to no card ------------------
  add(
    {
      id: 'SEED-27',
      title: 'independent session with no card link',
      boardColumn: null,
      zombie: null,
      activityAgeMs: null,
      activityAnchor: null,
      independentSessionId: 'seed-session-independent',
      note: 'NEGATIVE CASE: 0 rows means an independent session; the UI must not invent an owner',
    },
    { sessions: [{ id: 'seed-session-independent', status: 'idle' }] },
  );

  // --- SEED-28..SEED-37: v1.1 admission boundary cases (freeze doc §2/§4/§6) --
  // Every case below is UNREGISTERED, so only the rule it names can admit it.
  // `boardColumn: null` means archived: off the board at every scope, still
  // readable through `scope:'archived'` and `getCard`.
  const ADMISSION_FRESH_MS = 2 * HOUR;
  const adm = (id, suffix, spec, rows = {}) => add(
    {
      id,
      title: spec.title,
      boardColumn: spec.boardColumn,
      zombie: spec.zombie ?? 'none',
      activityAgeMs: spec.activityAgeMs ?? ADMISSION_FRESH_MS,
      activityAnchor: 'task.updated_at',
      registered: spec.registered === true,
      admission: spec.admission,
      note: spec.note,
    },
    {
      tasks: [{
        id: `seed-task-${suffix}`,
        status: spec.status ?? 'running',
        updatedDelta: -(spec.activityAgeMs ?? ADMISSION_FRESH_MS),
      }],
      ...rows,
    },
  );

  adm('SEED-28', '28', {
    title: 'single-step receipt, idle 3 days, nothing else -> ARCHIVED',
    boardColumn: null,
    activityAgeMs: 3 * DAY,
    admission: { admitted: false, via: null },
    note:
      'v1.1 CORE GATE: with no admission branch the row never becomes closureDue — not even as a 2-day '
      + 'zombie. The idle signal itself is still computed (closureWarn stays true); it just cannot queue '
      + 'the card. This one row is the whole "238 -> single digits" mechanism.',
  }, {
    steps: [{ id: 'seed-step-28a', taskId: 'seed-task-28', ordinal: 1, status: 'running', updatedDelta: -3 * DAY }],
  });

  adm('SEED-29', '29', {
    title: 'ADM-1: single-step receipt explicitly registered as a long task',
    boardColumn: 'active',
    zombie: 'zombie',
    activityAgeMs: 3 * DAY,
    registered: true,
    admission: { admitted: true, via: 'ADM-1' },
    note:
      'The kv registration (tracked_long_task_registry) is the ONLY matching branch; with it the very '
      + 'same idle row becomes a closureDue zombie. SEED-28/SEED-29 differ by exactly one kv entry.',
  }, {
    steps: [{ id: 'seed-step-29a', taskId: 'seed-task-29', ordinal: 1, status: 'running', updatedDelta: -3 * DAY }],
  });

  adm('SEED-30', '30', {
    title: 'ADM-2: two steps (strictly greater than 1)',
    boardColumn: 'active',
    zombie: 'zombie',
    activityAgeMs: 3 * DAY,
    admission: { admitted: true, via: 'ADM-2' },
    note: 'ADM-2 is strict > 1, so the second step is what flips SEED-28\'s shape into a card.',
  }, {
    steps: [
      { id: 'seed-step-30a', taskId: 'seed-task-30', ordinal: 1, status: 'completed', updatedDelta: -3 * DAY },
      { id: 'seed-step-30b', taskId: 'seed-task-30', ordinal: 2, status: 'running', updatedDelta: -3 * DAY },
    ],
  });

  adm('SEED-31', '31', {
    title: 'ADM-3 (group task): linked group task, twin-created',
    boardColumn: 'active',
    admission: { admitted: true, via: 'ADM-3' },
    note:
      'created_by="twin" on purpose: ADM-3 must fire while ADM-5 must NOT — the card carries the group '
      + 'link without being owner-initiated.',
  }, {
    steps: [{ id: 'seed-step-31a', taskId: 'seed-task-31', ordinal: 1, status: 'running', updatedDelta: -ADMISSION_FRESH_MS }],
    groupTasks: [{
      id: 8401,
      orchestrationTaskId: 'seed-task-31',
      status: 'executing',
      createdBy: 'twin',
    }],
  });

  adm('SEED-32', '32', {
    title: 'ADM-3 (scheduled task): bound scheduled task',
    boardColumn: 'active',
    admission: { admitted: true, via: 'ADM-3' },
    note: 'Second branch of ADM-3 — the scheduled-task binding column, no group task involved.',
  }, {
    steps: [{ id: 'seed-step-32a', taskId: 'seed-task-32', ordinal: 1, status: 'running', updatedDelta: -ADMISSION_FRESH_MS }],
    scheduledTasks: [{ id: 'seed-sched-32', orchestrationTaskId: 'seed-task-32' }],
  });

  adm('SEED-33', '33', {
    title: 'ADM-4 (dependencies): one step carrying a dependency list',
    boardColumn: 'blocked',
    admission: { admitted: true, via: 'ADM-4' },
    note:
      'A single step, so ADM-2 cannot fire (1 is not > 1): only the dependency branch admits this row. '
      + 'The unsettled dependency also makes 等外部·阻塞 the derived column — admission and the derived '
      + 'column are independent axes.',
  }, {
    steps: [{
      id: 'seed-step-33a',
      taskId: 'seed-task-33',
      ordinal: 1,
      status: 'blocked',
      updatedDelta: -ADMISSION_FRESH_MS,
      dependencyStepIds: ['seed-step-missing'],
    }],
  });

  adm('SEED-34', '34', {
    title: 'ADM-4 (checkpoints): group task with a checkpoint row',
    boardColumn: 'decide',
    admission: { admitted: true, via: 'ADM-4' },
    note:
      'The checkpoint branch is nested under group_tasks, so ADM-3 fires too — the freeze doc keeps this '
      + 'redundancy on purpose and the expectation records BOTH matches. The open checkpoint is also what '
      + 'puts the card in 待你拍板: the same fact feeds two independent axes.',
  }, {
    steps: [{ id: 'seed-step-34a', taskId: 'seed-task-34', ordinal: 1, status: 'running', updatedDelta: -ADMISSION_FRESH_MS }],
    groupTasks: [{
      id: 8402,
      orchestrationTaskId: 'seed-task-34',
      status: 'executing',
      createdBy: 'twin',
    }],
    checkpoints: [{ taskId: 8402, topic: 'seed checkpoint', status: 'open' }],
  });

  adm('SEED-35', '35', {
    title: 'ADM-5: owner-initiated group task (created_by=user)',
    boardColumn: 'active',
    admission: { admitted: true, via: 'ADM-5' },
    note:
      'ADM-5 requires a group_tasks row, so ADM-3 always co-fires; the assertion pins that ADM-5 is '
      + 'present, and SEED-31 pins that a twin-created link must not produce it.',
  }, {
    steps: [{ id: 'seed-step-35a', taskId: 'seed-task-35', ordinal: 1, status: 'running', updatedDelta: -ADMISSION_FRESH_MS }],
    groupTasks: [{
      id: 8403,
      orchestrationTaskId: 'seed-task-35',
      status: 'executing',
      createdBy: 'user',
    }],
  });

  adm('SEED-36', '36', {
    title: 'ADM-2 boundary: zero steps, nothing else -> ARCHIVED',
    boardColumn: null,
    activityAgeMs: 3 * DAY,
    admission: { admitted: false, via: null },
    note: '0 is not > 1: a step count of zero must not satisfy ADM-2 any more than a single step does.',
  });

  adm('SEED-37', '37', {
    title: 'strict mode: two steps only, admitted under wide, archived under strict',
    boardColumn: 'active',
    admission: { admitted: true, via: 'ADM-2', strict: false },
    note:
      'The same row under the two modes; the switch is the kv entry tracked_admission_mode and changes no '
      + 'stored data. SEED-30 is its wide-mode twin.',
  }, {
    steps: [
      { id: 'seed-step-37a', taskId: 'seed-task-37', ordinal: 1, status: 'completed', updatedDelta: -ADMISSION_FRESH_MS },
      { id: 'seed-step-37b', taskId: 'seed-task-37', ordinal: 2, status: 'running', updatedDelta: -ADMISSION_FRESH_MS },
    ],
  });

  return cases.map((entry) => ({
    ...entry.spec,
    orchestrationTaskId: entry.rows.tasks?.[0]?.id ?? null,
    pendingSpec: entry.spec.pendingSpec === true,
    boardColumnLabel: entry.spec.boardColumn ? BOARD_COLUMNS[entry.spec.boardColumn] : null,
    zombieLabel: entry.spec.zombie ? ZOMBIE_STATES[entry.spec.zombie] : null,
    rows: entry.rows,
  }));
}

function insertTask(db, anchorMs, task) {
  db.run(
    `INSERT INTO orchestration_tasks
      (id, owner_intent, enriched_goal, acceptance_criteria_json, source_session_id,
       twin_metabot_id, owner_global_meta_id, status, plan_version, created_at, updated_at, completed_at,
       closure_conclusion, closure_by, closure_at, closure_pin_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    [
      task.id,
      `seed: ${task.id}`,
      `seed goal for ${task.id}`,
      q([{ type: 'owner_defined', text: 'seed acceptance criterion' }]),
      task.sourceSessionId ?? null,
      TWIN_METABOT_ID,
      OWNER_GLOBAL_META_ID,
      task.status,
      isoAt(anchorMs, task.createdDelta ?? (task.updatedDelta ?? 0) - HOUR),
      task.updatedDelta === null ? null : isoAt(anchorMs, task.updatedDelta),
      task.completedDelta === undefined ? null : isoAt(anchorMs, task.completedDelta),
      task.closureConclusion ?? null,
      task.closureConclusion ? (task.closureBy ?? 'owner') : null,
      task.closureConclusion ? isoAt(anchorMs, task.updatedDelta ?? 0) : null,
      null,
    ],
  );
}

function insertStep(db, anchorMs, step) {
  db.run(
    `INSERT INTO orchestration_steps
      (id, task_id, ordinal, title, objective, acceptance_criteria_json, dependency_step_ids_json,
       assignee_metabot_id, permission_scope_json, deadline_at, status, accepted_result_json,
       active_attempt_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', NULL, ?, NULL, NULL, ?, ?)`,
    [
      step.id,
      step.taskId,
      step.ordinal,
      `seed step ${step.id}`,
      `seed objective for ${step.id}`,
      q(['seed step criterion']),
      q(step.dependencyStepIds ?? []),
      WORKER_METABOT_ID,
      step.status,
      isoAt(anchorMs, (step.updatedDelta ?? 0) - HOUR),
      isoAt(anchorMs, step.updatedDelta ?? 0),
    ],
  );
}

function insertAttempt(db, anchorMs, attempt) {
  db.run(
    `INSERT INTO orchestration_attempts
      (id, step_id, idempotency_key, worker_metabot_id, worker_session_id, status, prompt,
       result_json, error, queued_at, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL)`,
    [
      attempt.id,
      attempt.stepId,
      `seed:${attempt.id}`,
      WORKER_METABOT_ID,
      attempt.workerSessionId ?? null,
      attempt.status,
      `seed prompt for ${attempt.id}`,
      isoAt(anchorMs, attempt.queuedDelta),
      attempt.startedDelta === undefined ? null : isoAt(anchorMs, attempt.startedDelta),
    ],
  );
}

/**
 * `cowork_sessions.session_type` is added by coworkStore's own idempotent
 * migration (coworkStore.ts:1231), not by sqliteStore's DDL. Any verification
 * that touches it must run on a migrated database, so the fixture applies the
 * same guarded ALTER instead of pretending the column does not exist.
 */
function ensureSessionTypeColumn(db) {
  const result = db.exec('PRAGMA table_info(cowork_sessions)');
  const columns = (result[0]?.values?.map((row) => row[1]) || []);
  if (!columns.includes('session_type')) {
    db.run("ALTER TABLE cowork_sessions ADD COLUMN session_type TEXT NOT NULL DEFAULT 'standard'");
  }
}

function insertSession(db, anchorMs, session) {
  db.run(
    `INSERT INTO cowork_sessions
      (id, title, claude_session_id, status, pinned, cwd, system_prompt, execution_mode,
       hidden_from_session_list, project_id, created_at, updated_at, session_type)
     VALUES (?, ?, NULL, ?, 0, '/tmp/seed', '', 'auto', 0, NULL, ?, ?, ?)`,
    [
      session.id,
      `seed session ${session.id}`,
      session.status ?? 'idle',
      anchorMs - HOUR,
      anchorMs - MIN,
      session.sessionType ?? 'standard',
    ],
  );
}

function insertGroupTask(db, anchorMs, groupTask) {
  db.run(
    `INSERT INTO group_tasks
      (id, orchestration_task_id, group_id, title, goal, acceptance_criteria, status,
       chair_metabot_id, created_by, mode, source_session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'task', ?, ?, ?)`,
    [
      groupTask.id,
      groupTask.orchestrationTaskId,
      'seed-group-' + groupTask.id,
      `seed group task ${groupTask.id}`,
      `seed goal for group task ${groupTask.id}`,
      'seed acceptance criteria',
      groupTask.status,
      TWIN_METABOT_ID,
      // v1.1: ADM-5 reads exactly this column, so the fixture must be able to
      // seed both values. Defaults to the historical 'user'.
      groupTask.createdBy ?? 'user',
      groupTask.sourceSessionId ?? null,
      isoAt(anchorMs, groupTask.createdDelta ?? -6 * HOUR),
      isoAt(anchorMs, groupTask.updatedDelta ?? -1 * HOUR),
    ],
  );
}

function insertCheckpoint(db, anchorMs, checkpoint) {
  db.run(
    `INSERT INTO group_task_checkpoints (task_id, topic, status, created_at)
     VALUES (?, ?, ?, ?)`,
    [
      checkpoint.taskId,
      checkpoint.topic,
      checkpoint.status,
      isoAt(anchorMs, checkpoint.createdDelta ?? -2 * HOUR),
    ],
  );
}

function insertGroupMessage(db, anchorMs, message) {
  db.run(
    `INSERT INTO group_chat_messages
      (pin_id, group_id, sender_metaid, protocol, content, content_type, chain_timestamp, is_processed, created_at)
     VALUES (?, ?, ?, 'simplegroupchat', ?, 'text/plain', ?, 1, ?)`,
    [
      message.pinId,
      message.groupId,
      'seed-sender',
      message.content,
      anchorMs - 4 * HOUR,
      isoAt(anchorMs, -4 * HOUR),
    ],
  );
}

function insertDeliverable(db, anchorMs, deliverable) {
  db.run(
    `INSERT INTO group_task_deliverables
      (task_id, msg_pin_id, author_globalmetaid, kind, uri, status, confirmation, created_at)
     VALUES (?, ?, ?, 'artifact', ?, ?, ?, ?)`,
    [
      deliverable.taskId,
      deliverable.msgPinId,
      OWNER_GLOBAL_META_ID,
      deliverable.uri,
      deliverable.status,
      deliverable.confirmation,
      isoAt(anchorMs, deliverable.createdDelta),
    ],
  );
}

function insertScheduledTask(db, anchorMs, scheduledTask) {
  db.run(
    `INSERT INTO scheduled_tasks
      (id, name, description, enabled, schedule_json, prompt, execution_mode, notify_platforms_json,
       consecutive_errors, cowork_session_id, orchestration_task_id, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, 'auto', '[]', 0, ?, ?, ?, ?)`,
    [
      scheduledTask.id,
      `seed scheduled task ${scheduledTask.id}`,
      'seed scheduled task for the long-task board fixture',
      JSON.stringify({ type: 'daily', time: '09:00' }),
      'seed prompt',
      scheduledTask.coworkSessionId ?? null,
      scheduledTask.orchestrationTaskId ?? null,
      isoAt(anchorMs, -2 * DAY),
      isoAt(anchorMs, -2 * DAY),
    ],
  );
}

function insertScheduledTaskRun(db, anchorMs, run) {
  db.run(
    `INSERT INTO scheduled_task_runs
      (id, task_id, session_id, status, started_at, finished_at, duration_ms, trigger_type)
     VALUES (?, ?, ?, 'success', ?, ?, 1000, 'scheduled')`,
    [
      run.id,
      run.taskId,
      run.sessionId ?? null,
      isoAt(anchorMs, run.startedDelta),
      isoAt(anchorMs, run.startedDelta + 1000),
    ],
  );
}

/**
 * Writes the whole dataset into an already-initialized SqliteStore.
 * Returns the manifest (plain JSON-serializable).
 */
export function seedLongTaskBoard(sqliteStore, options = {}) {
  const anchorMs = options.anchorMs ?? Date.now();
  const db = sqliteStore.getDatabase();
  const cases = buildCases(anchorMs);

  ensureSessionTypeColumn(db);
  for (const testCase of cases) {
    const rows = testCase.rows;
    for (const session of rows.sessions ?? []) insertSession(db, anchorMs, session);
    for (const task of rows.tasks ?? []) insertTask(db, anchorMs, task);
    for (const step of rows.steps ?? []) insertStep(db, anchorMs, step);
    for (const attempt of rows.attempts ?? []) insertAttempt(db, anchorMs, attempt);
    for (const groupTask of rows.groupTasks ?? []) insertGroupTask(db, anchorMs, groupTask);
    for (const checkpoint of rows.checkpoints ?? []) insertCheckpoint(db, anchorMs, checkpoint);
    for (const message of rows.messages ?? []) insertGroupMessage(db, anchorMs, message);
    for (const deliverable of rows.deliverables ?? []) insertDeliverable(db, anchorMs, deliverable);
    for (const scheduledTask of rows.scheduledTasks ?? []) insertScheduledTask(db, anchorMs, scheduledTask);
    for (const run of rows.scheduledTaskRuns ?? []) insertScheduledTaskRun(db, anchorMs, run);
  }

  // v1.1: v1's card corpus stays about the columns/thresholds it was written
  // for, so every v1 case is registered in `tracked_long_task_registry` (ADM-1)
  // by default. A case that wants to test admission itself sets
  // `registered: false` and declares which rule must carry it.
  const registeredIds = cases
    .filter((testCase) => testCase.registered !== false)
    .map((testCase) => testCase.rows.tasks?.[0]?.id)
    .filter(Boolean);
  db.run(
    `INSERT INTO kv (key, value, updated_at) VALUES ('tracked_long_task_registry', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [JSON.stringify(registeredIds), anchorMs],
  );

  sqliteStore.getSaveFunction()();

  return {
    fixture: 'long-task-board-seed',
    version: 2,
    anchorAtMs: anchorMs,
    anchorIso: new Date(anchorMs).toISOString(),
    toleranceMs: SEED_TOLERANCE_MS,
    ownerGlobalMetaId: OWNER_GLOBAL_META_ID,
    twinMetabotId: TWIN_METABOT_ID,
    registeredTaskIds: registeredIds,
    columns: BOARD_COLUMNS,
    zombieStates: ZOMBIE_STATES,
    cases: cases.map(({ rows: _rows, ...rest }) => rest),
    counts: {
      tasks: cases.flatMap((c) => c.rows.tasks ?? []).length,
      steps: cases.flatMap((c) => c.rows.steps ?? []).length,
      attempts: cases.flatMap((c) => c.rows.attempts ?? []).length,
      groupTasks: cases.flatMap((c) => c.rows.groupTasks ?? []).length,
      checkpoints: cases.flatMap((c) => c.rows.checkpoints ?? []).length,
      deliverables: cases.flatMap((c) => c.rows.deliverables ?? []).length,
      scheduledTasks: cases.flatMap((c) => c.rows.scheduledTasks ?? []).length,
      sessions: cases.flatMap((c) => c.rows.sessions ?? []).length,
      messages: cases.flatMap((c) => c.rows.messages ?? []).length,
      registered: registeredIds.length,
      archived: cases.filter((c) => c.admission?.admitted === false).length,
      pendingSpec: cases.filter((c) => c.pendingSpec).length,
    },
  };
}

/** Re-reads every seeded task through the ledger's own read path. */
export function checkLongTaskBoard(sqliteStore, manifest) {
  const orchestration = new OrchestrationStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  const problems = [];
  for (const testCase of manifest.cases) {
    if (!testCase.orchestrationTaskId) continue;
    const task = orchestration.getTask(testCase.orchestrationTaskId);
    if (!task) {
      problems.push(`${testCase.id}: orchestration task ${testCase.orchestrationTaskId} missing`);
      continue;
    }
    if ((task.sourceSessionId ?? null) !== (testCase.sourceSessionId ?? null)) {
      problems.push(
        `${testCase.id}: source_session_id ${task.sourceSessionId ?? 'null'} != ${testCase.sourceSessionId ?? 'null'}`,
      );
    }
    const expectedAgeMs = testCase.activityAgeMs;
    if (expectedAgeMs === null || expectedAgeMs === undefined) continue;
    if (testCase.activityAnchor === 'task.updated_at') {
      const actualAgeMs = manifest.anchorAtMs - Date.parse(task.updatedAt);
      if (Number.isNaN(actualAgeMs)) {
        problems.push(`${testCase.id}: updated_at is not parseable (${task.updatedAt})`);
      } else if (Math.abs(actualAgeMs - expectedAgeMs) > 1000) {
        problems.push(`${testCase.id}: stored updated_at age ${actualAgeMs}ms != declared ${expectedAgeMs}ms`);
      }
      continue;
    }
    const steps = orchestration.listSteps(task.id);
    const ages = testCase.activityAnchor === 'attempt.queued_at'
      ? steps.flatMap((step) => orchestration.listAttempts(step.id)).map((a) => manifest.anchorAtMs - Date.parse(a.queuedAt))
      : steps.map((step) => manifest.anchorAtMs - Date.parse(step.updatedAt));
    if (!ages.some((age) => Math.abs(age - expectedAgeMs) <= 1000)) {
      problems.push(
        `${testCase.id}: no ${testCase.activityAnchor} within 1s of declared ${expectedAgeMs}ms `
        + `(measured: ${ages.map((age) => `${age}ms`).join(', ') || 'none'})`,
      );
    }
  }
  return problems;
}

function parseArgs(argv) {
  const args = { out: null, anchor: null, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--out') args.out = argv[++i];
    else if (token === '--anchor') args.anchor = argv[++i];
    else if (token === '--check') args.check = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const anchorMs = args.anchor ? Date.parse(args.anchor) : Date.now();
  if (Number.isNaN(anchorMs)) throw new Error(`unparseable --anchor: ${args.anchor}`);

  const dir = args.out ?? fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-long-task-board-seed-'));
  const sqliteStore = await SqliteStore.create(dir);
  try {
    const manifest = seedLongTaskBoard(sqliteStore, { anchorMs });
    const manifestPath = path.join(dir, 'long-task-board-seed.manifest.json');
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const output = { dir, manifestPath, ...manifest.counts, anchorIso: manifest.anchorIso };
    if (args.check) {
      const problems = checkLongTaskBoard(sqliteStore, manifest);
      output.check = problems.length ? { ok: false, problems } : { ok: true, checked: manifest.counts.tasks };
      if (problems.length) process.exitCode = 1;
    }
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    sqliteStore.close();
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
