/**
 * Five-state isolation tests (五种状态隔离实测) for the long-task board.
 *
 * For EACH of the five board lists — waiting_decision (待你拍板),
 * in_progress (进行中), blocked_external (等外部·阻塞), closed (已收口) and
 * the archive (归档) — this file builds ONE brand-new, fully isolated
 * database in a throwaway temp dir and seeds it with RAW SQL only, using a
 * single-state injection: the board contains exactly the cards the one state
 * under test must produce, and nothing else. The five runs share nothing but
 * the in-file helpers below (deliberately NOT the shared 50-case fixture).
 *
 * Per isolated instance the test verifies:
 *  (1) the injected cards land in EXACTLY the declared column / archive
 *      scope — every other column stays empty, the archive (resp. the board
 *      columns) never sees them: zero cross-column and cross-scope leakage;
 *  (2) inside the declared list the cards order by ACTIVITY TIME descending
 *      (newest first) over three cards with three DISTINCT activity times —
 *      and each card's activityAtMs is asserted equal to its seeded
 *      orchestration_tasks.updated_at, so the order is proven to be driven
 *      by activity, not by id, insertion order or a rank coincidence;
 *  (3) `counts` matches the injection exactly (the whole counts object);
 *  (4) reading writes NOTHING: a full-table snapshot taken before the reads
 *      is identical afterwards (the archive is a read-time projection,
 *      freeze doc §6 — nothing written, moved or deleted).
 *
 * The state each card lands in is pinned via the fact that PRODUCED it:
 *   waiting_decision  <- ledger status='review'      (fact ledger_review)
 *   in_progress       <- plain running work          (fact steps_active)
 *   blocked_external  <- blocked step whose dependency is NOT completed
 *                                       (fact blocked_unmet_dependencies)
 *   closed            <- terminal status + closing conclusion on the row
 *   archived          <- fails ADM-1..ADM-5 (unregistered, zero steps, no
 *                        group/scheduled link) -> admitted=false
 *
 * Contract sources: 《IDBots 长期任务看板 v1 · 架构契约 v1.3（冻结版）》
 * pin://9d5feb452dad05b11714f8919d60bec316d87f10ce779b5cfe73a6ee91ea888fi0 and
 * 《长期任务看板 v1.1 · 口径冻结件 v1.0》
 * pin://4d633cb0b84843bcdc27727339654dbedb34ff488de84f867b2b1073c8127e1fi0
 * (§2 admission, §4 closureDue, §6 archive).
 *
 * The seed helpers follow the raw-SQL pattern of
 * tests/fixtures/longTaskBoardSeed.mjs (same INSERT column lists, the same
 * clock-anchor trick, the same guarded `cowork_sessions.session_type` ALTER)
 * but are re-implemented IN THIS FILE so this suite stays a single,
 * self-contained addition to the tree.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { OrchestrationStore } = require('../dist-electron/main/orchestrationStore.js');
const { TrackedTaskBoardService } = require('../dist-electron/main/services/trackedTaskBoard.js');

const MIN = 60_000;

/**
 * The board reads the real wall clock (`nowMs` per listCards call). Seeding
 * one minute into the future keeps every seeded age stable for ~60s of run
 * time — the same trick the shared fixture uses.
 */
const SEED_CLOCK_AHEAD_MS = 60_000;

/**
 * Three DISTINCT, fresh activity ages — declared newest first. All are hours
 * away from the 24h warn / 48h zombie thresholds and well inside the 7-day
 * default scope window, so a slow run cannot flip any bucket.
 */
const ACTIVITY_SLOTS = [
  { slot: 'newest', ageMs: -30 * MIN },
  { slot: 'middle', ageMs: -60 * MIN },
  { slot: 'oldest', ageMs: -90 * MIN },
];

/**
 * Every seeded step sits at one fixed, OLDER timestamp, so a card's
 * multi-source activity max is EXACTLY its orchestration_tasks.updated_at —
 * the value the ordering assertions below pin per card.
 */
const STEP_FIXED_AGE_MS = -5 * 60 * MIN;

const OWNER_GLOBAL_META_ID = 'idq1fivestatesisolationowner0000000000000000metaid';
const TWIN_METABOT_ID = 1;
const WORKER_METABOT_ID = 2;

/** The four contract columns, in the contract's mutual-exclusion order. */
const COLUMN_STATES = ['waiting_decision', 'in_progress', 'blocked_external', 'closed'];

const COLUMN_LABEL_KEYS = {
  waiting_decision: 'trackedTask.column.waitingDecision',
  in_progress: 'trackedTask.column.inProgress',
  blocked_external: 'trackedTask.column.blockedExternal',
  closed: 'trackedTask.column.closed',
};

/**
 * The exact inputs that PRODUCE each state — asserted per card, so a card
 * cannot land in its column by coincidence of some other derivation branch.
 * Two `ready` steps also carry the card over admission (ADM-2: stepCount>1).
 */
const STATE_SPECS = {
  // Ledger status=review is the 待你拍板 landing point (contract [SEC-06]).
  waiting_decision: {
    taskStatus: 'review',
    steps: () => [
      { key: 's1', status: 'completed', deps: [] },
      { key: 's2', status: 'completed', deps: [] },
    ],
    reasonCode: 'ledger_review',
  },
  // A running task with ready steps: no review, no waiting_input, no unmet
  // dependency -> 进行中.
  in_progress: {
    taskStatus: 'running',
    steps: () => [
      { key: 's1', status: 'ready', deps: [] },
      { key: 's2', status: 'ready', deps: [] },
    ],
    reasonCode: 'steps_active',
  },
  // A blocked step whose dependency is NOT completed -> 等外部·阻塞.
  blocked_external: {
    taskStatus: 'running',
    steps: () => [
      { key: 's1', status: 'blocked', deps: ['s2'] },
      { key: 's2', status: 'ready', deps: [] },
    ],
    reasonCode: 'blocked_unmet_dependencies',
  },
  // Terminal status + a non-empty closing conclusion -> 已收口.
  closed: {
    taskStatus: 'completed',
    steps: () => [
      { key: 's1', status: 'completed', deps: [] },
      { key: 's2', status: 'completed', deps: [] },
    ],
  },
  // Unregistered + zero steps + no group/scheduled link: ADM-1..ADM-5 all
  // fail -> admitted=false -> the 归档 projection.
  archived: {
    taskStatus: 'running',
    steps: () => [],
  },
};

function isoAt(anchorMs, deltaMs) {
  return new Date(anchorMs + deltaMs).toISOString();
}

/**
 * `cowork_sessions.session_type` is added by coworkStore's own idempotent
 * migration, not by sqliteStore's DDL — and the board's session-link query
 * ([SEC-08], five sources) references it in EVERY listCards call. The shared
 * fixture applies the same guarded ALTER; so does this file.
 */
function ensureSessionTypeColumn(db) {
  const result = db.exec('PRAGMA table_info(cowork_sessions)');
  const columns = result[0]?.values?.map((row) => row[1]) || [];
  if (!columns.includes('session_type')) {
    db.run("ALTER TABLE cowork_sessions ADD COLUMN session_type TEXT NOT NULL DEFAULT 'standard'");
  }
}

/** The exact raw-SQL rows for one state's single-state injection. */
function rowsForState(stateKey, anchorMs) {
  const spec = STATE_SPECS[stateKey];
  const tasks = [];
  const steps = [];
  for (const { slot, ageMs } of ACTIVITY_SLOTS) {
    const taskId = `iso-${stateKey}-${slot}`;
    const isClosed = stateKey === 'closed';
    tasks.push({
      id: taskId,
      status: spec.taskStatus,
      createdAtIso: isoAt(anchorMs, ageMs - 2 * 60 * MIN),
      updatedAtIso: isoAt(anchorMs, ageMs),
      completedAtIso: isClosed ? isoAt(anchorMs, ageMs) : null,
      closureConclusion: isClosed ? `isolated close-out for ${taskId}` : null,
    });
    spec.steps().forEach((step, index) => {
      steps.push({
        id: `iso-step-${stateKey}-${slot}-${step.key}`,
        taskId,
        ordinal: index + 1,
        status: step.status,
        dependencyStepIds: step.deps.map((dep) => `iso-step-${stateKey}-${slot}-${dep}`),
        createdAtIso: isoAt(anchorMs, STEP_FIXED_AGE_MS - 60 * MIN),
        updatedAtIso: isoAt(anchorMs, STEP_FIXED_AGE_MS),
      });
    });
  }
  return { tasks, steps };
}

function insertTask(db, task) {
  db.run(
    `INSERT INTO orchestration_tasks
      (id, owner_intent, enriched_goal, acceptance_criteria_json, source_session_id,
       twin_metabot_id, owner_global_meta_id, status, plan_version, created_at, updated_at, completed_at,
       closure_conclusion, closure_by, closure_at, closure_pin_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    [
      task.id,
      `five-states: ${task.id}`,
      `five-states goal for ${task.id}`,
      JSON.stringify([{ type: 'owner_defined', text: 'five-states isolation criterion' }]),
      null,
      TWIN_METABOT_ID,
      OWNER_GLOBAL_META_ID,
      task.status,
      task.createdAtIso,
      task.updatedAtIso,
      task.completedAtIso,
      task.closureConclusion,
      task.closureConclusion ? 'owner' : null,
      task.closureConclusion ? task.updatedAtIso : null,
      null,
    ],
  );
}

function insertStep(db, step) {
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
      `five-states step ${step.id}`,
      `five-states objective for ${step.id}`,
      JSON.stringify(['five-states isolation step criterion']),
      JSON.stringify(step.dependencyStepIds ?? []),
      WORKER_METABOT_ID,
      step.status,
      step.createdAtIso,
      step.updatedAtIso,
    ],
  );
}

/**
 * ONE brand-new isolated database per call: throwaway temp dir, base DDL
 * from SqliteStore, raw-SQL single-state seed, a board service over it.
 * (Temp dirs are left behind on purpose — this suite never deletes, exactly
 * like the shared fixture's openBoard helper.)
 */
async function openIsolatedBoard(stateKey) {
  const anchorMs = Date.now() + SEED_CLOCK_AHEAD_MS;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-five-states-'));
  const sqliteStore = await SqliteStore.create(dir);
  const db = sqliteStore.getDatabase();
  const orchestrationStore = new OrchestrationStore(db, sqliteStore.getSaveFunction());
  ensureSessionTypeColumn(db);
  const { tasks, steps } = rowsForState(stateKey, anchorMs);
  for (const task of tasks) insertTask(db, task);
  for (const step of steps) insertStep(db, step);
  sqliteStore.getSaveFunction()();
  const board = new TrackedTaskBoardService({
    db,
    orchestrationStore,
    saveDb: sqliteStore.getSaveFunction(),
  });
  return { sqliteStore, db, board, tasks };
}

/**
 * Content snapshot of EVERY user table. The board contract says reads are
 * side-effect free (storage holds facts only; every derived value is computed
 * at read time), so this string must be identical before and after any number
 * of listCards calls.
 */
function snapshotDatabase(db) {
  const tables = db.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )[0].values.map((row) => String(row[0]));
  return tables
    .map((table) => {
      const result = db.exec(`SELECT * FROM ${table} ORDER BY 1`);
      const columns = result[0]?.columns ?? [];
      const rows = (result[0]?.values ?? [])
        .map((values) => values
          .map((value) => (value === null ? '\u0000' : String(value)))
          .join('\u0001'));
      return `${table}::${columns.join(',')}\n${rows.join('\n')}`;
    })
    .join('\n=====\n');
}

/** The three injected ids, newest activity first — the expected list order. */
function expectedIdsNewestFirst(tasks) {
  return tasks.map((task) => task.id); // ACTIVITY_SLOTS are declared newest first
}

function assertStrictActivityDesc(cards, label) {
  assert.ok(cards.length >= 3, `${label}: the injection must carry >= 3 distinct-activity cards`);
  for (let index = 1; index < cards.length; index += 1) {
    assert.ok(
      cards[index - 1].activityAtMs > cards[index].activityAtMs,
      `${label}: activity must strictly descend (newest first), but `
        + `${cards[index].id} (${cards[index].activityAtMs}) did not come after `
        + `${cards[index - 1].id} (${cards[index - 1].activityAtMs})`,
    );
  }
}

/**
 * Shared per-state body for the four column states. `inspect` receives the
 * built boards for state-specific extra assertions (the producing fact code,
 * the closing conclusion, ...).
 */
async function assertSingleStateColumnIsolation(stateKey, inspect) {
  const { sqliteStore, db, board, tasks } = await openIsolatedBoard(stateKey);
  try {
    const expected = expectedIdsNewestFirst(tasks);
    const activityById = new Map(tasks.map((task) => [task.id, Date.parse(task.updatedAtIso)]));
    const before = snapshotDatabase(db);

    // -- (1) the cards land in EXACTLY the declared column, nowhere else ----
    const all = board.listCards({ scope: 'all' });
    assert.equal(all.scopeRequested, 'all');
    assert.equal(all.scopeApplied, 'all');
    assert.equal(all.scopeFallback, false);
    assert.equal(all.columns.length, COLUMN_STATES.length, 'the board exposes exactly the four contract columns');
    assert.deepEqual(all.columns.map((column) => column.state), COLUMN_STATES);
    for (const column of all.columns) {
      assert.equal(
        column.labelKey,
        COLUMN_LABEL_KEYS[column.state],
        `column ${column.state} must carry the contract i18n label key`,
      );
      assert.deepEqual(
        column.cardIds,
        column.state === stateKey ? expected : [],
        `single-state injection (${stateKey}): column ${column.state} must hold exactly `
          + `${column.state === stateKey ? 'the three injected ids' : 'nothing'} (zero leakage)`,
      );
    }
    assert.deepEqual(
      all.cards.map((card) => card.id),
      expected,
      'the card list is exactly the declared column population',
    );
    for (const card of all.cards) {
      assert.equal(card.state, stateKey, `${card.id}: derived state must be ${stateKey}`);
      assert.equal(card.admitted, true, `${card.id}: the injected card must be admitted`);
      assert.equal(card.closureDue, false, `${card.id}: a fresh injected card must not queue for closure`);
    }

    // ...never into the archive, and never folded away in the default scope.
    const archived = board.listCards({ scope: 'archived' });
    assert.deepEqual(
      archived.cards.map((card) => card.id),
      [],
      `${stateKey}: an admitted card must never leak into the archive scope`,
    );
    assert.equal(archived.counts.archived, 0, `${stateKey}: no injected card is archived`);
    const fallback = board.listCards();
    assert.equal(fallback.scopeApplied, 'default');
    assert.equal(fallback.scopeFallback, false);
    assert.deepEqual(
      fallback.cards.map((card) => card.id),
      expected,
      'fresh cards sit inside the default scope window: the default view folds nothing',
    );
    assert.equal(fallback.counts.folded, 0);

    // -- (2) inside the declared list: activity time, newest first ----------
    assertStrictActivityDesc(all.cards, `${stateKey} column`);
    for (const card of all.cards) {
      assert.equal(
        card.activityAtMs,
        activityById.get(card.id),
        `${card.id}: the activity anchor is exactly the seeded orchestration_tasks.updated_at `
          + '(every other activity source was seeded older on purpose)',
      );
    }

    // -- (3) counts match the injection -------------------------------------
    assert.deepEqual(all.counts, {
      total: 3,
      visible: 3,
      folded: 0,
      admitted: 3,
      archived: 0,
      staleRegistration: 0,
      admissionInputMissing: 0,
      closureDue: 0,
      zombieLevel: 0,
      terminalNoConclusionLevel: 0,
      sessionsEndedLevel: 0,
    });

    if (inspect) inspect({ all, archived, fallback, board, tasks });

    // -- (4) reading writes nothing -----------------------------------------
    assert.equal(
      snapshotDatabase(db),
      before,
      'reading the board in three scopes must not write a single cell of the isolated database',
    );
  } finally {
    sqliteStore.close();
  }
}

test('waiting_decision（待你拍板）：隔离 DB + 单状态注入 —— 仅落入本列、列内活动倒序、counts 一致、读库零写入', async () => {
  await assertSingleStateColumnIsolation('waiting_decision', ({ all }) => {
    for (const card of all.cards) {
      assert.ok(
        card.reasonCodes.some((fact) => fact.code === 'ledger_review'),
        `${card.id}: must carry the ledger_review fact — status=review is the declared 待你拍板 landing point`,
      );
    }
  });
});

test('in_progress（进行中）：隔离 DB + 单状态注入 —— 仅落入本列、列内活动倒序、counts 一致、读库零写入', async () => {
  await assertSingleStateColumnIsolation('in_progress', ({ all }) => {
    for (const card of all.cards) {
      assert.ok(
        card.reasonCodes.some((fact) => fact.code === 'steps_active'),
        `${card.id}: must carry the steps_active fact — plain running work is what 进行中 means`,
      );
    }
  });
});

test('blocked_external（等外部·阻塞）：隔离 DB + 单状态注入 —— 仅落入本列、列内活动倒序、counts 一致、读库零写入', async () => {
  await assertSingleStateColumnIsolation('blocked_external', ({ all }) => {
    for (const card of all.cards) {
      assert.ok(
        card.reasonCodes.some((fact) => fact.code === 'blocked_unmet_dependencies'),
        `${card.id}: must carry the blocked_unmet_dependencies fact — an unmet dependency is what 等外部·阻塞 means`,
      );
      assert.deepEqual(
        card.admissionMatched.filter((rule) => rule === 'ADM-4'),
        ['ADM-4'],
        `${card.id}: the dependency that blocks the step also admits the card (ADM-4)`,
      );
    }
  });
});

test('closed（已收口）：隔离 DB + 单状态注入 —— 仅落入本列、列内活动倒序、counts 一致、读库零写入', async () => {
  await assertSingleStateColumnIsolation('closed', ({ all, tasks }) => {
    const conclusionsById = new Map(tasks.map((task) => [task.id, task.closureConclusion]));
    for (const card of all.cards) {
      assert.equal(
        card.closureConclusion,
        conclusionsById.get(card.id),
        `${card.id}: the closing conclusion seeded on the ledger row must surface unchanged`,
      );
      assert.equal(card.actionRank, 4, `${card.id}: a closed card sits at the lowest list weight`);
    }
  });
});

test('archived（归档）：隔离 DB + ¬admitted 注入 —— 仅归档范围可达、活动倒序、counts 一致、list 前后库快照一致', async () => {
  const { sqliteStore, db, board, tasks } = await openIsolatedBoard('archived');
  try {
    const expected = expectedIdsNewestFirst(tasks);
    const activityById = new Map(tasks.map((task) => [task.id, Date.parse(task.updatedAtIso)]));
    const before = snapshotDatabase(db);

    // -- (1) the archive scope holds EXACTLY the injected rows --------------
    const archive = board.listCards({ scope: 'archived' });
    assert.equal(archive.scopeRequested, 'archived');
    assert.equal(archive.scopeApplied, 'archived');
    assert.equal(archive.scopeFallback, false);
    assert.deepEqual(
      archive.cards.map((card) => card.id),
      expected,
      'the archive scope is exactly the ¬admitted population',
    );
    for (const card of archive.cards) {
      assert.equal(
        card.admitted,
        false,
        `${card.id}: unregistered + zero steps must fail every admission rule`,
      );
      assert.deepEqual(card.admissionMatched, [], `${card.id}: no ADM rule may match`);
      assert.equal(card.closureDue, false, `${card.id}: archived rows never queue for closure`);
      assert.equal(card.closureDueLevel, null, `${card.id}: archived rows carry no closure level`);
      assert.equal(card.closureSuggestionCode, null, `${card.id}: archived rows carry no suggestion`);
      assert.equal(
        card.state,
        'in_progress',
        `${card.id}: an archive row keeps its derived ledger state (here in_progress) — `
          + 'the archive is a projection, not a fifth column',
      );
    }

    // ...and it leaks into NO board column, in either board scope.
    for (const scope of ['all', 'default']) {
      const boardView = board.listCards({ scope });
      assert.deepEqual(
        boardView.cards.map((card) => card.id),
        [],
        `scope=${scope}: archived rows must stay off the board`,
      );
      for (const column of boardView.columns) {
        assert.deepEqual(
          column.cardIds,
          [],
          `scope=${scope}: column ${column.state} must be empty (zero leakage)`,
        );
      }
      assert.equal(boardView.counts.folded, 0, `scope=${scope}: nothing on the board, nothing folded either`);
    }

    // -- (2) inside the archive list: activity time, newest first -----------
    assertStrictActivityDesc(archive.cards, 'archive scope');
    for (const card of archive.cards) {
      assert.equal(
        card.activityAtMs,
        activityById.get(card.id),
        `${card.id}: the activity anchor is exactly the seeded orchestration_tasks.updated_at`,
      );
    }

    // -- (3) counts match the injection -------------------------------------
    assert.deepEqual(archive.counts, {
      total: 3,
      visible: 3,
      folded: 0,
      admitted: 0,
      archived: 3,
      staleRegistration: 0,
      admissionInputMissing: 0,
      closureDue: 0,
      zombieLevel: 0,
      terminalNoConclusionLevel: 0,
      sessionsEndedLevel: 0,
    });
    const allCounts = board.listCards({ scope: 'all' }).counts;
    assert.equal(allCounts.total, 3, 'total is scope-independent: the whole ledger');
    assert.equal(allCounts.admitted, 0);
    assert.equal(allCounts.archived, 3);
    assert.equal(allCounts.visible, 0, 'the all-scope of an all-archived board is empty');

    // The archive stays queryable through the deep link (freeze doc §6 保留可查).
    const detail = board.getCard(expected[0]);
    assert.ok(detail, 'an archived row must stay reachable through getCard');
    assert.equal(detail.admitted, false);

    // -- (4) reading writes nothing -----------------------------------------
    assert.equal(
      snapshotDatabase(db),
      before,
      'reading the archive (plus both board scopes and a detail) must not write a single cell',
    );
  } finally {
    sqliteStore.close();
  }
});
