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

const { seedLongTaskBoard } = await import('./fixtures/longTaskBoardSeed.mjs');

/**
 * The fixture declares exact-threshold cases (exactly 24h / exactly 48h) which
 * have zero tolerance, while the board reads the real wall clock. Seeding one
 * minute into the future keeps every declared boundary stable for ~60s of run
 * time: each age lands just INSIDE the declared bucket instead of drifting past
 * it. Everything the fixture asserts stays reproducible inside that window.
 */
const SEED_CLOCK_AHEAD_MS = 60_000;

async function openBoard(anchorMs = Date.now() + SEED_CLOCK_AHEAD_MS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-tracked-task-'));
  const sqliteStore = await SqliteStore.create(dir);
  const orchestrationStore = new OrchestrationStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  const manifest = seedLongTaskBoard(sqliteStore, { anchorMs });
  const board = new TrackedTaskBoardService({
    db: sqliteStore.getDatabase(),
    orchestrationStore,
    saveDb: sqliteStore.getSaveFunction(),
  });
  return { sqliteStore, orchestrationStore, board, manifest, dir };
}

/** The fixture declares board columns by their short key; the IPC returns the enum. */
const COLUMN_TO_STATE = {
  decide: 'waiting_decision',
  active: 'in_progress',
  blocked: 'blocked_external',
  closed: 'closed',
};

function cardById(board, id) {
  const card = board.listCards({ scope: 'all' }).cards.find((candidate) => candidate.id === id);
  assert.ok(card, `card ${id} missing from the board`);
  return card;
}

test('every seeded case lands in the column the shared fixture declares', async () => {
  const { sqliteStore, board, manifest } = await openBoard();
  try {
    const cards = new Map(board.listCards({ scope: 'all' }).cards.map((card) => [card.id, card]));
    const archived = new Map(board.listCards({ scope: 'archived' }).cards.map((card) => [card.id, card]));
    for (const testCase of manifest.cases) {
      if (!testCase.orchestrationTaskId) continue; // e.g. the independent-session case
      // v1.1: a case that declares itself unadmitted is deliberately OFF the
      // board and must be queryable through the archive instead.
      if (testCase.admission?.admitted === false) {
        assert.equal(
          cards.has(testCase.orchestrationTaskId),
          false,
          `${testCase.id}: an unadmitted card must not appear on the board`,
        );
        const archivedCard = archived.get(testCase.orchestrationTaskId);
        assert.ok(archivedCard, `${testCase.id}: archived card ${testCase.orchestrationTaskId} must stay queryable`);
        assert.equal(archivedCard.closureDue, false, `${testCase.id}: archived rows never queue for closure`);
        assert.equal(archivedCard.closureDueLevel, null, `${testCase.id}: archived rows carry no closure level`);
        continue;
      }
      const card = cards.get(testCase.orchestrationTaskId);
      assert.ok(card, `${testCase.id}: card ${testCase.orchestrationTaskId} missing`);
      assert.equal(card.state, COLUMN_TO_STATE[testCase.boardColumn], `${testCase.id}: ${testCase.title}`);
      assert.equal(
        archived.has(testCase.orchestrationTaskId),
        false,
        `${testCase.id}: an admitted card must never be in the archive`,
      );
    }
  } finally {
    sqliteStore.close();
  }
});

test('thresholds use strict greater-than and the idle signal is the multi-source max', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    // E3: exactly 24h / 48h must not trip the next bucket.
    assert.equal(cardById(board, 'seed-task-09').closureWarn, false, '24h - 10min must not warn');
    assert.equal(cardById(board, 'seed-task-10').closureWarn, false, 'exactly 24h must NOT warn');
    assert.equal(cardById(board, 'seed-task-11').closureWarn, true, '24h + 10min must warn');
    assert.equal(cardById(board, 'seed-task-12').closureDue, false, '48h - 10min must not be a zombie');
    assert.equal(cardById(board, 'seed-task-13').closureDue, false, 'exactly 48h must NOT be a zombie');
    assert.equal(cardById(board, 'seed-task-13').closureWarn, true, 'exactly 48h is still a warning');
    assert.equal(cardById(board, 'seed-task-14').closureDue, true, '48h + 10min must be a zombie');

    // SEED-07/08: task.updated_at is 3-5 days old while a step/attempt is minutes
    // old. Reading only task.updated_at would produce a false-positive zombie.
    const freshStep = cardById(board, 'seed-task-07');
    assert.equal(freshStep.closureWarn, false, 'SEED-07: a fresh step must defeat a stale task row');
    const freshAttempt = cardById(board, 'seed-task-08');
    assert.equal(freshAttempt.closureWarn, false, 'SEED-08: a fresh queued attempt must defeat stale rows');

    // SEED-22: a future timestamp clamps to zero idle instead of throwing or going negative.
    const skewed = cardById(board, 'seed-task-22');
    assert.equal(skewed.idleMs, 0, 'SEED-22: future timestamps clamp to 0 idle');
    assert.equal(skewed.closureWarn, false, 'SEED-22: clock skew must not warn');
  } finally {
    sqliteStore.close();
  }
});

test('derivation rules and precedence per the architecture contract', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    // §2.2 precedence: waiting_decision beats blocked_external (SEED-24).
    assert.equal(cardById(board, 'seed-task-24').state, 'waiting_decision');
    // §2.4 E6 generalised: a terminal status with no conclusion is not closed.
    const failed = cardById(board, 'seed-task-18');
    assert.equal(failed.state, 'waiting_decision', 'failed without a conclusion is not 已收口');
    assert.equal(failed.closureDue, true, 'failed without a conclusion is due for closure');
    assert.match(failed.closureSuggestion, /terminal status/i);
    // §2.2 R4: a blocked step whose dependencies are all completed is NOT 等外部.
    assert.equal(cardById(board, 'seed-task-04').state, 'in_progress');
    // Verifiable deliverables feed the closing suggestion (R2).
    const delivered = cardById(board, 'seed-task-23');
    assert.equal(delivered.state, 'in_progress');
    assert.match(delivered.reasons.join(' | '), /verifiable deliverable/i);
  } finally {
    sqliteStore.close();
  }
});

test('board columns are mutually exclusive, complete, and one ledger only', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    const result = board.listCards({ scope: 'all' });
    const seen = new Set();
    for (const column of result.columns) {
      for (const cardId of column.cardIds) {
        assert.equal(seen.has(cardId), false, `${cardId} appears in more than one column`);
        seen.add(cardId);
      }
    }
    assert.equal(seen.size, result.cards.length, 'every card must appear in exactly one column');
    assert.equal(result.ledger, 'orchestration_tasks');

    const db = sqliteStore.getDatabase();
    const tables = db.exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE '%tracking%' OR name LIKE '%long_term%')",
    );
    assert.equal((tables[0]?.values ?? []).length, 0, 'the board must not create a fourth table');

    const columns = db.exec('PRAGMA table_info(orchestration_tasks)')[0].values.map((row) => row[1]);
    assert.equal(columns.includes('card_state'), false, 'card_state must be derived, never persisted');
    for (const column of ['closure_conclusion', 'closure_by', 'closure_at', 'closure_pin_id']) {
      assert.ok(columns.includes(column), `closure column ${column} missing`);
    }

    const scheduledColumns = db.exec('PRAGMA table_info(scheduled_tasks)')[0].values.map((row) => row[1]);
    assert.ok(
      scheduledColumns.includes('orchestration_task_id'),
      'scheduled_tasks needs the at-most-one-card binding column',
    );
  } finally {
    sqliteStore.close();
  }
});

test('closing a card goes through the state machine and persists the conclusion', async () => {
  const { sqliteStore, board, orchestrationStore } = await openBoard();
  try {
    const before = cardById(board, 'seed-task-01');
    assert.equal(before.state, 'waiting_decision');

    const empty = board.closeCard({ taskId: 'seed-task-01', conclusion: '   ', by: 'twin' });
    assert.equal(empty.ok, false);
    assert.equal(empty.code, 'VALIDATION');

    const closed = board.closeCard({ taskId: 'seed-task-01', conclusion: 'shipped: card closed by test', by: 'twin' });
    assert.equal(closed.ok, true, closed.error);
    assert.equal(closed.card.state, 'closed');
    assert.equal(closed.card.closureConclusion, 'shipped: card closed by test');
    assert.equal(orchestrationStore.getTask('seed-task-01').status, 'completed');

    const missing = board.closeCard({ taskId: 'nope', conclusion: 'x', by: 'owner' });
    assert.equal(missing.code, 'NOT_FOUND');
  } finally {
    sqliteStore.close();
  }
});

test('a non-terminal card is moved through the whitelist, and a terminal one is left alone', async () => {
  const { sqliteStore, board, orchestrationStore } = await openBoard();
  try {
    // review -> completed is whitelisted: the status moves.
    const moved = board.closeCard({ taskId: 'seed-task-01', conclusion: 'first close', by: 'owner' });
    assert.equal(moved.ok, true, moved.error);
    assert.equal(moved.statusMoved, true);
    assert.equal(orchestrationStore.getTask('seed-task-01').status, 'completed');

    // A cancelled card is already terminal: no move is attempted, and the
    // ledger must not be rewritten into a different status by the board.
    const terminal = board.closeCard({ taskId: 'seed-task-17', conclusion: 'already cancelled', by: 'twin' });
    assert.equal(terminal.ok, true, terminal.error);
    assert.equal(terminal.statusMoved, false);
    assert.equal(orchestrationStore.getTask('seed-task-17').status, 'cancelled');
    assert.equal(terminal.card.state, 'closed');
  } finally {
    sqliteStore.close();
  }
});

test('card <-> session binding resolves in both directions', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    const sessions = board.listCardSessions('seed-task-19');
    assert.ok(sessions.some((link) => link.sessionId === 'group-task:8301' && link.role === 'source'));

    const reversed = board.listCardsForSession('group-task:8301');
    assert.deepEqual(reversed, [{ cardId: 'seed-task-19', role: 'source' }]);

    assert.deepEqual(board.listCardsForSession('no-such-session'), [], 'an unlinked session has no card');
  } finally {
    sqliteStore.close();
  }
});

test('a scheduled task bound to a card is reported as such', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    // The fixture seeds the scheduled-task card through source_session_id only
    // (the pre-migration reality). Bind it the way the migration enables and
    // re-read: the card must now resolve its scheduled task.
    sqliteStore.getDatabase().run(
      'UPDATE scheduled_tasks SET orchestration_task_id = ? WHERE id = ?',
      ['seed-task-21', 'seed-sched-01'],
    );
    const card = cardById(board, 'seed-task-21');
    assert.equal(card.sourceKind, 'scheduled_task');
    assert.equal(card.scheduledTaskId, 'seed-sched-01');

    const sessions = board.listCardSessions('seed-task-21');
    assert.ok(sessions.some((link) => link.sessionId === 'scheduled-task:seed-sched-01'));
  } finally {
    sqliteStore.close();
  }
});

test('the board is deterministic: a second service over the same rows agrees', async () => {
  const { sqliteStore, board, orchestrationStore } = await openBoard();
  try {
    const second = new TrackedTaskBoardService({
      db: sqliteStore.getDatabase(),
      orchestrationStore,
      saveDb: sqliteStore.getSaveFunction(),
    });
    const first = board.listCards({ scope: 'all' });
    const again = second.listCards({ scope: 'all' });
    const project = (result) => result.cards.map((card) => ({
      id: card.id,
      state: card.state,
      closureWarn: card.closureWarn,
      closureDue: card.closureDue,
      actionRank: card.actionRank,
    }));
    assert.deepEqual(project(again), project(first), 'derived card state must not depend on service instance state');

    const detail = board.getCard('seed-task-23');
    assert.equal(detail.sourceKind, 'group_task');
    assert.equal(detail.groupTaskId, 8303);
    assert.deepEqual(detail.deliverables.map((item) => item.status), ['delivered', 'delivered']);
    assert.ok(detail.sessions.some((link) => link.sessionId === 'group-task:8303'));
  } finally {
    sqliteStore.close();
  }
});

test('the default scope folds old quiet cards but never hides them', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    const all = board.listCards({ scope: 'all' });
    const scoped = board.listCards();

    assert.equal(scoped.scopeApplied, 'default');
    assert.equal(all.scopeApplied, 'all');
    assert.equal(scoped.counts.total, all.counts.total);
    assert.ok(scoped.counts.folded >= 2, `expected the 10-day-old closed cards to fold (got ${scoped.counts.folded})`);
    // v1.1: `folded` counts ADMITTED cards the default window hides; archived
    // rows are a separate population and are never "folded" (freeze doc §6).
    assert.equal(scoped.counts.visible + scoped.counts.folded, scoped.counts.admitted);
    assert.equal(scoped.counts.admitted + scoped.counts.archived, scoped.counts.total);

    // Folded, not hidden: the ids are reachable through scope=all.
    const visibleIds = new Set(scoped.cards.map((card) => card.id));
    for (const id of ['seed-task-16', 'seed-task-17']) {
      assert.equal(visibleIds.has(id), false, `${id} should be folded out of the default scope`);
      assert.ok(all.cards.some((card) => card.id === id), `${id} must stay reachable via scope=all`);
    }
  } finally {
    sqliteStore.close();
  }
});

test('the list view ranks cards by the contract weights, ties on earlier activity', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    const cards = board.listCards({ scope: 'all' }).cards;
    const ranks = cards.map((card) => card.actionRank);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), 'cards must be sorted by actionRank');
    for (const card of cards) {
      if (card.closureDue && card.state !== 'closed') assert.equal(card.actionRank, 0);
      else if (card.state === 'waiting_decision') assert.equal(card.actionRank, 1);
      else if (card.state === 'blocked_external') assert.equal(card.actionRank, 2);
      else if (card.state === 'in_progress') assert.equal(card.actionRank, 3);
      else assert.equal(card.actionRank, 4);
    }
  } finally {
    sqliteStore.close();
  }
});

test('pagination pages the sorted list without losing cards', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    const all = board.listCards({ scope: 'all' });
    const firstPage = board.listCards({ scope: 'all', limit: 10 });
    assert.equal(firstPage.cards.length, 10);
    assert.equal(firstPage.hasMore, true);
    const secondPage = board.listCards({ scope: 'all', limit: 10, offset: 10 });
    assert.deepEqual(
      secondPage.cards.map((card) => card.id),
      all.cards.slice(10, 20).map((card) => card.id),
    );
    const lastPage = board.listCards({ scope: 'all', limit: 1000 });
    assert.equal(lastPage.hasMore, false);
    assert.equal(lastPage.cards.length, all.cards.length);
  } finally {
    sqliteStore.close();
  }
});

test('closing a failed card keeps its status and still closes the card (F1)', async () => {
  const { sqliteStore, board, orchestrationStore } = await openBoard();
  try {
    const before = cardById(board, 'seed-task-18');
    assert.equal(before.state, 'waiting_decision');
    assert.equal(before.ledgerStatus, 'failed');

    const closed = board.closeCard({ taskId: 'seed-task-18', conclusion: 'abandoned after the failure', by: 'owner' });
    assert.equal(closed.ok, true, closed.error);
    assert.equal(closed.statusMoved, false, 'a terminal ledger status must not be moved');
    assert.equal(orchestrationStore.getTask('seed-task-18').status, 'failed', 'status stays failed');
    assert.equal(closed.card.state, 'closed', 'a terminal status plus a conclusion IS closed');
    assert.equal(closed.card.closureDue, false);
  } finally {
    sqliteStore.close();
  }
});

test('liveness lives in kv only: no heartbeat column is added to the ledger', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    const columns = sqliteStore.getDatabase().exec('PRAGMA table_info(orchestration_tasks)')[0]
      .values.map((row) => row[1]);
    assert.equal(columns.includes('heartbeat_at'), false, 'the chair ruled the heartbeat must not be a column');
    assert.equal(columns.includes('card_state'), false);
    for (const column of ['closure_conclusion', 'closure_by', 'closure_at', 'closure_pin_id']) {
      assert.ok(columns.includes(column), `closure column ${column} missing`);
    }

    assert.equal(board.readTickBeat(), null);
    board.recordTickBeat(1_700_000_000_000);
    assert.equal(board.readTickBeat(), 'local|1700000000000');
    const kvKeys = sqliteStore.getDatabase().exec('SELECT key, value FROM kv')[0].values;
    const beat = kvKeys.find((row) => String(row[0]) === 'tracking_tick_beat');
    assert.ok(beat, 'the beat key must exist');
    assert.equal(
      /seed-task-|seed-step-|seed-attempt-/.test(String(beat[1])),
      false,
      'the beat value is liveness only — it must never carry a card-level value',
    );
    // v1.1: `tracked_long_task_registry` is the ONE documented card-id carrier
    // in kv (ADM-1). It is data, not liveness — and it is deliberately the only
    // exception, so a new card-level key would still fail this assertion.
    const registry = kvKeys.find((row) => String(row[0]) === 'tracked_long_task_registry');
    assert.ok(registry, 'the v1.1 registration key must exist');
    assert.deepEqual(
      board.listRegisteredLongTaskIds(),
      JSON.parse(String(registry[1])),
      'the registry accessor must read exactly what the kv row holds',
    );
  } finally {
    sqliteStore.close();
  }
});

test('the sweep assesses read-only and only writes the process beat', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    const db = sqliteStore.getDatabase();
    const snapshot = () => db.exec('SELECT id, updated_at FROM orchestration_tasks ORDER BY id')[0]
      .values.map((row) => row.join('|')).join('\n');
    const before = snapshot();

    const result = board.sweep(1_700_000_000_000);
    assert.ok(result.assessed > 0);
    assert.equal(result.beat, `local|1700000000000`);
    assert.equal(board.readTickBeat(), 'local|1700000000000');
    assert.equal(snapshot(), before, 'the sweep must not write any card row');

    const tables = db.exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE '%tracking%' OR name LIKE '%long_term%')",
    );
    assert.equal((tables[0]?.values ?? []).length, 0, 'still no fourth table');
  } finally {
    sqliteStore.close();
  }
});

test('the drawer summary is hard-truncated to five lines with an overflow marker', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    for (const card of board.listCards({ scope: 'all' }).cards) {
      assert.ok(card.reasons.length <= 5, `${card.id} returned ${card.reasons.length} reason lines`);
      assert.equal(card.reasonOverflow >= 0, true);
    }
    const detail = board.getCard('seed-task-24');
    assert.ok(detail.reasons.length <= 5);
    assert.equal(detail.owner.twinMetabotId > 0, true);
    assert.ok(detail.participants.includes(detail.owner.twinMetabotId));
  } finally {
    sqliteStore.close();
  }
});

test('card <-> session binding covers all five sources and the independent negative case', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    const rolesFor = (cardId) => new Set(board.listCardSessions(cardId).map((link) => link.role));
    assert.ok(rolesFor('seed-task-05').has('source'), 'S1 source session');
    assert.ok(rolesFor('seed-task-07').has('worker_attempt'), 'S2 worker attempt session');
    // S3/S5 need the card binding the migration enables.
    sqliteStore.getDatabase().run('UPDATE scheduled_tasks SET orchestration_task_id = ? WHERE id = ?', [
      'seed-task-21',
      'seed-sched-01',
    ]);
    assert.ok(rolesFor('seed-task-21').has('scheduled_run'), 'S3 scheduled run session');
    assert.ok(rolesFor('seed-task-21').has('scheduled_home'), 'S5 scheduled home session');

    // S4 keeps the full group-chat predicate on cowork_sessions.session_type.
    const groupLinks = board.listCardSessions('seed-task-19');
    assert.deepEqual(
      groupLinks.find((link) => link.role === 'group_chat'),
      { sessionId: 'seed-session-gt-8301', role: 'group_chat' },
    );
    assert.deepEqual(
      board.listCardsForSession('seed-session-gt-8301'),
      [{ cardId: 'seed-task-19', role: 'group_chat' }],
    );

    // A session whose type is NOT group_task must not resolve through S4.
    sqliteStore.getDatabase().run("UPDATE cowork_sessions SET session_type = 'standard' WHERE id = ?", ['seed-session-gt-8301']);
    assert.deepEqual(board.listCardsForSession('seed-session-gt-8301'), []);

    // The independent session belongs to no card: never invent an owner.
    assert.deepEqual(board.listCardsForSession('seed-session-independent'), []);
  } finally {
    sqliteStore.close();
  }
});

test('session-ended raises closureDue without closing or moving the card', async () => {
  const { sqliteStore, board, orchestrationStore } = await openBoard();
  try {
    const card = cardById(board, 'seed-task-26');
    assert.equal(card.closureDue, true);
    assert.equal(card.closureDueLevel, 'sessions_ended');
    assert.equal(card.state, 'in_progress', 'R3 assesses closure; it never moves the card');
    assert.equal(orchestrationStore.getTask('seed-task-26').status, 'running');
    assert.equal(card.closureSuggestionCode, 'session_ended');
    assert.match(card.closureSuggestion, /session has ended/i);

    const counts = board.listCards({ scope: 'all' }).counts;
    assert.equal(counts.sessionsEndedLevel, 1);
  } finally {
    sqliteStore.close();
  }
});

test('the daemon sweep is throttled to a day-scale window, not the 5s tick', async () => {
  const { isTrackedSweepDue } = await import('../dist-electron/main/services/groupTaskDaemon.js');
  const HOUR = 3_600_000;
  assert.equal(isTrackedSweepDue(0, 1_700_000_000_000, HOUR), true, 'never ran -> due');
  assert.equal(isTrackedSweepDue(1_700_000_000_000, 1_700_000_000_000 + 5_000, HOUR), false, 'a 5s tick is not due');
  assert.equal(isTrackedSweepDue(1_700_000_000_000, 1_700_000_000_000 + HOUR - 1, HOUR), false);
  assert.equal(isTrackedSweepDue(1_700_000_000_000, 1_700_000_000_000 + HOUR, HOUR), true);
});

test('scheduled tasks attach on explicit confirmation only, idempotently (D2)', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    // A scheduled task already anchored to a card (SEED-21) is NOT offered again.
    assert.ok(
      board.listUnattachedScheduledTasks().every((task) => task.id !== 'seed-sched-01'),
      'a scheduled task whose card already exists must not be offered for attachment',
    );

    // A genuinely new scheduled task is offered, and only attaches when named.
    sqliteStore.getDatabase().run(
      `INSERT INTO scheduled_tasks
        (id, name, description, enabled, schedule_json, prompt, execution_mode, notify_platforms_json,
         consecutive_errors, created_at, updated_at)
       VALUES ('seed-sched-new', 'fresh scheduled task', '', 1, '{}', 'p', 'auto', '[]', 0, 'x', 'x')`,
    );
    const unattached = board.listUnattachedScheduledTasks();
    assert.deepEqual(unattached.map((task) => task.id), ['seed-sched-new'], 'nothing is attached by itself');
    assert.equal(unattached[0].enabled, true);
    assert.equal(unattached[0].name, 'fresh scheduled task');

    const first = board.attachScheduledTasks({
      scheduledTaskIds: ['seed-sched-new'],
      ownerGlobalMetaId: 'idq1t3lzq0q4rec8edujklp4w8hfmgceqxth82a7m9',
      twinMetabotId: 1,
    });
    assert.deepEqual(first.skipped, []);
    assert.equal(first.attached.length, 1);
    assert.equal(first.attached[0].reused, false);
    const cardId = first.attached[0].cardId;

    const link = sqliteStore.getDatabase()
      .exec('SELECT orchestration_task_id FROM scheduled_tasks WHERE id = ?', ['seed-sched-new'])[0].values[0][0];
    assert.equal(link, cardId, 'the binding column must point at the card');
    assert.equal(cardById(board, cardId).sourceKind, 'scheduled_task');

    const second = board.attachScheduledTasks({
      scheduledTaskIds: ['seed-sched-new'],
      ownerGlobalMetaId: 'idq1t3lzq0q4rec8edujklp4w8hfmgceqxth82a7m9',
      twinMetabotId: 1,
    });
    assert.equal(second.attached[0].reused, true);
    assert.equal(second.attached[0].cardId, cardId, 're-running must not create a second card');
    assert.deepEqual(board.listUnattachedScheduledTasks(), [], 'once attached it leaves the confirm list');

    const ownerless = board.attachScheduledTasks({
      scheduledTaskIds: ['seed-sched-new'],
      ownerGlobalMetaId: '',
      twinMetabotId: 1,
    });
    assert.equal(ownerless.attached.length, 0);
    assert.match(ownerless.skipped[0].reason, /owner/i);
  } finally {
    sqliteStore.close();
  }
});

test('closureDue levels stay exclusive, ordered, and never merged (appendix A-2)', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    const all = () => board.listCards({ scope: 'all' }).cards;
    const LEVELS = ['zombie', 'terminal_no_conclusion', 'sessions_ended'];

    for (const card of all()) {
      assert.ok(
        card.closureDueLevel === null || LEVELS.includes(card.closureDueLevel),
        `${card.id}: unexpected level ${card.closureDueLevel}`,
      );
      // The boolean is exactly "any level set": the three levels are never merged away.
      assert.equal(card.closureDue, card.closureDueLevel !== null, `${card.id}: boolean/level disagree`);
      // Level 2 needs no `!closed` guard: a terminal-without-conclusion card is
      // by construction NOT closed, so the level can never sit on a closed card.
      if (card.closureDueLevel === 'terminal_no_conclusion') {
        assert.notEqual(card.state, 'closed', `${card.id}: level 2 on a closed card`);
      }
    }

    const counts = board.listCards({ scope: 'all' }).counts;
    assert.equal(counts.closureDue, counts.zombieLevel + counts.terminalNoConclusionLevel + counts.sessionsEndedLevel);

    // Fixed priority: terminal_no_conclusion > zombie > sessions_ended.
    sqliteStore.getDatabase().run('UPDATE orchestration_tasks SET updated_at = ? WHERE id = ?', [
      new Date(Date.now() - 3 * 86_400_000).toISOString(),
      'seed-task-18',
    ]);
    const priority = cardById(board, 'seed-task-18');
    assert.equal(priority.closureDueLevel, 'terminal_no_conclusion', 'level 2 outranks level 1');
    assert.ok(priority.closureWarn, 'the zombie signal is still reported through closureWarn');
  } finally {
    sqliteStore.close();
  }
});

test('needsOwnerAction is exactly the declaration it claims (appendix A-4)', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    for (const card of board.listCards({ scope: 'all' }).cards) {
      assert.equal(
        card.needsOwnerAction,
        card.state === 'waiting_decision' || card.closureDue,
        `${card.id}: needsOwnerAction does not match (waiting_decision || closureDue)`,
      );
      // Implication: a closed card can never demand owner action.
      if (card.state === 'closed') assert.equal(card.needsOwnerAction, false, `${card.id}: closed but needs action`);
    }
    // Table-driven rank check over the contract weights.
    const EXPECTED = {
      waiting_decision: 1,
      blocked_external: 2,
      in_progress: 3,
      closed: 4,
    };
    for (const card of board.listCards({ scope: 'all' }).cards) {
      const expected = card.closureDue && card.state !== 'closed' ? 0 : EXPECTED[card.state];
      assert.equal(card.actionRank, expected, `${card.id}: actionRank ${card.actionRank} != ${expected}`);
    }
  } finally {
    sqliteStore.close();
  }
});

test('card deliverables carry the single parser verdict over the source message (SEC-11)', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    const detail = board.getCard('seed-task-23');
    assert.equal(detail.deliverables.length, 2);

    const [good, bad] = detail.deliverables;
    assert.equal(good.kind, 'pin');
    assert.equal(good.sourceMessageFound, true, 'the source message body must be joined in');
    assert.equal(good.valid, true, 'a well-formed [DELIVERABLE] line validates');
    assert.deepEqual(good.issues, []);

    assert.equal(bad.sourceMessageFound, true);
    assert.equal(bad.valid, false, 'a truncated pinid must NOT validate');
    assert.ok(bad.issues.length > 0, 'the parser reason must be surfaced, not swallowed');

    // Trichotomy: no source body -> unknown (null), explicitly NOT "invalid".
    sqliteStore.getDatabase().run('UPDATE group_task_deliverables SET msg_pin_id = ? WHERE uri = ?', [
      'f'.repeat(64) + 'i0',
      'pin://deadbeef',
    ]);
    const unknown = board.getCard('seed-task-23').deliverables[1];
    assert.equal(unknown.sourceMessageFound, false);
    assert.equal(unknown.valid, null, 'a missing source body is unknown, never "invalid"');
    assert.deepEqual(unknown.issues, []);
  } finally {
    sqliteStore.close();
  }
});

test('the two orchestration_tasks DDL definitions declare the same column set (R4 guard)', async () => {
  const fs = await import('node:fs');
  const extract = (source) => {
    const start = source.indexOf('CREATE TABLE IF NOT EXISTS orchestration_tasks (');
    assert.notEqual(start, -1, 'orchestration_tasks DDL not found');
    const end = source.indexOf(');', start);
    return source
      .slice(start, end)
      .split('\n')
      .map((line) => line.trim().replace(/,$/, ''))
      .filter((line) => /^[a-z_][a-z0-9_]*\s+[A-Z]/i.test(line))
      .map((line) => line.split(/\s+/)[0])
      .sort();
  };
  const fromStore = extract(fs.readFileSync('src/main/sqliteStore.ts', 'utf8'));
  const fromOrchestration = extract(fs.readFileSync('src/main/orchestrationStore.ts', 'utf8'));
  assert.ok(fromStore.length >= 12, `expected the base columns, saw ${fromStore.length}`);
  assert.deepEqual(
    fromOrchestration,
    fromStore,
    'the two DDL copies must declare identical column sets: whichever runs first wins and drift is silent',
  );
});

test('structured facts are authoritative and the diagnostic strings derive from them (A-6)', async () => {
  const { sqliteStore, board, orchestrationStore } = await openBoard();
  try {
    const mod = await import('../dist-electron/main/services/trackedTaskBoard.js');
    const KEY_REGISTRY = mod.TRACKED_FACT_CODE_I18N_KEY; // per-code index (NOT the render table)
    const REASON_KEYS = mod.TRACKED_REASON_I18N_KEY;
    const SUGGESTION_KEYS = mod.TRACKED_SUGGESTION_I18N_KEY;
    const RENDER = mod.renderTrackedSuggestion;

    for (const card of board.listCards({ scope: 'all' }).cards) {
      // Rule 1/3: one structured fact per diagnostic line, same length and order.
      assert.equal(card.reasonCodes.length, card.reasons.length, `${card.id}: codes/reasons length mismatch`);
      for (const [index, fact] of card.reasonCodes.entries()) {
        assert.equal(typeof fact.code, 'string', `${card.id}[${index}]: code missing`);
        assert.ok(REASON_KEYS[fact.code], `${card.id}[${index}]: code ${fact.code} has no reason-side i18n key`);
        assert.equal(typeof fact.params, 'object', `${card.id}[${index}]: args missing`);
      }
      // Rule 4: a suggestion exists exactly when the card is due for closure.
      assert.equal(
        card.closureSuggestionCode !== null,
        card.closureDue,
        `${card.id}: suggestion presence must match closureDue`,
      );
      if (card.closureSuggestionCode !== null) {
        assert.ok(
          SUGGESTION_KEYS[card.closureSuggestionCode],
          `${card.id}: suggestion code ${card.closureSuggestionCode} has no suggestion-side i18n key`,
        );
        assert.equal(
          card.closureSuggestion,
          RENDER(card.closureSuggestionCode, card.closureSuggestionParams),
          `${card.id}: the diagnostic string must be derived from code+args, never written twice`,
        );
      } else {
        assert.equal(card.closureSuggestion, '', `${card.id}: no due -> no suggestion text`);
      }
    }

    // The suggestion is a pure function of the structured fact.
    const due = cardById(board, 'seed-task-14');
    assert.equal(due.closureDue, true);
    assert.equal(due.closureSuggestionCode, 'stale_inactivity');
    assert.equal(typeof due.closureSuggestionParams.days, 'number');
    assert.match(due.closureSuggestion, /day\(s\)/);

    const clean = cardById(board, 'seed-task-05');
    assert.equal(clean.closureDue, false);
    assert.equal(clean.closureSuggestionCode, null);
    assert.equal(clean.closureSuggestion, '');

    // Terminal without a conclusion is the most actionable fact.
    const terminal = cardById(board, 'seed-task-18');
    assert.equal(terminal.closureSuggestionCode, 'terminal_no_conclusion');

    // Every code the derivation can emit is registered.
    const emitted = new Set(
      board.listCards({ scope: 'all' }).cards.flatMap((card) => [
        ...card.reasonCodes.map((fact) => fact.code),
        ...(card.closureSuggestionCode ? [card.closureSuggestionCode] : []),
      ]),
    );
    assert.ok(emitted.size > 0);
    for (const code of emitted) {
      assert.ok(
        REASON_KEYS[code] || SUGGESTION_KEYS[code],
        `unregistered code ${code} on both sides`,
      );
    }

    // The reason codes are a real projection of the same rows, not decoration.
    const withSessions = cardById(board, 'seed-task-23');
    assert.ok(withSessions.reasonCodes.some((fact) => fact.code === 'deliverables_verifiable'));
    assert.ok(withSessions.reasonCodes.some((fact) => fact.code === 'linked_sessions'));
    assert.equal(orchestrationStore.getTask('seed-task-23').status, 'running');
  } finally {
    sqliteStore.close();
  }
});

test('the terminal-no-conclusion fact can never exist in only one of its two homes (A-6/appendix B)', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    // loop registered the reason code (`terminal_without_conclusion`) and the
    // suggestion code (`terminal_no_conclusion`) as deliberately different
    // names for one fact. Two names for one fact may not silently diverge, so
    // their co-occurrence is pinned here.
    for (const card of board.listCards({ scope: 'all' }).cards) {
      const hasReason = card.reasonCodes.some((fact) => fact.code === 'terminal_without_conclusion');
      if (!hasReason) continue;
      assert.equal(
        card.closureSuggestionCode,
        'terminal_no_conclusion',
        `${card.id}: the terminal-no-conclusion reason fired without its suggestion`,
      );
    }
    const terminal = cardById(board, 'seed-task-18');
    assert.ok(terminal.reasonCodes.some((fact) => fact.code === 'terminal_without_conclusion'));
    assert.equal(terminal.closureSuggestionCode, 'terminal_no_conclusion');
  } finally {
    sqliteStore.close();
  }
});

test('the key table is per (side, code): 10 + 5 = 15, not per code (E-6)', async () => {
  const mod = await import('../dist-electron/main/services/trackedTaskBoard.js');
  const { TRACKED_REASON_I18N_KEY: REASON, TRACKED_SUGGESTION_I18N_KEY: SUGGESTION } = mod;

  assert.equal(Object.keys(REASON).length, 10, 'reason side has 10 key slots');
  assert.equal(Object.keys(SUGGESTION).length, 5, 'suggestion side has 5 key slots');
  assert.equal(new Set(Object.values(REASON)).size, 10, 'reason keys are distinct');
  assert.equal(new Set(Object.values(SUGGESTION)).size, 5, 'suggestion keys are distinct');

  const all = [...Object.values(REASON), ...Object.values(SUGGESTION)];
  assert.equal(new Set(all).size, 15, 'the renderer needs 15 distinct keys');
  for (const key of Object.values(REASON)) assert.match(key, /^trackedTask\.reason\./);
  for (const key of Object.values(SUGGESTION)) assert.match(key, /^trackedTask\.suggestion\./);

  // E-6: one code, two sides, two DIFFERENT keys. A per-code map cannot express
  // this, which is why the per-code index is not the renderer's key table.
  assert.equal(REASON.deliverables_verifiable, 'trackedTask.reason.deliverablesVerifiable');
  assert.equal(SUGGESTION.deliverables_verifiable, 'trackedTask.suggestion.deliverablesVerifiable');
  assert.notEqual(REASON.deliverables_verifiable, SUGGESTION.deliverables_verifiable);

  // The exact cross-end roster the renderer must provide (zh + en each).
  const expected = [
    'trackedTask.reason.attemptsOpen',
    'trackedTask.reason.blockedUnmetDependencies',
    'trackedTask.reason.deliverablesVerifiable',
    'trackedTask.reason.idleDays',
    'trackedTask.reason.ledgerReview',
    'trackedTask.reason.linkedSessions',
    'trackedTask.reason.openCheckpoints',
    'trackedTask.reason.stepsActive',
    'trackedTask.reason.stepsWaitingInput',
    'trackedTask.reason.terminalWithoutConclusion',
    'trackedTask.suggestion.deliverablesVerifiable',
    'trackedTask.suggestion.sessionEnded',
    'trackedTask.suggestion.staleInactivity',
    'trackedTask.suggestion.terminalNoConclusion',
    'trackedTask.suggestion.unresolvedDependencies',
  ].sort();
  assert.deepEqual([...new Set(all)].sort(), expected);
});

test('the terminal fact pair holds in BOTH directions (R-3 second direction)', async () => {
  const { sqliteStore, board, orchestrationStore } = await openBoard();
  try {
    for (const card of board.listCards({ scope: 'all' }).cards) {
      const hasReason = card.reasonCodes.some((fact) => fact.code === 'terminal_without_conclusion');
      // Direction 1: the reason implies its suggestion.
      if (hasReason) {
        assert.equal(
          card.closureSuggestionCode,
          'terminal_no_conclusion',
          `${card.id}: direction 1 broken — the terminal reason fired without its suggestion`,
        );
      }
      // Direction 2: the suggestion implies its reason. Separate assertion on
      // purpose, so a failure names WHICH direction broke. This relies on the
      // trigger fact being first in the reason order, because only the first
      // five lines survive the payload truncation.
      if (card.closureSuggestionCode === 'terminal_no_conclusion') {
        assert.ok(
          hasReason,
          `${card.id}: direction 2 broken — the terminal suggestion fired without its reason `
          + `(reasonOverflow=${card.reasonOverflow}, codes=${card.reasonCodes.map((f) => f.code).join(',')})`,
        );
      }
    }

    // Positive control for direction 2: a card that MUST satisfy it.
    const terminal = cardById(board, 'seed-task-18');
    assert.equal(terminal.closureSuggestionCode, 'terminal_no_conclusion');
    assert.ok(terminal.reasonCodes.some((fact) => fact.code === 'terminal_without_conclusion'));
    assert.equal(orchestrationStore.getTask('seed-task-18').status, 'failed');
  } finally {
    sqliteStore.close();
  }
});

test('the terminal reason survives the five-line truncation (ordering guarantee)', async () => {
  const mod = await import('../dist-electron/main/services/trackedTaskBoard.js');
  const { deriveCardState } = mod;

  // A deliberately crowded card: eight candidate reason lines plus a terminal
  // status without a conclusion. Only five survive the payload truncation, so
  // the trigger fact must be ordered first or direction 2 of the pair breaks.
  const nowMs = Date.parse('2026-09-17T06:00:00.000Z');
  const task = {
    id: 'crowded', ownerIntent: 'crowded', enrichedGoal: null, acceptanceCriteria: [],
    sourceSessionId: null, twinMetabotId: 1, ownerGlobalMetaId: 'owner',
    status: 'failed', planVersion: 1,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-14T06:00:00.000Z', completedAt: null,
  };
  const step = (id, status, deps = []) => ({
    id, taskId: 'crowded', ordinal: 1, title: id, objective: '', acceptanceCriteria: [],
    dependencyStepIds: deps, assigneeMetabotId: null, permissionScope: {}, deadlineAt: null,
    status, acceptedResult: null, activeAttemptId: null,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-14T06:00:00.000Z',
  });
  const derived = deriveCardState({
    task,
    steps: [step('s1', 'waiting_input'), step('s2', 'blocked', ['s3']), step('s3', 'running')],
    attempts: [{
      id: 'a1', stepId: 's3', idempotencyKey: 'a1', workerMetabotId: 2, workerSessionId: null,
      status: 'queued', prompt: '', result: null, error: null,
      queuedAt: '2026-09-14T06:00:00.000Z', startedAt: null, finishedAt: null,
    }],
    openCheckpointCount: 1,
    verifiableDeliverableCount: 2,
    closureConclusion: null,
    admitted: true,
    scheduled: null,
    sessionStatuses: ['idle'],
    activityAtMs: [Date.parse('2026-09-14T06:00:00.000Z')],
    nowMs,
  });

  assert.equal(derived.closureSuggestionCode, 'terminal_no_conclusion');
  assert.ok(derived.reasonOverflow > 0, 'this card must actually truncate, or the test proves nothing');
  assert.equal(
    derived.reasonCodes[0].code,
    'terminal_without_conclusion',
    'the closure trigger must be the first reason line, not a truncated-away one',
  );
  assert.ok(derived.reasonCodes.some((fact) => fact.code === 'terminal_without_conclusion'));
});

// ==================== v1.1: admission, archive, migration ====================

/**
 * Admission expectations per seeded case. `wide` is the default; `strict` is
 * the same rows read through `tracked_admission_mode=strict` (ADM-1 ∨ ADM-3).
 */
const ADMISSION_EXPECTATIONS = {
  'seed-task-28': { wide: { admitted: false, matched: [] }, strict: { admitted: false, matched: [] } },
  'seed-task-29': { wide: { admitted: true, matched: ['ADM-1'] }, strict: { admitted: true, matched: ['ADM-1'] } },
  'seed-task-30': { wide: { admitted: true, matched: ['ADM-2'] }, strict: { admitted: false, matched: [] } },
  'seed-task-31': { wide: { admitted: true, matched: ['ADM-3'] }, strict: { admitted: true, matched: ['ADM-3'] } },
  'seed-task-32': { wide: { admitted: true, matched: ['ADM-3'] }, strict: { admitted: true, matched: ['ADM-3'] } },
  'seed-task-33': { wide: { admitted: true, matched: ['ADM-4'] }, strict: { admitted: false, matched: [] } },
  'seed-task-34': { wide: { admitted: true, matched: ['ADM-3', 'ADM-4'] }, strict: { admitted: true, matched: ['ADM-3'] } },
  'seed-task-35': { wide: { admitted: true, matched: ['ADM-3', 'ADM-5'] }, strict: { admitted: true, matched: ['ADM-3'] } },
  'seed-task-36': { wide: { admitted: false, matched: [] }, strict: { admitted: false, matched: [] } },
  'seed-task-37': { wide: { admitted: true, matched: ['ADM-2'] }, strict: { admitted: false, matched: [] } },
};

/** Every row the board could write; used to prove a read path wrote nothing. */
function ledgerDump(db) {
  const tables = ['orchestration_tasks', 'orchestration_steps', 'group_tasks', 'scheduled_tasks', 'kv'];
  return tables
    .map((table) => {
      const result = db.exec(`SELECT * FROM ${table} ORDER BY 1`);
      const columns = result[0]?.columns ?? [];
      const rows = (result[0]?.values ?? []).map((values) => values.join('\u0001'));
      return `${table}:${columns.join(',')}\n${rows.join('\n')}`;
    })
    .join('\n---\n');
}

test('admission is exactly the five declared rules, in both modes', async () => {
  const { sqliteStore, board, manifest } = await openBoard();
  try {
    const read = (scope) => new Map(board.listCards({ scope }).cards.map((card) => [card.id, card]));

    const wide = { ...Object.fromEntries(read('all')), ...Object.fromEntries(read('archived')) };
    for (const [id, expectation] of Object.entries(ADMISSION_EXPECTATIONS)) {
      const card = wide[id];
      assert.ok(card, `${id}: card missing from both board and archive`);
      assert.equal(card.admitted, expectation.wide.admitted, `${id}: admitted under wide`);
      assert.deepEqual(card.admissionMatched, expectation.wide.matched, `${id}: matched rules under wide`);
      assert.ok(manifest.registeredTaskIds.includes(id) === (expectation.wide.matched[0] === 'ADM-1'), `${id}: fixture registration`);
    }

    // v1's own corpus stays on the board: the fixture registers it (ADM-1).
    assert.ok(manifest.registeredTaskIds.includes('seed-task-14'));
    assert.equal(wide['seed-task-14'].admitted, true);
    assert.deepEqual(wide['seed-task-14'].admissionMatched, ['ADM-1']);
  } finally {
    sqliteStore.close();
  }
});

test('the wide/strict switch changes the verdict and writes nothing at all', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    const db = sqliteStore.getDatabase();
    assert.equal(board.getAdmissionMode(), 'wide', 'the default mode is wide');
    const ledgerBefore = db.exec('SELECT * FROM orchestration_tasks ORDER BY id')[0].values;
    const kvBefore = Object.fromEntries(
      db.exec('SELECT key, value FROM kv')[0].values.map(([key, value]) => [String(key), String(value)]),
    );

    assert.equal(board.setAdmissionMode('strict'), 'strict');
    assert.equal(board.getAdmissionMode(), 'strict');
    // The switch is one kv row; the ledger itself must be byte-identical.
    const strictCards = Object.fromEntries(
      [...board.listCards({ scope: 'all' }).cards, ...board.listCards({ scope: 'archived' }).cards]
        .map((card) => [card.id, card]),
    );
    for (const [id, expectation] of Object.entries(ADMISSION_EXPECTATIONS)) {
      assert.equal(strictCards[id].admitted, expectation.strict.admitted, `${id}: admitted under strict`);
      assert.deepEqual(strictCards[id].admissionMatched, expectation.strict.matched, `${id}: matched under strict`);
    }

    // Anything unrecognised falls back to wide rather than throwing.
    assert.equal(board.setAdmissionMode('nonsense'), 'wide');
    assert.equal(board.getAdmissionMode(), 'wide');
    board.setAdmissionMode('strict');

    // Compare the ledger and the registry cell by cell: a mode switch is one kv
    // value and nothing else.
    assert.deepEqual(
      db.exec('SELECT * FROM orchestration_tasks ORDER BY id')[0].values,
      ledgerBefore,
      'the mode switch must not touch a single ledger row',
    );
    const kvAfter = Object.fromEntries(
      db.exec('SELECT key, value FROM kv')[0].values.map(([key, value]) => [String(key), String(value)]),
    );
    assert.deepEqual(
      Object.keys(kvAfter).filter((key) => !(key in kvBefore)),
      ['tracked_admission_mode'],
      'the mode key is the only kv row the switch may create',
    );
    assert.deepEqual(Object.keys(kvBefore).filter((key) => !(key in kvAfter)), [], 'no kv key may disappear');
    for (const key of Object.keys(kvBefore)) {
      if (key === 'tracked_admission_mode') continue;
      assert.equal(kvAfter[key], kvBefore[key], `kv.${key} must survive a mode switch untouched`);
    }
    assert.equal(kvAfter.tracked_admission_mode, 'strict');
  } finally {
    sqliteStore.close();
  }
});

test('the archive is a read-time projection: nothing is written, moved or deleted', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    const db = sqliteStore.getDatabase();
    const before = ledgerDump(db);

    const all = board.listCards({ scope: 'all' });
    const archived = board.listCards({ scope: 'archived' });
    const scoped = board.listCards();

    assert.equal(all.counts.admitted + all.counts.archived, all.counts.total, 'admitted + archived = total');
    assert.equal(archived.cards.length, archived.counts.archived, 'the archive scope returns exactly ¬admitted');
    assert.equal(all.counts.archived > 0, true, 'the fixture must actually seed archived rows, or this proves nothing');

    const boardIds = new Set(all.cards.map((card) => card.id));
    const archivedIds = new Set(archived.cards.map((card) => card.id));
    assert.equal([...boardIds].some((id) => archivedIds.has(id)), false, 'the two populations must be disjoint');
    assert.equal(boardIds.size + archivedIds.size, all.counts.total, 'their union must be the whole ledger');

    // Nobody can be closureDue and archived at the same time, at any scope.
    for (const card of archived.cards) {
      assert.equal(card.closureDue, false, `${card.id}: archived row is due for closure`);
      assert.equal(card.closureSuggestionCode, null, `${card.id}: archived row carries a suggestion`);
    }
    assert.equal(archived.counts.closureDue, 0);
    assert.equal(scoped.counts.closureDue, all.counts.closureDue, 'closureDue cards are never folded or archived');

    // Deep links keep working for archived rows (freeze doc §6: 保留可查).
    const archivedId = archived.cards[0].id;
    const detail = board.getCard(archivedId);
    assert.ok(detail, 'getCard must not filter by admission');
    assert.equal(detail.admitted, false);
    assert.ok(detail.steps.length >= 0 && detail.owner.ownerGlobalMetaId.length > 0);

    assert.equal(ledgerDump(db), before, 'reading the board (all three scopes + a detail) must write nothing');
  } finally {
    sqliteStore.close();
  }
});

test('sessions_ended is a hint for archived rows and a trigger only for admitted ones', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    const db = sqliteStore.getDatabase();
    const nowIso = new Date(Date.now() - 5 * 60_000).toISOString();
    db.run(
      `INSERT INTO orchestration_tasks
         (id, owner_intent, enriched_goal, acceptance_criteria_json, source_session_id, twin_metabot_id,
          owner_global_meta_id, status, plan_version, created_at, updated_at, completed_at)
       VALUES ('probe-task-01', 'probe', NULL, '[]', 'probe-session-01', 1,
               'idq1t3lzq0q4rec8edujklp4w8hfmgceqxth82a7m9', 'running', 1, ?, ?, NULL)`,
      [nowIso, nowIso],
    );
    db.run(
      `INSERT INTO cowork_sessions
         (id, title, claude_session_id, status, pinned, cwd, system_prompt, execution_mode,
          hidden_from_session_list, project_id, created_at, updated_at, session_type)
       VALUES ('probe-session-01', 'probe', NULL, 'idle', 0, '/tmp/probe', '', 'auto', 0, NULL, ?, ?, 'standard')`,
      [nowIso, nowIso],
    );

    // Unregistered, no steps, no group/scheduled link: archived. Its only linked
    // session is idle, yet nothing may queue.
    const probe = (scope) => board.listCards({ scope }).cards.find((card) => card.id === 'probe-task-01');
    const archivedCard = probe('archived');
    assert.ok(archivedCard, 'the probe row must be archived');
    assert.equal(archivedCard.closureDue, false, 'sessions_ended alone must not queue an unadmitted card');
    assert.equal(archivedCard.closureSuggestionCode, null);
    assert.equal(archivedCard.closureDueLevel, null);
    // ...but the fact is still reported in the drawer as a hint (§5).
    assert.ok(
      archivedCard.reasonCodes.some((fact) => fact.code === 'linked_sessions'),
      'the linked-session hint must survive the downgrade',
    );

    // Register it (ADM-1): the very same row is now queued by sessions_ended.
    assert.equal(board.registerLongTask('probe-task-01').ok, true);
    const admittedCard = probe('all');
    assert.ok(admittedCard, 'a registered row must be on the board');
    assert.equal(admittedCard.closureDue, true);
    assert.equal(admittedCard.closureDueLevel, 'sessions_ended');
    assert.equal(admittedCard.closureSuggestionCode, 'session_ended');
    const byLevel = (level) => board.listCards({ scope: 'all' }).cards
      .filter((card) => card.closureDueLevel === level)
      .map((card) => card.id);
    assert.equal(board.listCards({ scope: 'all' }).counts.sessionsEndedLevel, byLevel('sessions_ended').length);
    assert.ok(byLevel('sessions_ended').includes('probe-task-01'));

    // Registration is idempotent, and unregistering puts the row back in the
    // archive without deleting anything.
    assert.deepEqual(board.registerLongTask('probe-task-01').registered.filter((id) => id === 'probe-task-01').length, 1);
    const registered = board.unregisterLongTask('probe-task-01');
    assert.equal(registered.ok, true);
    assert.equal(registered.registered.includes('probe-task-01'), false);
    assert.ok(probe('archived'), 'unregistered rows return to the archive');
    assert.equal(probe('all'), undefined);
  } finally {
    sqliteStore.close();
  }
});

test('a malformed registry reads as an empty set and never blocks the board', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    const db = sqliteStore.getDatabase();
    const admittedBefore = board.listCards({ scope: 'all' }).counts.admitted;
    const registryValue = String(
      db.exec("SELECT value FROM kv WHERE key = 'tracked_long_task_registry'")[0].values[0][0],
    );

    db.run("UPDATE kv SET value = 'not json at all' WHERE key = 'tracked_long_task_registry'");
    assert.deepEqual(board.listRegisteredLongTaskIds(), []);
    const broken = board.listCards({ scope: 'all' });
    const brokenCards = Object.fromEntries(
      [...broken.cards, ...board.listCards({ scope: 'archived' }).cards].map((card) => [card.id, card]),
    );
    // Losing ADM-1 must not throw and must not guess: exactly the rows that had
    // no structural branch fall to the archive, the rest are untouched.
    assert.ok(broken.counts.admitted > 0, 'structural branches must still admit');
    assert.ok(broken.counts.admitted < admittedBefore, 'dropping ADM-1 must shrink the board');
    assert.equal(brokenCards['seed-task-29'].admitted, false, 'an ADM-1-only row falls to the archive');
    assert.equal(brokenCards['seed-task-30'].admitted, true, 'an ADM-2-only row is unaffected');
    assert.equal(broken.counts.admitted + broken.counts.archived, broken.counts.total);

    db.run("UPDATE kv SET value = '{\"a\":1}' WHERE key = 'tracked_long_task_registry'");
    assert.deepEqual(board.listRegisteredLongTaskIds(), [], 'a JSON object is not a registry');

    // Positive control: a valid registry brings the very same rows back.
    db.run('UPDATE kv SET value = ? WHERE key = ?', [registryValue, 'tracked_long_task_registry']);
    assert.equal(board.listCards({ scope: 'all' }).counts.admitted, admittedBefore);
  } finally {
    sqliteStore.close();
  }
});

test('the startup backfill closes pre-upgrade terminal rows once, and only those', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-tracked-backfill-'));
  const legacy = [
    ['legacy-a', 'completed', null],
    ['legacy-b', 'failed', null],
    ['legacy-c', 'cancelled', '   '],
    ['legacy-d', 'completed', 'owner already closed this one'],
    ['legacy-e', 'running', null],
  ];
  const insertLegacy = (db, id, status, conclusion) => db.run(
    `INSERT INTO orchestration_tasks
       (id, owner_intent, enriched_goal, acceptance_criteria_json, source_session_id, twin_metabot_id,
        owner_global_meta_id, status, plan_version, created_at, updated_at, completed_at,
        closure_conclusion, closure_by, closure_at, closure_pin_id)
     VALUES (?, ?, NULL, '[]', NULL, 1, 'idq1t3lzq0q4rec8edujklp4w8hfmgceqxth82a7m9', ?, 1, ?, ?, NULL, ?, ?, NULL, NULL)`,
    [id, `legacy ${id}`, status, '2026-09-01T00:00:00.000Z', '2026-09-10T00:00:00.000Z',
      conclusion, conclusion ? 'owner' : null],
  );
  const rows = (db, sql) => db.exec(sql)[0].values.map((values) => values.join('\u0001'));

  const store = await SqliteStore.create(dir);
  let result;
  try {
    const db = store.getDatabase();
    for (const [id, status, conclusion] of legacy) insertLegacy(db, id, status, conclusion);
    const updatedBefore = rows(db, 'SELECT id, updated_at FROM orchestration_tasks ORDER BY id');

    result = store.migrateTrackedTaskClosureBackfill();
    assert.deepEqual(
      {
        scanned: result.scanned,
        backfilled: result.backfilled,
        skippedAlreadyConcluded: result.skippedAlreadyConcluded,
        skippedNonTerminal: result.skippedNonTerminal,
      },
      { scanned: 3, backfilled: 3, skippedAlreadyConcluded: 1, skippedNonTerminal: 1 },
    );

    // (a) the activity anchor must not move, or zombie/scope semantics shift.
    assert.deepEqual(
      rows(db, 'SELECT id, updated_at FROM orchestration_tasks ORDER BY id'),
      updatedBefore,
      'the backfill must never write updated_at',
    );
    // (b) status is untouched; only the four closure columns are written.
    assert.deepEqual(
      rows(db, 'SELECT id, status FROM orchestration_tasks ORDER BY id'),
      [['legacy-a', 'completed'], ['legacy-b', 'failed'], ['legacy-c', 'cancelled'],
        ['legacy-d', 'completed'], ['legacy-e', 'running']].map((pair) => pair.join('\u0001')),
      'the backfill must never write status',
    );
    for (const id of ['legacy-a', 'legacy-b', 'legacy-c']) {
      const [conclusion, by, at, pin] = db.exec(
        'SELECT closure_conclusion, closure_by, closure_at, closure_pin_id FROM orchestration_tasks WHERE id = ?',
        [id],
      )[0].values[0];
      assert.match(String(conclusion), /^系统迁移：/, `${id}: the conclusion must state its provenance`);
      assert.equal(by, 'system_backfill', `${id}: closure_by`);
      assert.equal(at, result.snapshotAt, `${id}: closure_at is the migration instant`);
      assert.equal(pin, null, `${id}: no pin is fabricated`);
    }
    // (c) an existing conclusion is never overwritten.
    assert.equal(
      db.exec("SELECT closure_conclusion FROM orchestration_tasks WHERE id = 'legacy-d'")[0].values[0][0],
      'owner already closed this one',
    );
    assert.equal(
      db.exec("SELECT closure_by FROM orchestration_tasks WHERE id = 'legacy-d'")[0].values[0][0],
      'owner',
    );

    // (d) re-entrant: the second run matches nothing.
    const second = store.migrateTrackedTaskClosureBackfill();
    assert.equal(second.backfilled, 0, 'the migration must be idempotent');
    assert.equal(second.scanned, 0, 'nothing is left in the target set');
  } finally {
    store.close();
  }

  // The upgrade path: reopening the SAME directory runs the migration again in
  // ensureSchema, so an upgraded user must never see these 88-shaped rows as
  // "terminal without a conclusion".
  const reopened = await SqliteStore.create(dir);
  try {
    const db = reopened.getDatabase();
    const third = reopened.migrateTrackedTaskClosureBackfill();
    assert.equal(third.backfilled, 0, 'the reopen path must not re-close anything');

    // `cowork_sessions.session_type` is added by coworkStore's own idempotent
    // migration in production; this test boots the store alone, so it applies
    // the same guarded ALTER the fixture does.
    const sessionColumns = db.exec('PRAGMA table_info(cowork_sessions)')[0].values.map((row) => row[1]);
    if (!sessionColumns.includes('session_type')) {
      db.run("ALTER TABLE cowork_sessions ADD COLUMN session_type TEXT NOT NULL DEFAULT 'standard'");
    }

    const orchestrationStore = new OrchestrationStore(db, reopened.getSaveFunction());
    const board = new TrackedTaskBoardService({
      db,
      orchestrationStore,
      saveDb: reopened.getSaveFunction(),
    });
    // Positive control FIRST: a terminal row written AFTER the migration (i.e. a
    // genuinely new post-upgrade failure) must still raise the false-positive
    // signal — otherwise "terminalNoConclusionLevel === 0" proves nothing.
    insertLegacy(db, 'legacy-new', 'failed', null);
    board.registerLongTask('legacy-new');
    assert.equal(board.listCards({ scope: 'all' }).counts.terminalNoConclusionLevel, 1,
      'a post-migration terminal row must still be flagged');

    board.unregisterLongTask('legacy-new');
    for (const id of ['legacy-a', 'legacy-b', 'legacy-c', 'legacy-d']) board.registerLongTask(id);
    const counts = board.listCards({ scope: 'all' }).counts;
    assert.equal(counts.terminalNoConclusionLevel, 0, 'the migrated rows are closed, not flagged');
    assert.equal(counts.closureDue, 0, 'the four migrated rows raise no closure request at all');
    const legacyCard = board.listCards({ scope: 'all' }).cards.find((card) => card.id === 'legacy-a');
    assert.equal(legacyCard.state, 'closed');
    assert.match(String(legacyCard.closureConclusion), /^系统迁移：/);
  } finally {
    reopened.close();
  }
});

test('scope is a real three-value axis and an unknown scope is never silently default (H6)', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    const archived = board.listCards({ scope: 'archived' });
    assert.equal(archived.scopeApplied, 'archived', 'H6: archived must be a REAL scope, not a default fallback');
    assert.equal(archived.scopeRequested, 'archived');
    assert.equal(archived.scopeFallback, false);

    // The archived view is exactly ¬admitted, and it is not the default view.
    const admittedIds = new Set(board.listCards({ scope: 'all' }).cards.map((card) => card.id));
    assert.ok(archived.cards.length > 0, 'the fixture must seed archived rows or this proves nothing');
    assert.equal(
      archived.cards.every((card) => card.admitted === false),
      true,
      'every archived row must be unadmitted',
    );
    assert.equal(archived.cards.some((card) => admittedIds.has(card.id)), false);
    assert.notDeepEqual(
      archived.cards.map((card) => card.id).sort(),
      board.listCards().cards.map((card) => card.id).sort(),
      'the archived view must not be the default view',
    );

    const omitted = board.listCards();
    assert.equal(omitted.scopeRequested, null, 'an omitted scope is documented, not a fallback');
    assert.equal(omitted.scopeApplied, 'default');
    assert.equal(omitted.scopeFallback, false);

    // An unrecognised value is reported, never quietly answered with `default`.
    const bogus = board.listCards({ scope: 'nonsense' });
    assert.equal(bogus.scopeRequested, 'nonsense');
    assert.equal(bogus.scopeFallback, true, 'an unknown scope must be flagged, not silently reshaped');
    assert.equal(bogus.scopeApplied, 'default');

    for (const scope of ['default', 'all', 'archived']) {
      assert.equal(board.listCards({ scope }).scopeFallback, false, `${scope} must be recognised`);
    }
  } finally {
    sqliteStore.close();
  }
});

test('the two v1.1 UI entries are wired end to end (archive read-only, reversible mode switch)', async () => {
  const fs = await import('node:fs');
  const read = (relative) => fs.readFileSync(relative, 'utf8');

  // 1) Archive entry: a real scope, rendered through the READ-ONLY list.
  const section = read('src/renderer/components/trackedTasks/TrackedTasksSection.tsx');
  assert.match(section, /scope: 'archived'/, 'the archive view must request the archived scope');
  assert.match(section, /viewMode === 'archive'/, 'the archive view must be a rendered branch');
  assert.match(section, /emptyTextKey="trackedTask\.archive\.empty"/);
  assert.match(section, /readOnly\b/, 'the archive list must be rendered read-only');

  // The read-only flag is what removes the closing action — assert BOTH halves
  // (header cell and row cell), a single occurrence would leave the column behind.
  const list = read('src/renderer/components/trackedTasks/TrackedTasksList.tsx');
  assert.equal(
    (list.match(/\{!readOnly && \(/g) ?? []).length,
    2,
    'readOnly must gate the action column header AND the per-row action',
  );

  // 2) Mode switch: reachable from Settings and carried over IPC.
  const settings = read('src/renderer/components/Settings.tsx');
  assert.match(settings, /case 'trackedTask':/);
  assert.match(settings, /key: 'trackedTask'/);
  const pane = read('src/renderer/components/settings/TrackedTaskSettings.tsx');
  assert.match(pane, /setAdmissionMode/);
  assert.match(pane, /\['wide', 'strict'\]/);
  for (const file of ['src/main/main.ts', 'src/main/preload.ts']) {
    const source = read(file);
    assert.match(source, /trackedTask:admissionMode/, `${file}: read channel missing`);
    assert.match(source, /trackedTask:setAdmissionMode/, `${file}: write channel missing`);
  }

  // 3) Every new key exists in BOTH languages: exactly two occurrences each.
  const i18n = read('src/renderer/services/i18n.ts');
  const keys = [
    'trackedTask.view.archive',
    'trackedTask.archive.title',
    'trackedTask.archive.readOnly',
    'trackedTask.archive.hint',
    'trackedTask.archive.empty',
    'trackedTask.admission.title',
    'trackedTask.admission.hint',
    'trackedTask.admission.modeWide',
    'trackedTask.admission.modeStrict',
    'trackedTask.admission.reversible',
    'trackedTask.admission.activeRules',
    'trackedTask.admission.notAdmitted',
    'trackedTask.admission.adm1',
    'trackedTask.admission.adm2',
    'trackedTask.admission.adm3',
    'trackedTask.admission.adm4',
    'trackedTask.admission.adm5',
    'trackedTaskSettingsTitle',
  ];
  const countKey = (key) => (i18n.match(
    new RegExp(`(['"]${key.replace(/\./g, '\\.')}['"]\\s*:|\\b${key.replace(/\./g, '\\.')}\\s*:)`, 'g'),
  ) ?? []).length;
  // Positive control FIRST: prove the counter can see absence, otherwise a
  // "everything is 2" pass could just be a counter stuck at 2.
  assert.equal(countKey('trackedTask.thisKeyDoesNotExist'), 0, 'the key counter must be able to see 0');
  for (const key of keys) {
    assert.equal(countKey(key), 2, `${key}: expected the key in exactly EN + ZH, saw ${countKey(key)}`);
  }
});

test('a missing `admitted` input cannot produce a non-boolean closureDue (F-A)', async () => {
  const mod = await import('../dist-electron/main/services/trackedTaskBoard.js');
  const { deriveCardState } = mod;

  const nowMs = Date.parse('2026-09-17T06:00:00.000Z');
  const task = {
    id: 'no-admission', ownerIntent: 'x', enrichedGoal: null, acceptanceCriteria: [],
    sourceSessionId: null, twinMetabotId: 1, ownerGlobalMetaId: 'owner',
    status: 'failed', planVersion: 1,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-14T06:00:00.000Z', completedAt: null,
  };
  const base = {
    task,
    steps: [],
    attempts: [],
    openCheckpointCount: 0,
    verifiableDeliverableCount: 0,
    closureConclusion: null,
    scheduled: null,
    sessionStatuses: ['idle'],
    activityAtMs: [Date.parse('2026-09-14T06:00:00.000Z')],
    nowMs,
  };

  // Positive control first: WITH the input the gate is open, so the assertion
  // below is about the missing-argument case and not about a dead code path.
  const admitted = deriveCardState({ ...base, admitted: true });
  assert.equal(admitted.closureDue, true, 'an admitted terminal row must be due for closure');

  const omitted = deriveCardState(base);
  assert.equal(omitted.closureDue, false, 'a missing `admitted` must fail closed to a real boolean');
  assert.equal(typeof omitted.closureDue, 'boolean', 'closureDue must never be undefined');
  assert.equal(omitted.closureDueLevel, null);
  assert.equal(omitted.closureSuggestionCode, null);
  // The miss is reported, not swallowed (chair ruling §14.2): a silent
  // fail-closed is how a bypassing caller stops queueing anything unnoticed.
  assert.equal(omitted.admissionInputMissing, true, 'a missing input must be visible');
  assert.equal(admitted.admissionInputMissing, false, 'the normal path must report no miss');

  // And the board surfaces it as a count that is 0 on the normal path.
  const { sqliteStore, board } = await openBoard();
  try {
    const counts = board.listCards({ scope: 'all' }).counts;
    assert.equal(counts.admissionInputMissing, 0, 'the shipped board must never miss the input');
    assert.equal(
      typeof counts.admissionInputMissing,
      'number',
      'the counter must be exposed unconditionally, not only when non-zero',
    );
  } finally {
    sqliteStore.close();
  }
});
