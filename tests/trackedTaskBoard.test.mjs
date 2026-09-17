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
    for (const testCase of manifest.cases) {
      if (!testCase.orchestrationTaskId) continue; // e.g. the independent-session case
      const card = cards.get(testCase.orchestrationTaskId);
      assert.ok(card, `${testCase.id}: card ${testCase.orchestrationTaskId} missing`);
      assert.equal(card.state, COLUMN_TO_STATE[testCase.boardColumn], `${testCase.id}: ${testCase.title}`);
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
    assert.equal(scoped.counts.visible + scoped.counts.folded, scoped.counts.total);

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
    assert.ok(kvKeys.some((row) => String(row[0]) === 'tracking_tick_beat'), 'the beat key must exist');
    assert.ok(
      kvKeys.every((row) => !/seed-task-|seed-step-|seed-attempt-/.test(String(row[1]))),
      'kv must never carry a card-level value',
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
        assert.equal(typeof fact.args, 'object', `${card.id}[${index}]: args missing`);
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
          RENDER(card.closureSuggestionCode, card.closureSuggestionArgs),
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
    assert.equal(typeof due.closureSuggestionArgs.days, 'number');
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
