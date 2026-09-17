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
  const card = board.listCards().cards.find((candidate) => candidate.id === id);
  assert.ok(card, `card ${id} missing from the board`);
  return card;
}

test('every seeded case lands in the column the shared fixture declares', async () => {
  const { sqliteStore, board, manifest } = await openBoard();
  try {
    const cards = new Map(board.listCards().cards.map((card) => [card.id, card]));
    for (const testCase of manifest.cases) {
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
    const result = board.listCards();
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

test('an illegal ledger transition is refused, not forced', async () => {
  const { sqliteStore, board, orchestrationStore } = await openBoard();
  try {
    // failed -> completed is NOT in the ledger's whitelist.
    const refused = board.closeCard({
      taskId: 'seed-task-18',
      conclusion: 'attempt to force a completed status',
      by: 'owner',
      targetStatus: 'completed',
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'TRANSITION_NOT_ALLOWED');
    assert.equal(orchestrationStore.getTask('seed-task-18').status, 'failed', 'status must be untouched');

    // failed -> cancelled IS whitelisted.
    const cancelled = board.closeCard({
      taskId: 'seed-task-18',
      conclusion: 'abandoned after the failure',
      by: 'owner',
      targetStatus: 'cancelled',
    });
    assert.equal(cancelled.ok, true, cancelled.error);
    assert.equal(cancelled.card.state, 'closed');
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
    const first = board.listCards();
    const again = second.listCards();
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
    assert.deepEqual(detail.deliverables.map((item) => item.status), ['delivered']);
    assert.ok(detail.sessions.some((link) => link.sessionId === 'group-task:8303'));
  } finally {
    sqliteStore.close();
  }
});
