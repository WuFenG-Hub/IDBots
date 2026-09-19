import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { OrchestrationStore } = require('../dist-electron/main/orchestrationStore.js');
const { TrackedTaskBoardService, trackedDeliverableKind } = require('../dist-electron/main/services/trackedTaskBoard.js');

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

/**
 * The `[SEC-09]` tie rule: inside one actionRank, activity descends — the card
 * that moved most recently leads — and equal activity falls back to id
 * ascending. `activityAtMs === null` means "unknown activity" and must land
 * last, never silently on top.
 */
function assertNewestFirst(cards, label) {
  for (let index = 1; index < cards.length; index += 1) {
    const previous = cards[index - 1];
    const current = cards[index];
    if (previous.actionRank !== current.actionRank) continue;
    const previousAt = previous.activityAtMs ?? Number.NEGATIVE_INFINITY;
    const currentAt = current.activityAtMs ?? Number.NEGATIVE_INFINITY;
    assert.ok(
      previousAt >= currentAt,
      `${label}: weight ${current.actionRank} must lead with the most recent activity,`
        + ` but ${current.id} (${currentAt}) came after ${previous.id} (${previousAt})`,
    );
    if (previousAt === currentAt) {
      assert.ok(
        previous.id.localeCompare(current.id) <= 0,
        `${label}: equal activity at weight ${current.actionRank} must fall back to id ascending`
          + ` (${previous.id} before ${current.id})`,
      );
    }
  }
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

    // v1.4 (owner ruling B): a blank conclusion is ACCEPTANCE WITHOUT an
    // instruction — it now SUCCEEDS and persists NULL. The pre-v1.4
    // VALIDATION refusal is superseded; the queue gate is the empty
    // conclusion itself, so this card must NOT join the execution queue.
    const empty = board.closeCard({ taskId: 'seed-task-01', conclusion: '   ', by: 'owner' });
    assert.equal(empty.ok, true, empty.error);
    assert.equal(empty.card.closureConclusion, null, 'a blank conclusion persists as NULL');
    assert.equal(empty.card.state, 'closed', 'acceptance alone closes the card');
    assert.equal(orchestrationStore.getTask('seed-task-01').status, 'completed');
    const queueAfterEmpty = board.listPendingClosures();
    assert.equal(
      queueAfterEmpty.items.filter((item) => item.cardId === 'seed-task-01').length,
      0,
      'a conclusion-less acceptance never enters the pending-closure queue',
    );

    const closed = board.closeCard({ taskId: 'seed-task-01', conclusion: 'shipped: card closed by test', by: 'owner' });
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
    const terminal = board.closeCard({ taskId: 'seed-task-17', conclusion: 'already cancelled', by: 'owner' });
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

test('the list view ranks cards by the contract weights, ties on the most recent activity', async () => {
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

    // Same weight -> most recent activity first, on the whole board and again on
    // the closed column: weight 4 is where the owner saw the oldest card pinned
    // to the top, so it gets its own explicit expectation.
    assertNewestFirst(cards, 'scope=all');
    const closedColumn = cards.filter((card) => card.state === 'closed');
    assert.ok(closedColumn.length >= 3, 'the fixture must seed the closed cards or this check proves nothing');
    assertNewestFirst(closedColumn, 'closed column');
    assert.deepEqual(
      closedColumn.map((card) => card.id),
      ['seed-task-20', 'seed-task-16', 'seed-task-17'],
      'the closed column leads with SEED-20 (group task touched an hour ago) over the 10-day-old pair',
    );

    // The archive view is its own population but uses the same tie rule.
    const archived = board.listCards({ scope: 'archived' }).cards;
    assert.ok(archived.length > 1, 'the fixture must seed archived rows or this check proves nothing');
    assertNewestFirst(archived, 'scope=archived');
  } finally {
    sqliteStore.close();
  }
});

test('an unreadable activity timestamp is unknown activity, never a throw', async () => {
  const { sqliteStore, board, manifest } = await openBoard();
  try {
    const db = sqliteStore.getDatabase();
    const nowMs = Date.now() + SEED_CLOCK_AHEAD_MS;
    // `orchestration_tasks.updated_at` is TEXT NOT NULL, so a value the board
    // cannot parse IS reachable. It must degrade to "unknown activity" — not to
    // a crash, not to 0, and not to a bogus epoch near the top of its column.
    db.run(
      `INSERT INTO orchestration_tasks
        (id, owner_intent, enriched_goal, acceptance_criteria_json, source_session_id,
         twin_metabot_id, owner_global_meta_id, status, plan_version, created_at, updated_at, completed_at,
         closure_conclusion, closure_by, closure_at, closure_pin_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'running', 1, ?, 'not-a-timestamp', NULL, NULL, NULL, NULL, NULL)`,
      [
        'seed-task-unknown-activity',
        'unknown activity timestamp',
        'unknown activity timestamp',
        '[]',
        null,
        manifest.twinMetabotId,
        manifest.ownerGlobalMetaId,
        new Date(nowMs - 2 * 60 * 60 * 1000).toISOString(),
      ],
    );
    // ADM-1 is the only branch a step-less row can match (v1.1 freeze doc §2), so
    // registering it is what puts the row on the board at all.
    db.run(
      `INSERT INTO kv (key, value, updated_at) VALUES ('tracked_long_task_registry', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [JSON.stringify([...manifest.registeredTaskIds, 'seed-task-unknown-activity']), nowMs],
    );

    const cards = board.listCards({ scope: 'all' }).cards;
    const unknown = cards.find((card) => card.id === 'seed-task-unknown-activity');
    assert.ok(unknown, 'the row must still render');
    assert.equal(unknown.admitted, true, 'the kv registration must admit the row');
    assert.equal(unknown.activityAtMs, null, 'an unparseable timestamp is null activity, not 0 and not NaN');
    assertNewestFirst(cards, 'scope=all with an unknown-activity card');
    const peers = cards.filter((card) => card.actionRank === unknown.actionRank);
    assert.equal(
      peers[peers.length - 1].id,
      unknown.id,
      'unknown activity sorts last inside its weight',
    );
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
    // v1.3 amendment: the manual archive override (`tracked_card_archive_override`)
    // is the second sanctioned card-level kv row — one row, reversible, no DDL.
    // The assertion above only inspects the BEAT value, so it still guards
    // "liveness never carries card ids"; it does not police the two data keys.
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

/**
 * Owner 2026-09-18 feedback ③: every MetaWeb scheme embeds a pinid in its payload,
 * so probing the pinid token BEFORE the scheme made `metaapp://<pinid>` come back as
 * 'pin' and left the metaapp branch as dead code. The declared order is now
 * metaapp:// -> metafile:// -> pinid token -> http(s):// -> other, '' -> 'none'.
 */
test('trackedDeliverableKind: the scheme wins over the embedded pinid token (metaapp -> metaapp, not pin)', () => {
  const pinid = 'a3f1c2d4e5b60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f809i0';
  // The regression this pins down: at 03069ece this exact call returned 'pin'.
  assert.equal(trackedDeliverableKind(`metaapp://${pinid}`), 'metaapp');
  assert.equal(trackedDeliverableKind(`metafile://${pinid}`), 'metafile');
  assert.equal(trackedDeliverableKind(`pin://${pinid}`), 'pin');
  assert.equal(trackedDeliverableKind(pinid), 'pin', 'a bare pinid token is a pin');
  assert.equal(trackedDeliverableKind('http://example.com/report'), 'url');
  assert.equal(trackedDeliverableKind('https://example.com/report.pdf'), 'url');
  assert.equal(trackedDeliverableKind(''), 'none');
  assert.equal(trackedDeliverableKind('   '), 'none', 'whitespace-only trims to none');
  assert.equal(trackedDeliverableKind('not-a-uri'), 'other');
  // Scheme branches are matched on the trimmed head, before the token probe.
  assert.equal(trackedDeliverableKind(`  metaapp://${pinid}?tab=1  `), 'metaapp');
  assert.equal(trackedDeliverableKind(`  metafile://${pinid}  `), 'metafile');
  // Consequence of the declared order (unchanged from the parent commit): an http(s)
  // URL that itself embeds a pinid token still lands in 'pin', because the token
  // branch precedes the http branch. Locked here so the order stays a decision.
  assert.equal(trackedDeliverableKind(`https://example.com/${pinid}`), 'pin');
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
    // v1.4 fixture-fidelity note: a row the owner already closed ALWAYS carries
    // closure_at (closeCard wrote conclusion + closure_at in one UPDATE), so
    // legacy-d seeds the timestamp; under the v1.4 closed rule it stays closed.
    ['legacy-a', 'completed', null, null],
    ['legacy-b', 'failed', null, null],
    ['legacy-c', 'cancelled', '   ', null],
    ['legacy-d', 'completed', 'owner already closed this one', '2026-09-09T00:00:00.000Z'],
    ['legacy-e', 'running', null, null],
  ];
  const insertLegacy = (db, id, status, conclusion, closureAt) => db.run(
    `INSERT INTO orchestration_tasks
       (id, owner_intent, enriched_goal, acceptance_criteria_json, source_session_id, twin_metabot_id,
        owner_global_meta_id, status, plan_version, created_at, updated_at, completed_at,
        closure_conclusion, closure_by, closure_at, closure_pin_id)
     VALUES (?, ?, NULL, '[]', NULL, 1, 'idq1t3lzq0q4rec8edujklp4w8hfmgceqxth82a7m9', ?, 1, ?, ?, NULL, ?, ?, ?, NULL)`,
    [id, `legacy ${id}`, status, '2026-09-01T00:00:00.000Z', '2026-09-10T00:00:00.000Z',
      conclusion, conclusion ? 'owner' : null, closureAt],
  );
  const rows = (db, sql) => db.exec(sql)[0].values.map((values) => values.join('\u0001'));

  const store = await SqliteStore.create(dir);
  let result;
  try {
    const db = store.getDatabase();
    for (const [id, status, conclusion, closureAt] of legacy) insertLegacy(db, id, status, conclusion, closureAt);
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
    insertLegacy(db, 'legacy-new', 'failed', null, null);
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

test('the closing modal says Twin executes the conclusion as the final close-out', async () => {
  const fs = await import('node:fs');
  const read = (relative) => fs.readFileSync(relative, 'utf8');

  // The note must be RENDERED next to the conclusion input, not merely defined.
  const modal = read('src/renderer/components/trackedTasks/CloseTaskModal.tsx');
  assert.match(
    modal,
    /trackedTask\.close\.recordOnlyHint/,
    'the close-out note must be rendered in the closing modal',
  );
  // v1.4 (owner ruling E): the close-out dialog has NO "closed by" selector —
  // the person clicking IS the closer (owner). The key is deleted from i18n
  // and the selector row is gone from the modal; both absences are pinned.
  assert.doesNotMatch(modal, /trackedTask\.close\.by/, 'the modal must not render a close-by selector');
  const i18nBody = read('src/renderer/services/i18n.ts');
  const byKeyHits = [...i18nBody.matchAll(/'trackedTask\.close\.by'/g)].length;
  assert.equal(byKeyHits, 0, 'trackedTask.close.by is deleted from both dictionaries');
  // Measured inside the JSX return, so the header comment that documents the key
  // cannot substitute for the rendered element.
  const jsxStart = modal.indexOf('return (');
  assert.ok(jsxStart > -1, 'the modal must have a JSX body');
  const textareaAt = modal.indexOf('trackedTask.close.conclusionPlaceholder', jsxStart);
  const hintAt = modal.indexOf('trackedTask.close.recordOnlyHint', jsxStart);
  assert.ok(textareaAt > -1 && hintAt > textareaAt, 'the note must sit below the conclusion textarea');

  const i18n = read('src/renderer/services/i18n.ts');
  // The frozen EN copy contains an escaped apostrophe ("card's"), so the capture
  // must survive `\'` instead of stopping on it — otherwise one key would yield
  // two truncated matches and the "exactly EN + ZH" check would misfire.
  const copyFor = (key) => [...i18n.matchAll(
    new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'g'),
  )].map((match) => match[1].replace(/\\'/g, "'"));
  // Positive control FIRST: prove the extractor can see absence, otherwise the
  // "exactly EN + ZH" check below could pass on an extractor that sees nothing.
  assert.equal(copyFor('trackedTask.thisKeyDoesNotExist').length, 0, 'the copy extractor must be able to see 0');

  const keys = [
    'trackedTask.close.title',
    'trackedTask.close.conclusionPlaceholder',
    'trackedTask.close.recordOnlyHint',
    'trackedTask.close.confirm',
    'trackedTask.closure.byOwner',
    'trackedTask.closure.byTwin',
  ];
  for (const key of keys) {
    const values = copyFor(key);
    assert.equal(values.length, 2, `${key}: expected exactly EN + ZH, saw ${values.length}`);
  }

  // ---------------------------------------------------------------------
  // D7 (spec v1.2.2): the copy is frozen as SEMANTIC anchors, not verbatim
  // strings — the verbatim strings are read off the FINAL HEAD by S3 and
  // recorded there. So the assertions below check must-contain / must-not
  // anchors only; no second verbatim authority lives in this file.
  // ---------------------------------------------------------------------
  // The three forbidden tokens are assembled from fragments so this file never
  // carries the literal and the repo-wide zero-hit scan further down cannot
  // trip over its own lexicon. Positive controls for each follow.
  const FORBIDDEN_ZH = ['不会自动', '执行'].join('');
  const FORBIDDEN_EN = ['will not be ', 'executed automatically'].join('');
  const FORBIDDEN_RECORDED_ONLY = ['recorded', ' only'].join('');
  const supersededZh = ['这段结论会被记录，不会自动', '执行。'].join('');
  const supersededEn = ['This conclusion is recorded', ' only — it will not be ', 'executed automatically.'].join('');
  assert.ok(supersededZh.includes(FORBIDDEN_ZH), 'the zh absence predicate must see the superseded wording');
  assert.ok(
    new RegExp(FORBIDDEN_EN).test(supersededEn),
    'the en absence predicate must see the superseded wording',
  );
  assert.ok(
    FORBIDDEN_RECORDED_ONLY.length > 0 && supersededEn.includes(FORBIDDEN_RECORDED_ONLY),
    'the recorded-only predicate must see a hit on the superseded wording',
  );

  // D7 must-contain / must-not-contain, per key, per language.
  const anchors = [
    {
      key: 'trackedTask.close.recordOnlyHint',
      mustContain: { zh: ['执行', 'Twin', '确认'], en: [/execut/i, /confirm/i, /Twin/] },
      mustNot: { zh: [FORBIDDEN_ZH], en: [new RegExp(FORBIDDEN_EN), new RegExp(FORBIDDEN_RECORDED_ONLY)] },
    },
    {
      // v1.4: the "closed by" selector is gone (the clicker is the closer).
      key: 'trackedTask.close.by',
      absent: true,
    },
    {
      key: 'trackedTask.close.confirm',
      mustContain: { zh: ['收口'], en: [/[Cc]los/] },
      mustNot: { zh: ['确认记录'], en: [/Record it/] },
    },
    {
      key: 'trackedTask.closure.byOwner',
      mustContain: { zh: ['收口'], en: [/[Cc]los/] },
      mustNot: { zh: ['记录'], en: [/[Rr]ecord/] },
    },
    {
      key: 'trackedTask.closure.byTwin',
      mustContain: { zh: ['收口'], en: [/[Cc]los/] },
      mustNot: { zh: ['记录'], en: [/[Rr]ecord/] },
    },
    {
      key: 'trackedTask.receipt.statusKept',
      mustContain: { zh: ['收口'], en: [/[Cc]los/] },
      mustNot: { zh: ['结论已记录'], en: [/recorded/] },
    },
  ];
  for (const anchor of anchors) {
    const values = copyFor(anchor.key);
    if (anchor.absent) {
      assert.equal(values.length, 0, `${anchor.key}: the superseded key must be gone from both dictionaries`);
      continue;
    }
    assert.equal(values.length, 2, `${anchor.key}: expected exactly EN + ZH, saw ${values.length}`);
    const [zh, en] = values;
    for (const needle of anchor.mustContain.zh) {
      assert.ok(zh.includes(needle), `${anchor.key}: zh "${zh}" must contain "${needle}"`);
    }
    for (const pattern of anchor.mustContain.en) {
      assert.match(en, pattern, `${anchor.key}: en "${en}" must match ${pattern}`);
    }
    for (const needle of anchor.mustNot.zh) {
      assert.equal(zh.includes(needle), false, `${anchor.key}: zh "${zh}" must not contain "${needle}"`);
    }
    for (const pattern of anchor.mustNot.en) {
      assert.doesNotMatch(en, pattern, `${anchor.key}: en "${en}" must not match ${pattern}`);
    }
  }

  // D8: the paired surface is 8 keys. The two that carry no wording requirement
  // this round still must exist exactly once per language.
  for (const key of ['trackedTask.close.title', 'trackedTask.close.conclusionPlaceholder']) {
    const values = copyFor(key);
    assert.equal(values.length, 2, `${key}: expected exactly EN + ZH, saw ${values.length}`);
    assert.ok(values[0] && values[1], `${key}: both languages must carry non-empty copy`);
  }
});

/* ------------------------------------------------------------------------- *
 * v1.2 (task #86 / owner ruling B): the closing conclusion is an INSTRUCTION.
 * Spec pin: pin://06d96a7046f98f9111ff446bf19043df8214af1a96f12df2b87a9b85040a8da1i0
 * §9 maps every acceptance item to one of the assertions below.
 * ------------------------------------------------------------------------- */

const v12 = require('../dist-electron/main/services/trackedTaskBoard.js');

/** Raw row read, for "did anything actually change" comparisons. */
function rawRow(db, sql, params) {
  return db.exec(sql, params)[0]?.values?.[0] ?? [];
}

/** The projection the queue promises, straight off SQL — the cross-check source. */
const QUEUE_SQL = `SELECT id FROM orchestration_tasks
  WHERE closure_conclusion IS NOT NULL AND trim(closure_conclusion) <> ''
    AND closure_by IN ('owner', 'twin') ORDER BY closure_at ASC, id ASC`;

function queueIds(db) {
  return (db.exec(QUEUE_SQL)[0]?.values ?? []).map((values) => String(values[0]));
}

/** Clear the fixture's own conclusions so a test can assert absolute numbers. */
function clearClosures(db) {
  db.run(
    'UPDATE orchestration_tasks SET closure_conclusion = NULL, closure_by = NULL, closure_at = NULL,'
    + ' closure_processed_at = NULL, closure_processed_by = NULL, closure_processed_hash = NULL,'
    + ' closure_receipt = NULL, closure_receipt_pin_id = NULL',
  );
}

test('v1.2 §3: the pending predicate is the single queue rule, with its negatives controlled', () => {
  const { isClosurePending, closureHash } = v12;
  // T3 — no conclusion, or only whitespace, can never produce a pending item.
  assert.equal(isClosurePending({ closureConclusion: null, closureBy: 'twin', closureProcessedHash: null }), false);
  assert.equal(isClosurePending({ closureConclusion: '   ', closureBy: 'twin', closureProcessedHash: null }), false);
  // T2 — a migration-written conclusion is not an instruction.
  assert.equal(
    isClosurePending({ closureConclusion: 'migration text', closureBy: 'system_backfill', closureProcessedHash: null }),
    false,
  );
  // Positive control for BOTH negatives above: an allowed shape IS pending, so
  // those two `false`s are the whitelist talking, not a predicate that never fires.
  assert.equal(isClosurePending({ closureConclusion: 'run it', closureBy: 'twin', closureProcessedHash: null }), true);
  assert.equal(isClosurePending({ closureConclusion: 'run it', closureBy: 'owner', closureProcessedHash: null }), true);
  // Acked: the mark's hash equals the conclusion's hash.
  assert.equal(
    isClosurePending({ closureConclusion: 'run it', closureBy: 'twin', closureProcessedHash: closureHash('run it') }),
    false,
  );
  // T1 — a DIFFERENT conclusion against an older mark is pending again.
  assert.equal(
    isClosurePending({ closureConclusion: 'run it again', closureBy: 'twin', closureProcessedHash: closureHash('run it') }),
    true,
  );
  // The hash binds the TRIMMED text: re-closing with only extra spaces is not a
  // new instruction.
  assert.equal(
    isClosurePending({ closureConclusion: '  run it  ', closureBy: 'owner', closureProcessedHash: closureHash('run it') }),
    false,
  );
});

test('v1.2 §5: the destructive lexicon is conservative and reports which term hit', () => {
  const { classifyClosureConclusion } = v12;
  const samples = [
    '删除旧卡',
    'transfer 1 SPACE',
    'publish the report',
    'PUBLISH now',
    '重置状态',
    ['rm -', 'rf /tmp/x'].join(''),
  ];
  for (const text of samples) {
    const verdict = classifyClosureConclusion(text);
    assert.equal(verdict.destructive, true, `"${text}" must be flagged`);
    assert.ok(verdict.reasons.length > 0, `"${text}" must report which term hit`);
  }
  // Positive control for the other direction: a genuinely benign conclusion must
  // NOT be flagged, or the gate would be noise nobody reads.
  for (const text of ['no further work needed', '仅记录、无需动作']) {
    assert.equal(classifyClosureConclusion(text).destructive, false, `"${text}" must not be flagged`);
  }
});

test('v1.2 §3: the queue equals the ledger projection, and a conclusion-less card never joins it', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    const db = sqliteStore.getDatabase();
    assert.ok(board.listCards({ scope: 'all' }).cards.length > 5, 'the fixture must carry rows');
    const expected = queueIds(db);
    assert.ok(expected.length > 0, 'positive control: the fixture carries conclusions to find');

    const queue = board.listPendingClosures();
    assert.deepEqual(queue.items.map((item) => item.cardId), expected, 'the queue IS the ledger projection');
    assert.equal(queue.count, expected.length);
    assert.equal(queue.truncated, false);
    assert.equal(typeof queue.generatedAt, 'string');
    assert.ok(queue.items.every((item) => item.conclusion.trim().length > 0));

    const blankSql = "SELECT id FROM orchestration_tasks WHERE closure_conclusion IS NULL OR trim(closure_conclusion) = ''";
    const blankIds = (db.exec(blankSql)[0]?.values ?? []).map((values) => String(values[0]));
    assert.ok(blankIds.length > 0, 'positive control: there ARE conclusion-less rows');
    const queued = new Set(queue.items.map((item) => item.cardId));
    for (const id of blankIds) {
      assert.equal(queued.has(id), false, `${id} has no conclusion and must not queue`);
    }
  } finally {
    sqliteStore.close();
  }
});

test('v1.2 §3.1 T1: a new conclusion on an already-acked card re-enters the queue', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    clearClosures(sqliteStore.getDatabase());
    const first = board.closeCard({ taskId: 'seed-task-01', conclusion: 'first conclusion', by: 'owner' });
    assert.equal(first.ok, true, first.error);
    assert.equal(first.card.closurePending, true, 'a fresh conclusion is pending');
    let queue = board.listPendingClosures();
    assert.equal(queue.count, 1);
    assert.equal(queue.items[0].cardId, 'seed-task-01');
    assert.equal(queue.items[0].conclusion, 'first conclusion');
    assert.equal(queue.items[0].closureBy, 'owner');
    assert.ok(queue.items[0].closureAt, 'closure_at must be reported');
    assert.equal(queue.items[0].closurePinId, null);

    const ack = board.acknowledgeClosure({
      taskId: 'seed-task-01',
      processedBy: 'twin',
      receipt: 'handled it',
      evidenceUri: 'pin://first',
    });
    assert.equal(ack.ok, true, ack.error);
    assert.equal(ack.alreadyProcessed, false);
    assert.equal(board.listPendingClosures().count, 0, 'an acked conclusion leaves the queue');

    // T1: the SAME card is closed again with a different conclusion. The old
    // mark must not swallow the new instruction.
    const second = board.closeCard({ taskId: 'seed-task-01', conclusion: 'second conclusion', by: 'owner' });
    assert.equal(second.ok, true, second.error);
    assert.equal(second.card.closurePending, true, 'the new conclusion is pending again');
    assert.equal(second.card.closureReceipt, null, 'the old receipt is cleared in the same write');
    assert.equal(second.card.closureProcessedAt, null);
    queue = board.listPendingClosures();
    assert.equal(queue.count, 1, 'the new conclusion must not be swallowed by the old mark');
    assert.equal(queue.items[0].conclusion, 'second conclusion');
  } finally {
    sqliteStore.close();
  }
});

test('v1.2 §4: acknowledging is a single-statement CAS — the repeat is a no-op', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    const db = sqliteStore.getDatabase();
    clearClosures(db);
    board.closeCard({ taskId: 'seed-task-01', conclusion: 'execute me', by: 'owner' });
    const markSql = 'SELECT closure_processed_at, closure_processed_by, closure_processed_hash, closure_receipt FROM orchestration_tasks WHERE id = ?';

    const input = {
      taskId: 'seed-task-01',
      processedBy: 'twin',
      receipt: 'handled it',
      evidenceUri: 'pin://evidence',
    };
    const first = board.acknowledgeClosure(input);
    assert.equal(first.ok, true, first.error);
    assert.equal(first.alreadyProcessed, false);
    const before = rawRow(db, markSql, ['seed-task-01']);

    const second = board.acknowledgeClosure({ ...input, receipt: 'a DIFFERENT receipt', evidenceUri: 'pin://other' });
    assert.equal(second.ok, true, 'a repeat is not an error');
    assert.equal(second.alreadyProcessed, true);
    assert.equal(second.receipt, 'handled it', 'the EXISTING mark is read back, not overwritten');
    assert.deepEqual(rawRow(db, markSql, ['seed-task-01']), before, 'the mark must not move on a repeat');
    assert.equal(board.listPendingClosures().count, 0);

    // The audit side channel recorded the ONE real execution, never the no-op.
    const log = board.readClosureAckAuditLog();
    assert.equal(log.length, 1);
    assert.equal(log[0].cardId, 'seed-task-01');
    assert.equal(log[0].by, 'twin');
    assert.equal(log[0].evidence, 'pin://evidence');
    assert.equal(log[0].conclusionHash, v12.closureHash('execute me'));
  } finally {
    sqliteStore.close();
  }
});

test('v1.2 §5: a destructive conclusion is refused without the existing safety gate', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    const db = sqliteStore.getDatabase();
    clearClosures(db);
    board.closeCard({ taskId: 'seed-task-03', conclusion: '删除旧卡并清空目录', by: 'owner' });
    const item = board.listPendingClosures().items.find((entry) => entry.cardId === 'seed-task-03');
    assert.ok(item, 'the destructive conclusion must still be VISIBLE in the queue');
    assert.equal(item.destructive, true, 'the lexicon must flag it');
    assert.ok(item.destructiveReasons.length > 0);
    const markSql = 'SELECT closure_processed_at, closure_receipt FROM orchestration_tasks WHERE id = ?';

    const refused = board.acknowledgeClosure({
      taskId: 'seed-task-03',
      processedBy: 'twin',
      receipt: 'took it down',
      evidenceUri: 'pin://x',
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'CONFIRMATION_REQUIRED');
    assert.deepEqual(rawRow(db, markSql, ['seed-task-03']), [null, null], 'a refused ack must write nothing');
    assert.equal(board.listPendingClosures().count, 1, 'it stays pending — no silent execution');
    assert.equal(board.readClosureAckAuditLog().length, 0, 'a refusal is not an execution');

    const allowed = board.acknowledgeClosure({
      taskId: 'seed-task-03',
      processedBy: 'twin',
      receipt: 'took it down after the owner confirmed',
      evidenceUri: 'pin://evidence',
      confirmationRef: 'pin://owner-confirmation',
    });
    assert.equal(allowed.ok, true, allowed.error);
    assert.equal(board.listPendingClosures().count, 0);
  } finally {
    sqliteStore.close();
  }
});

test('v1.2 §4: a receipt without evidence and without the no-op marker is refused', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    const db = sqliteStore.getDatabase();
    clearClosures(db);
    board.closeCard({ taskId: 'seed-task-04', conclusion: 'looked into it', by: 'owner' });
    const markSql = 'SELECT closure_processed_at, closure_receipt FROM orchestration_tasks WHERE id = ?';

    const empty = board.acknowledgeClosure({ taskId: 'seed-task-04', processedBy: 'twin', receipt: '   ' });
    assert.equal(empty.ok, false);
    assert.equal(empty.code, 'VALIDATION');

    const incomplete = board.acknowledgeClosure({ taskId: 'seed-task-04', processedBy: 'twin', receipt: 'did some work' });
    assert.equal(incomplete.ok, false);
    assert.equal(incomplete.code, 'RECEIPT_INCOMPLETE');
    assert.deepEqual(rawRow(db, markSql, ['seed-task-04']), [null, null], 'an incomplete receipt writes nothing');

    const badActor = board.acknowledgeClosure({
      taskId: 'seed-task-04',
      processedBy: 'system_backfill',
      receipt: 'done',
      evidenceUri: 'pin://x',
    });
    assert.equal(badActor.ok, false);
    assert.equal(badActor.code, 'VALIDATION');

    // The explicit no-op marker IS a complete receipt (§4 step 1).
    const noAction = board.acknowledgeClosure({
      taskId: 'seed-task-04',
      processedBy: 'twin',
      receipt: '仅记录、无需动作',
    });
    assert.equal(noAction.ok, true, noAction.error);
    assert.equal(board.listPendingClosures().count, 0);
    // ... and it is reported verbatim on the card, so a reader can audit WHY.
    assert.equal(board.getCard('seed-task-04').closureReceipt, '仅记录、无需动作');
  } finally {
    sqliteStore.close();
  }
});

test('v1.2 §3.1 T2: the real startup backfill never floods the execution queue', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    const db = sqliteStore.getDatabase();
    const before = board.listPendingClosures().count;
    // Replay the upgrade path on a database that already holds terminal rows.
    const result = sqliteStore.migrateTrackedTaskClosureBackfill();
    assert.ok(result.backfilled >= 1, 'the migration must have written at least one conclusion');
    const row = rawRow(db, 'SELECT closure_by, closure_conclusion FROM orchestration_tasks WHERE id = ?', ['seed-task-18']);
    assert.equal(row[0], 'system_backfill', 'the migration writes its own actor');
    assert.ok(String(row[1]).length > 0, 'and a non-empty conclusion');
    assert.equal(board.listPendingClosures().count, before, 'T2: a migration conclusion is never an instruction');
    assert.equal(
      board.listPendingClosures().items.some((item) => item.cardId === 'seed-task-18'),
      false,
    );

    // Positive control: the SAME row with an allowed actor IS visible, so the
    // exclusion above is the whitelist and not an empty queue.
    db.run("UPDATE orchestration_tasks SET closure_by = 'twin' WHERE id = ?", ['seed-task-18']);
    const visible = board.listPendingClosures();
    assert.equal(visible.count, before + 1);
    assert.ok(visible.items.some((item) => item.cardId === 'seed-task-18'));
  } finally {
    sqliteStore.close();
  }
});

test('v1.2 §3: the queue is oldest-first, deterministic, and reports its real size when truncated', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    const db = sqliteStore.getDatabase();
    clearClosures(db);
    board.closeCard({ taskId: 'seed-task-01', conclusion: 'alpha', by: 'owner' });
    board.closeCard({ taskId: 'seed-task-03', conclusion: 'beta', by: 'owner' });
    board.closeCard({ taskId: 'seed-task-04', conclusion: 'gamma', by: 'owner' });
    // Pin the timestamps so the order is a fact rather than a scheduling race.
    db.run('UPDATE orchestration_tasks SET closure_at = ? WHERE id = ?', ['2026-01-03T00:00:00.000Z', 'seed-task-04']);
    db.run('UPDATE orchestration_tasks SET closure_at = ? WHERE id = ?', ['2026-01-01T00:00:00.000Z', 'seed-task-01']);
    db.run('UPDATE orchestration_tasks SET closure_at = ? WHERE id = ?', ['2026-01-02T00:00:00.000Z', 'seed-task-03']);

    const full = board.listPendingClosures();
    assert.deepEqual(full.items.map((item) => item.cardId), ['seed-task-01', 'seed-task-03', 'seed-task-04']);
    assert.equal(full.count, 3);
    assert.equal(full.truncated, false);

    const page = board.listPendingClosures({ limit: 2 });
    assert.equal(page.items.length, 2);
    assert.equal(page.count, 3, 'count is the QUEUE size, never the page size');
    assert.equal(page.truncated, true);
    assert.deepEqual(page.items.map((item) => item.cardId), ['seed-task-01', 'seed-task-03']);

    // Two reads over the same rows agree field for field — a third party can
    // re-run the queue and compare.
    assert.deepEqual(board.listPendingClosures().items, full.items);
  } finally {
    sqliteStore.close();
  }
});

test('v1.2 §7: no shipped file still requires the superseded copy', async () => {
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  // Assembled from fragments so this test's own tokens never appear literally.
  const absentTokens = [
    ['不会自动', '执行'].join(''),
    ['not be executed ', 'automatically'].join(''),
    ['recorded', ' only'].join(''),
    ['never ', 'executed'].join(''),
  ];
  const scan = (body) => absentTokens.filter((token) => body.includes(token));
  // Positive control FIRST: the scan can see a hit when one exists, otherwise
  // the zero-hit result below would be vacuous.
  assert.equal(scan(`x ${['不会自动', '执行'].join('')} y`).length, 1, 'the scan must see a hit');
  assert.deepEqual(scan('a perfectly clean line'), []);

  const offenders = [];
  const walk = (dir) => {
    for (const entry of fsMod.readdirSync(dir, { withFileTypes: true })) {
      const full = pathMod.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx|mjs|js|json)$/.test(entry.name)) continue;
      const body = fsMod.readFileSync(full, 'utf8');
      if (scan(body).length > 0) offenders.push(full);
    }
  };
  for (const root of ['src', 'tests']) walk(root);
  assert.deepEqual(offenders, [], 'no file may still require the superseded close-out copy');
});

/* ------------------------------------------------------------------------- *
 * v1.3 manual archive override (owner ruling 2026-09-18)
 *
 * The read-only archive view gains ONE write path: archive a closed card.
 * Design constraints under test:
 *   - storage is ONE kv row (`tracked_card_archive_override`), no new column,
 *     no new table, reversible via `archived: false`;
 *   - the ledger row itself is untouched (facts stay facts);
 *   - the projection shifts to `admitted := admitted ∧ ¬override`, so
 *     `admitted + archived === total` keeps holding and closureDue dies with
 *     the archive;
 *   - the matched admission rules survive on the card (facts, not state).
 * ------------------------------------------------------------------------- */

test('archiveCard: one kv-row override moves an admitted card into the archive and keeps the counts invariant', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    const before = board.listCards({ scope: 'all' });
    assert.equal(before.counts.admitted + before.counts.archived, before.counts.total);
    const target = before.cards.find((card) => card.admitted) ?? null;
    assert.ok(target, 'the seed must contain at least one admitted card');

    // The ledger row must be byte-identical before/after: the override is a
    // projection shift, never a ledger write.
    const ledgerBefore = rawRow(
      sqliteStore.getDatabase(),
      'SELECT id, status, updated_at, closure_conclusion FROM orchestration_tasks WHERE id = ?',
      [target.id],
    );

    const result = board.archiveCard({ cardId: target.id, archived: true });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.card.admitted, false, 'the refreshed summary already reads archived');

    const ledgerAfter = rawRow(
      sqliteStore.getDatabase(),
      'SELECT id, status, updated_at, closure_conclusion FROM orchestration_tasks WHERE id = ?',
      [target.id],
    );
    assert.deepEqual(ledgerAfter, ledgerBefore, 'the override must never touch the ledger row');

    const after = board.listCards({ scope: 'all' });
    assert.equal(after.counts.admitted, before.counts.admitted - 1, 'admitted count drops by one');
    assert.equal(after.counts.archived, before.counts.archived + 1, 'archived count rises by one');
    assert.equal(
      after.counts.admitted + after.counts.archived,
      after.counts.total,
      'admitted + archived === total must survive the override',
    );
    assert.ok(
      !after.cards.some((card) => card.id === target.id),
      'the override-archived card leaves the admitted scope',
    );

    const archived = board.listCards({ scope: 'archived' });
    const archivedCard = archived.cards.find((card) => card.id === target.id);
    assert.ok(archivedCard, 'the override-archived card is queryable through scope:archived');
    assert.equal(archivedCard.admitted, false);
    assert.equal(archivedCard.closureDue, false, 'an override-archived card never queues for closure');
    assert.equal(archivedCard.closureDueLevel, null, 'an override-archived card carries no closure level');
    assert.deepEqual(
      archivedCard.admissionMatched,
      target.admissionMatched,
      'matched rules are admission facts: the override layers on top without erasing them',
    );

    // Default scope must hide it exactly like any other archived row.
    const defaultBoard = board.listCards({ scope: 'default' });
    assert.ok(
      !defaultBoard.cards.some((card) => card.id === target.id),
      'the override-archived card must not resurface in the default scope',
    );

    // The detail read path reflects the same projection.
    const detail = board.getCard(target.id);
    assert.ok(detail);
    assert.equal(detail.admitted, false);
    assert.equal(detail.closureDue, false);

    // Storage: ONE kv row, JSON object cardId -> ISO timestamp. No new column.
    const kvRow = rawRow(
      sqliteStore.getDatabase(),
      'SELECT value FROM kv WHERE key = ?',
      ['tracked_card_archive_override'],
    );
    assert.ok(kvRow.length > 0, 'the override kv row must exist after archiving');
    const parsed = JSON.parse(String(kvRow[0]));
    assert.ok(parsed[target.id], 'the override row records the cardId');
    assert.ok(!Number.isNaN(Date.parse(parsed[target.id])), 'the override value is a timestamp');

    const ledgerColumns = sqliteStore.getDatabase()
      .exec('PRAGMA table_info(orchestration_tasks)')[0].values.map((row) => row[1]);
    assert.equal(
      ledgerColumns.includes('archive_override'),
      false,
      'the override must stay out of the ledger schema (no DDL)',
    );
  } finally {
    sqliteStore.close();
  }
});

test('archiveCard is reversible and a repeated archive does not rewrite the kv row', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    const target = board.listCards({ scope: 'all' }).cards.find((card) => card.admitted);
    assert.ok(target);

    assert.equal(board.archiveCard({ cardId: target.id, archived: true }).ok, true);
    const first = JSON.parse(String(rawRow(
      sqliteStore.getDatabase(),
      'SELECT value FROM kv WHERE key = ?',
      ['tracked_card_archive_override'],
    )[0]));

    assert.equal(board.archiveCard({ cardId: target.id, archived: true }).ok, true);
    const second = JSON.parse(String(rawRow(
      sqliteStore.getDatabase(),
      'SELECT value FROM kv WHERE key = ?',
      ['tracked_card_archive_override'],
    )[0]));
    assert.deepEqual(second, first, 'an idempotent re-archive must not rewrite the override row');

    assert.equal(board.archiveCard({ cardId: target.id, archived: false }).ok, true);
    const restored = board.listCards({ scope: 'all' });
    assert.equal(
      restored.counts.admitted,
      board.listCards({ scope: 'default' }).counts.total - restored.counts.archived,
      'counts stay consistent after the revert',
    );
    assert.ok(
      restored.cards.some((card) => card.id === target.id && card.admitted === true),
      'archived:false removes the override and the card returns to the admitted projection',
    );
    const rowAfterRevert = rawRow(
      sqliteStore.getDatabase(),
      'SELECT value FROM kv WHERE key = ?',
      ['tracked_card_archive_override'],
    );
    assert.ok(
      rowAfterRevert.length === 0 || !JSON.parse(String(rowAfterRevert[0]))[target.id],
      'the reverted cardId leaves the override row',
    );
  } finally {
    sqliteStore.close();
  }
});

test('archiveCard validates input and reports a missing card as NOT_FOUND', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    const blank = board.archiveCard({ cardId: '   ', archived: true });
    assert.equal(blank.ok, false);
    assert.equal(blank.code, 'VALIDATION');

    const badType = board.archiveCard({ cardId: 'seed-task-01', archived: 'yes' });
    assert.equal(badType.ok, false);
    assert.equal(badType.code, 'VALIDATION');

    const missing = board.archiveCard({ cardId: 'no-such-task', archived: true });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'NOT_FOUND');

    // Nothing was written by any rejected call.
    const row = rawRow(
      sqliteStore.getDatabase(),
      'SELECT value FROM kv WHERE key = ?',
      ['tracked_card_archive_override'],
    );
    assert.equal(row.length, 0, 'rejected archive calls must not write the override row');
  } finally {
    sqliteStore.close();
  }
});

test('parseArchiveOverrides: malformed input reads as an empty override set, never a throw', () => {
  const { parseArchiveOverrides } = v12;
  assert.deepEqual(parseArchiveOverrides(null), {});
  assert.deepEqual(parseArchiveOverrides(''), {});
  assert.deepEqual(parseArchiveOverrides('   '), {});
  assert.deepEqual(parseArchiveOverrides('not json {'), {});
  assert.deepEqual(parseArchiveOverrides('[]'), {}, 'a bare array carries no overrides');
  assert.deepEqual(parseArchiveOverrides('42'), {});
  assert.deepEqual(parseArchiveOverrides('{"seed-task-01":"2026-09-18T00:00:00.000Z"}'), {
    'seed-task-01': '2026-09-18T00:00:00.000Z',
  });
  assert.deepEqual(
    parseArchiveOverrides('{"bad-entry":42,"good":"2026-09-18T00:00:00.000Z"}'),
    { good: '2026-09-18T00:00:00.000Z' },
    'non-string values are dropped, not trusted',
  );
});

/* ------------------------------------------------------------------------- *
 * v1.4 (owner rulings A-G): closing a card IS the human acceptance.
 *   - closed == terminal && closure_at IS NOT NULL (conclusion optional);
 *   - a closed card never wears the stale badge again, at any idle age;
 *   - closing a group-task-linked card goes THROUGH the bridge (accept or
 *     cancel) and rejects the WHOLE card when the bridge refuses;
 *   - the closure columns have one writer: orchestrationStore.recordClosure.
 * ------------------------------------------------------------------------- */

const { GroupTaskStore } = require('../dist-electron/main/groupTaskStore.js');
const { GroupTaskOrchestrationBridge } = require('../dist-electron/main/services/groupTaskOrchestrationBridge.js');
const { deriveCardState } = require('../dist-electron/main/services/trackedTaskBoard.js');

/**
 * Full harness: the board AND the group-task bridge over one sqlite store, so
 * closeCard's bridge linkage can be exercised for real (not a stub). Seeds the
 * enabled twin (id 1) + worker (id 2) rows the bridge's chair/worker checks
 * require, mirroring tests/groupTaskOrchestrationBridge.test.mjs.
 */
async function openBoardWithBridge() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-tracked-close-bridge-'));
  const sqliteStore = await SqliteStore.create(dir);
  const db = sqliteStore.getDatabase();
  // `cowork_sessions.session_type` is added by coworkStore's own idempotent
  // migration in production; this harness boots the store alone, so it applies
  // the same guarded ALTER the fixture does (buildSummary's session links read
  // the column).
  const sessionColumns = db.exec('PRAGMA table_info(cowork_sessions)')[0].values.map((row) => row[1]);
  if (!sessionColumns.includes('session_type')) {
    db.run("ALTER TABLE cowork_sessions ADD COLUMN session_type TEXT NOT NULL DEFAULT 'standard'");
  }
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at)
     VALUES (?, ?, ?, ?)`,
    [1, 'abandon ability able about above absent absorb abstract absurd abuse access accident bridge', "m/44'/10001'/0'/0/0", 1],
  );
  const insertBot = ({ id, name, type }) => {
    db.run(
      `INSERT INTO metabots (
        id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
        name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul,
        boss_global_metaid, created_at, updated_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, '0000', ?, ?, ?, 1, 1)`,
      [
        id, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `public-${id}`, `chat-public-${id}`,
        name, `metaid-${id}`, `gmid-${id}`, type, `${name} role`, `${name} soul`,
      ],
    );
  };
  insertBot({ id: 1, name: 'Twin Bot', type: 'twin' });
  insertBot({ id: 2, name: 'Builder Bot', type: 'worker' });
  const metabots = new Map([
    [1, { id: 1, name: 'Twin Bot', metabot_type: 'twin', enabled: 1, boss_global_metaid: 'gmid-owner' }],
    [2, { id: 2, name: 'Builder Bot', metabot_type: 'worker', enabled: 1, boss_global_metaid: 'gmid-owner' }],
  ]);
  const orchestrationStore = new OrchestrationStore(db, sqliteStore.getSaveFunction());
  const groupTaskStore = new GroupTaskStore(db, sqliteStore.getSaveFunction());
  const bridge = new GroupTaskOrchestrationBridge({
    groupTaskStore,
    orchestrationStore,
    getMetabotById: (id) => metabots.get(id) ?? null,
  });
  const board = new TrackedTaskBoardService({
    db,
    orchestrationStore,
    saveDb: sqliteStore.getSaveFunction(),
    resolveGroupTaskBridge: () => bridge,
  });
  return { sqliteStore, db, orchestrationStore, groupTaskStore, bridge, board };
}

/** A terminal status for direct deriveCardState calls (no store roundtrip). */
function deriveTask(status) {
  return {
    id: 'd-1', ownerIntent: 'd', enrichedGoal: null, acceptanceCriteria: [],
    sourceSessionId: null, twinMetabotId: 1, ownerGlobalMetaId: 'owner',
    status, planVersion: 1,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-14T06:00:00.000Z', completedAt: null,
  };
}

const DERIVE_BASE = (status) => ({
  task: deriveTask(status),
  steps: [],
  attempts: [],
  openCheckpointCount: 0,
  verifiableDeliverableCount: 0,
  closureConclusion: null,
  closureAt: null,
  admitted: true,
  scheduled: null,
  sessionStatuses: [],
  activityAtMs: [Date.parse('2026-09-14T06:00:00.000Z')],
  nowMs: Date.parse('2026-09-17T06:00:00.000Z'), // 3 days idle
});

test('v1.4: a closed card (closure_at recorded) never wears the stale badge, at any idle age', () => {
  // Terminal + acceptance recorded + 3 days idle: closed, no warn, no due.
  const closed = deriveCardState({ ...DERIVE_BASE('completed'), closureAt: '2026-09-16T00:00:00.000Z' });
  assert.equal(closed.cardState, 'closed');
  assert.equal(closed.closureWarn, false, 'the stale badge must die once the card is closed out');
  assert.equal(closed.closureDue, false, 'a closed card never queues for closure');

  // Same row WITHOUT the closure record: the badge stays honest.
  const unclosed = deriveCardState(DERIVE_BASE('completed'));
  assert.equal(unclosed.cardState, 'waiting_decision');
  assert.equal(unclosed.closureWarn, true, 'an unclosed stale card still warns');
  assert.equal(unclosed.closureDue, true);
  // Level priority: terminal-and-unclosed outranks zombie for the same card.
  assert.equal(unclosed.closureDueLevel, 'terminal_no_conclusion');

  // The old hasConclusion-based rule is superseded: a terminal card WITH a
  // conclusion text but NO closure record is still NOT closed.
  const textOnly = deriveCardState({ ...DERIVE_BASE('failed'), closureConclusion: 'some note' });
  assert.equal(textOnly.cardState, 'waiting_decision', 'text without a closure record is not acceptance');
  assert.equal(textOnly.closureWarn, true);
  assert.equal(textOnly.closureDueLevel, 'terminal_no_conclusion');
});

test('v1.4: the terminal_no_conclusion suggestion reads the closure record (A-6 pairing holds)', () => {
  // Reason and suggestion must stay the two homes of ONE fact: the derivation
  // fires both exactly when terminal && closure_at IS NULL.
  const unclosed = deriveCardState(DERIVE_BASE('failed'));
  assert.ok(unclosed.reasonCodes.some((fact) => fact.code === 'terminal_without_conclusion'));
  assert.equal(unclosed.closureSuggestionCode, 'terminal_no_conclusion');

  const closed = deriveCardState({ ...DERIVE_BASE('failed'), closureAt: '2026-09-16T00:00:00.000Z' });
  assert.equal(closed.closureDue, false);
  assert.equal(closed.closureSuggestionCode, null);
  assert.equal(closed.reasonCodes.some((fact) => fact.code === 'terminal_without_conclusion'), false);
});

/** Drive a group task to `review` with every step settled (waiting_input). */
function driveGroupTaskToReview(h, suffix) {
  const groupTask = h.groupTaskStore.createTask({
    groupId: `gt-${suffix}`,
    title: `group task ${suffix}`,
    goal: `goal ${suffix}`,
    chairMetabotId: 1,
    createdBy: 'user',
  });
  const canonical = h.bridge.ensureCanonicalTask(groupTask.id);
  // The legal chair-driven path is planning -> executing -> review.
  h.groupTaskStore.updateTaskStatus(groupTask.id, 'executing');
  h.bridge.syncStatus(groupTask.id);
  h.groupTaskStore.updateTaskStatus(groupTask.id, 'review');
  h.bridge.syncStatus(groupTask.id);
  return { groupTask, canonical };
}

test('v1.4: closing a group-task-linked card accepts it through the bridge (acceptance = closure)', async () => {
  const h = await openBoardWithBridge();
  try {
    const { groupTask, canonical } = driveGroupTaskToReview(h, 'accept');
    // Canonical -> review with no unfinished steps, via the real bridge flow.
    h.groupTaskStore.updateTaskStatus(groupTask.id, 'review');
    h.bridge.syncStatus(groupTask.id);
    assert.equal(h.orchestrationStore.getTask(canonical.id).status, 'review');

    // Owner closes the card with NO conclusion: acceptance only.
    const result = h.board.closeCard({ taskId: canonical.id, conclusion: null, by: 'owner' });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.card.state, 'closed');
    assert.equal(result.card.closureConclusion, null, 'acceptance without an instruction stays NULL');
    assert.equal(h.groupTaskStore.getTaskById(groupTask.id).status, 'done', 'the group task catches up to done');
    assert.equal(h.orchestrationStore.getTask(canonical.id).status, 'completed');
    assert.equal(result.statusMoved, true, 'the bridge moved the canonical out of review');

    // The acceptance must NOT join the execution queue.
    const queue = h.board.listPendingClosures();
    assert.equal(queue.items.filter((item) => item.cardId === canonical.id).length, 0);
  } finally {
    h.sqliteStore.close();
  }
});

test('v1.4: closing with a conclusion through the bridge keeps the instruction queued (T1)', async () => {
  const h = await openBoardWithBridge();
  try {
    const { groupTask, canonical } = driveGroupTaskToReview(h, 'instruction');
    h.groupTaskStore.updateTaskStatus(groupTask.id, 'review');
    h.bridge.syncStatus(groupTask.id);

    const result = h.board.closeCard({
      taskId: canonical.id,
      conclusion: 'archive the artifacts, then report back',
      by: 'owner',
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.card.closureConclusion, 'archive the artifacts, then report back');
    assert.equal(h.groupTaskStore.getTaskById(groupTask.id).status, 'done');

    // The owner's instruction re-enters (or enters) the execution queue.
    const queue = h.board.listPendingClosures();
    const queued = queue.items.find((item) => item.cardId === canonical.id);
    assert.ok(queued, 'the closing instruction must be queued for the Twin');
    assert.equal(queued.conclusion, 'archive the artifacts, then report back');
    assert.equal(queued.closureBy, 'owner');
  } finally {
    h.sqliteStore.close();
  }
});

test('v1.4: a bridge refusal (unfinished steps) rejects the WHOLE card — nothing is written', async () => {
  const h = await openBoardWithBridge();
  try {
    const { groupTask, canonical } = driveGroupTaskToReview(h, 'blocked');
    // A live queued attempt on the step keeps it "unfinished" for acceptance.
    const started = h.bridge.beginWorkerAttempt({
      groupTaskId: groupTask.id,
      workerMetabotId: 2,
      objective: 'still working',
      sourceMessageKey: 'unfinished-i0',
    });
    assert.equal(started.attempt.status, 'queued');
    h.groupTaskStore.updateTaskStatus(groupTask.id, 'review');

    const groupStatusBefore = h.groupTaskStore.getTaskById(groupTask.id).status;
    const canonicalStatusBefore = h.orchestrationStore.getTask(canonical.id).status;
    const result = h.board.closeCard({ taskId: canonical.id, conclusion: 'too early', by: 'owner' });
    assert.equal(result.ok, false, 'an unfinished group task must refuse the close');
    assert.equal(result.code, 'VALIDATION');
    assert.match(result.error, /unfinished canonical step/i, 'the bridge error surfaces verbatim');

    // Byte-identical refusal: no closure column, no status change anywhere.
    const raw = h.db.exec(
      'SELECT closure_conclusion, closure_by, closure_at FROM orchestration_tasks WHERE id = ?',
      [canonical.id],
    )[0].values[0];
    assert.deepEqual([...raw], [null, null, null], 'no closure column may move on a refused close');
    assert.equal(h.orchestrationStore.getTask(canonical.id).status, canonicalStatusBefore);
    assert.equal(h.groupTaskStore.getTaskById(groupTask.id).status, groupStatusBefore);
  } finally {
    h.sqliteStore.close();
  }
});

test('v1.4: closing a group-task card as cancelled rides cancelGroupTask cascade', async () => {
  const h = await openBoardWithBridge();
  try {
    const { groupTask, canonical } = driveGroupTaskToReview(h, 'cancel');
    const started = h.bridge.beginWorkerAttempt({
      groupTaskId: groupTask.id,
      workerMetabotId: 2,
      objective: 'long running',
      sourceMessageKey: 'cancel-close-i0',
    });
    h.bridge.markWorkerAttemptRunning(started.attempt.id, 'session-cancel');

    const result = h.board.closeCard({
      taskId: canonical.id,
      conclusion: null,
      by: 'owner',
      targetStatus: 'cancelled',
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(h.groupTaskStore.getTaskById(groupTask.id).status, 'cancelled');
    assert.equal(h.orchestrationStore.getTask(canonical.id).status, 'cancelled');
    assert.equal(h.orchestrationStore.getAttempt(started.attempt.id).status, 'cancelled', 'the cascade reaches attempts');
    assert.equal(result.card.state, 'closed');
    assert.equal(result.card.closureConclusion, null);
  } finally {
    h.sqliteStore.close();
  }
});

test('v1.4: without a bridge (or without a group-task link) closeCard keeps the legacy behavior', async () => {
  const h = await openBoardWithBridge();
  // Deliberately NO resolveGroupTaskBridge: the v1.4 linkage is inert.
  const legacyBoard = new TrackedTaskBoardService({
    db: h.db,
    orchestrationStore: h.orchestrationStore,
    saveDb: h.sqliteStore.getSaveFunction(),
  });
  try {
    const { groupTask, canonical } = driveGroupTaskToReview(h, 'legacy');
    h.groupTaskStore.updateTaskStatus(groupTask.id, 'review');
    h.bridge.syncStatus(groupTask.id);

    const result = legacyBoard.closeCard({ taskId: canonical.id, conclusion: 'legacy close', by: 'owner' });
    assert.equal(result.ok, true, result.error);
    assert.equal(h.orchestrationStore.getTask(canonical.id).status, 'completed', 'legacy whitelist move still applies');
    assert.equal(result.card.closureConclusion, 'legacy close');
    // The group task is untouched: the group-side sync is the self-heal's job.
    assert.equal(h.groupTaskStore.getTaskById(groupTask.id).status, 'review');

    // Same for a plain unlinked card: nothing regressed.
    const plain = h.orchestrationStore.createTask({
      ownerIntent: 'plain card',
      twinMetabotId: 1,
      ownerGlobalMetaId: 'gmid-owner',
    });
    const plainClose = legacyBoard.closeCard({ taskId: plain.id, conclusion: null, by: 'owner' });
    assert.equal(plainClose.ok, true, plainClose.error);
    assert.equal(plainClose.card.closureConclusion, null);
    assert.equal(h.orchestrationStore.getTask(plain.id).status, 'completed');
  } finally {
    h.sqliteStore.close();
  }
});

// ============================================================================
// v1.5 (owner ruling 「谁发起，谁验收」): the ledger's origin column, the
// read-time closerRole derivation, the BIDIRECTIONAL close guard, and the
// Twin self-closure semantics. The invariants here are load-bearing: the
// pending-closure queue and the owner's closure surfaces must never contain
// a Twin-delegated card.
// ============================================================================

test('v1.5 origin: createTask persists twin_delegate, defaults to owner, and the startup migration backfills the six pre-v1.5 Twin cards BY ID', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-tracked-origin-'));
  // The frozen pre-v1.5 legacy window (TWIN_DELEGATED_CARD_IDS in
  // src/main/sqliteStore.ts): two cards from the 2026-09-18 night + three
  // created 2026-09-19 morning on the v1.4 binary via delegateLocalWorker +
  // the 2026-09-19 midday backfill-extension card, also created on the v1.4
  // binary after the list was first frozen at five.
  const legacyRows = [
    ['14cabbdc-27f0-4a76-9a2c-f7f76c5673a6', 'pre-migration twin card A', '2026-09-18T21:00:00.000Z'],
    ['f1128a6c-3559-44ae-b022-8d50d87519b9', 'pre-migration twin card B', '2026-09-18T22:00:00.000Z'],
    ['6f1038f7-7195-4049-aacd-ceab785282ff', 'pre-migration twin card C (v1.5 mainline)', '2026-09-19T03:05:00.000Z'],
    ['f1a201c3-0e40-4891-a8b7-2a2c583f534d', 'pre-migration twin card D (ack-entry patch)', '2026-09-19T03:30:00.000Z'],
    ['59d0709e-f3ff-4a03-bccd-09b7117c8f10', 'pre-migration twin card E (v1.5 acceptance)', '2026-09-19T03:58:00.000Z'],
    ['a06f8480-ad1a-4ea4-8d3e-bc4f6a490ed2', 'pre-migration twin card F (backfill extension)', '2026-09-19T04:28:30.000Z'],
  ];
  const first = await SqliteStore.create(dir);
  try {
    // Rows written BEFORE the origin migration ever saw them: default 'owner'.
    for (const [id, intent, at] of [...legacyRows, ['owner-row-control', 'an ordinary owner row', '2026-09-18T23:00:00.000Z']]) {
      first.getDatabase().run(
        `INSERT INTO orchestration_tasks
           (id, owner_intent, twin_metabot_id, owner_global_meta_id, status, created_at, updated_at)
         VALUES (?, ?, 1, 'owner-global', 'review', ?, ?)`,
        [id, intent, at, at],
      );
    }
  } finally {
    first.close();
  }

  // Re-opening the SAME database re-runs the startup migrations.
  const second = await SqliteStore.create(dir);
  try {
    const db = second.getDatabase();
    const originOf = (id) => {
      const row = db.exec('SELECT origin FROM orchestration_tasks WHERE id = ?', [id]);
      return String(row[0]?.values?.[0]?.[0]);
    };
    assert.equal(legacyRows.length, 6, 'the fixture stays in lockstep with the frozen six-id legacy-window list');
    for (const [id] of legacyRows) {
      assert.equal(originOf(id), 'twin_delegate', `legacy card ${id} must flip BY ID`);
    }
    assert.equal(originOf('owner-row-control'), 'owner',
      'the backfill is precise: no other row may flip');

    // The store API: explicit origin persists, omitted origin defaults.
    const orchestrationStore = new OrchestrationStore(db, second.getSaveFunction());
    const twin = orchestrationStore.createTask({
      ownerIntent: 'twin-delegated probe', twinMetabotId: 1, ownerGlobalMetaId: 'owner-global',
      origin: 'twin_delegate',
    });
    const plain = orchestrationStore.createTask({
      ownerIntent: 'owner probe', twinMetabotId: 1, ownerGlobalMetaId: 'owner-global',
    });
    assert.equal(orchestrationStore.getTask(twin.id).origin, 'twin_delegate');
    assert.equal(orchestrationStore.getTask(plain.id).origin, 'owner');
    // Fail-safe read: anything that is not the exact literal reads as owner.
    assert.equal(orchestrationStore.getTask('owner-row-control').origin, 'owner');
  } finally {
    second.close();
  }

  // Idempotency gate: a THIRD startup over the already-migrated database must
  // move nothing — backfilled rows no longer match `origin = 'owner'`, and the
  // control row still reads owner.
  const third = await SqliteStore.create(dir);
  try {
    const db3 = third.getDatabase();
    const originOf3 = (id) => {
      const row = db3.exec('SELECT origin FROM orchestration_tasks WHERE id = ?', [id]);
      return String(row[0]?.values?.[0]?.[0]);
    };
    for (const [id] of legacyRows) {
      assert.equal(originOf3(id), 'twin_delegate', `idempotent re-run keeps ${id} flipped exactly once`);
    }
    assert.equal(originOf3('owner-row-control'), 'owner',
      'idempotent re-run keeps the control row owner');
  } finally {
    third.close();
  }
});

test('v1.5 closerRole: derived at read time — group creator wins, scheduled stays owner, plain cards follow origin', async () => {
  const { sqliteStore, board, orchestrationStore } = await openBoard();
  try {
    const closerRoleOf = (id) => cardById(board, id).closerRole;
    // Group branch — the SAME created_by='user' criterion as ADM-5:
    assert.equal(closerRoleOf('seed-task-35'), 'owner', 'user-created group card is owner-closable');
    assert.equal(closerRoleOf('seed-task-31'), 'twin', 'twin-created group card is twin-closable');
    assert.equal(closerRoleOf('seed-task-34'), 'twin', 'checkpoint group card, twin-created, is twin-closable');
    // Scheduled branch — conservative:
    assert.equal(closerRoleOf('seed-task-32'), 'owner', 'scheduled-linked cards stay owner-closable');
    // Origin branch — plain session cards default to owner:
    assert.equal(closerRoleOf('seed-task-01'), 'owner', 'legacy default-origin cards stay owner-closable');

    // An admitted twin-delegated card derives 'twin' from its origin column.
    const twinCard = orchestrationStore.createTask({
      ownerIntent: 'twin-origin probe card', twinMetabotId: 1, ownerGlobalMetaId: 'owner-global',
      sourceSessionId: 'probe-session-closerole', origin: 'twin_delegate',
    });
    board.registerLongTask(twinCard.id);
    assert.equal(closerRoleOf(twinCard.id), 'twin', 'origin=twin_delegate flips the plain card');
  } finally {
    sqliteStore.close();
  }
});

test('v1.5 visibility: a twin-delegated card never turns closureDue — no red badge fact, no banner count, no suggestion', async () => {
  const { sqliteStore, board, orchestrationStore } = await openBoard();
  try {
    const baseline = board.listCards({ scope: 'all' });
    // A differential pair: SAME shape (registered + terminal + unclosed),
    // different origin. The ONLY allowed difference in output is closerRole.
    const mk = (intent, origin) => {
      const task = orchestrationStore.createTask({
        ownerIntent: intent, twinMetabotId: 1, ownerGlobalMetaId: 'owner-global',
        sourceSessionId: `probe-session-${intent}`, origin,
      });
      orchestrationStore.updateTaskStatus(task.id, 'completed'); // planning -> completed: terminal, unclosed
      board.registerLongTask(task.id); // ADM-1
      return task.id;
    };
    const ownerId = mk('probe owner card', 'owner');
    const twinId = mk('probe twin card', 'twin_delegate');

    const ownerCard = cardById(board, ownerId);
    const twinCard = cardById(board, twinId);
    assert.equal(ownerCard.closerRole, 'owner');
    assert.equal(twinCard.closerRole, 'twin');
    assert.equal(ownerCard.state, 'waiting_decision', 'both cards sit in the same state column');
    assert.equal(twinCard.state, 'waiting_decision', 'the twin card stays VISIBLE in its state column');
    assert.equal(ownerCard.closureDue, true, 'the owner card is due (terminal_no_conclusion)');
    assert.equal(ownerCard.closureDueLevel, 'terminal_no_conclusion');
    assert.equal(twinCard.closureDue, false, 'the twin card is NEVER due for the owner');
    assert.equal(twinCard.closureDueLevel, null);
    assert.equal(twinCard.closureSuggestionCode, null, 'no closure suggestion for the owner on a twin card');

    // Board-wide surfaces the banner reads — differential against the baseline
    // taken before the probes existed: adding TWO identical terminal-unclosed
    // cards moves counts.closureDue by EXACTLY ONE (the owner probe), and the
    // banner id set can never contain the twin card.
    const after = board.listCards({ scope: 'all' });
    assert.equal(after.counts.closureDue, baseline.counts.closureDue + 1,
      'only the OWNER probe may join counts.closureDue');
    assert.equal(after.closureDueCardIdsPage.includes(twinId), false,
      'the banner id set excludes the twin card');
    assert.equal(after.closureDueCardIdsPage.includes(ownerId), true,
      'the differential control proves the gate is closerRole, nothing else');
  } finally {
    sqliteStore.close();
  }
});

test('v1.5 guard: closing the OTHER side\'s card is refused VALIDATION with nothing written', async () => {
  const { sqliteStore, board, orchestrationStore } = await openBoard();
  try {
    // owner card closed by twin -> refused
    const overreachTwin = board.closeCard({ taskId: 'seed-task-01', conclusion: 'twin overreach', by: 'twin' });
    assert.equal(overreachTwin.ok, false);
    assert.equal(overreachTwin.code, 'VALIDATION');
    assert.match(overreachTwin.error, /closable by 'owner' only/);
    assert.equal(orchestrationStore.hasClosureRecord('seed-task-01'), false, 'nothing was written');
    assert.equal(orchestrationStore.getTask('seed-task-01').status, 'review', 'status untouched');

    // twin-delegated card closed by owner -> refused
    const twinCard = orchestrationStore.createTask({
      ownerIntent: 'twin guard probe', twinMetabotId: 1, ownerGlobalMetaId: 'owner-global',
      sourceSessionId: 'probe-session-guard', origin: 'twin_delegate',
    });
    orchestrationStore.updateTaskStatus(twinCard.id, 'completed');
    board.registerLongTask(twinCard.id);
    const overreachOwner = board.closeCard({ taskId: twinCard.id, conclusion: null, by: 'owner' });
    assert.equal(overreachOwner.ok, false);
    assert.equal(overreachOwner.code, 'VALIDATION');
    assert.match(overreachOwner.error, /closable by 'twin' only/);
    assert.equal(orchestrationStore.hasClosureRecord(twinCard.id), false);

    // group branch of the guard: the creator decides, bidirectionally
    const ownerGroup = board.closeCard({ taskId: 'seed-task-35', conclusion: null, by: 'twin' });
    assert.equal(ownerGroup.code, 'VALIDATION', 'user-created group card refuses the twin');
    const twinGroup = board.closeCard({ taskId: 'seed-task-31', conclusion: null, by: 'owner' });
    assert.equal(twinGroup.code, 'VALIDATION', 'twin-created group card refuses the owner');
    assert.equal(orchestrationStore.hasClosureRecord('seed-task-35'), false);
    assert.equal(orchestrationStore.hasClosureRecord('seed-task-31'), false);
  } finally {
    sqliteStore.close();
  }
});

test('v1.5 twin self-closure: one statement writes the closure AND its processed mark — the queue can never see it', async () => {
  const { closureHash } = v12;
  const { sqliteStore, board, orchestrationStore } = await openBoard();
  try {
    const db = sqliteStore.getDatabase();
    clearClosures(db);
    const twinCard = orchestrationStore.createTask({
      ownerIntent: 'twin self-close probe', twinMetabotId: 1, ownerGlobalMetaId: 'owner-global',
      sourceSessionId: 'probe-session-self', origin: 'twin_delegate',
    });
    orchestrationStore.updateTaskStatus(twinCard.id, 'completed');
    board.registerLongTask(twinCard.id);

    const CONCLUSION = 'worker delivered; verified against acceptance criteria';
    const closed = board.closeCard({
      taskId: twinCard.id,
      conclusion: CONCLUSION,
      by: 'twin',
    });
    assert.equal(closed.ok, true, closed.error);
    assert.equal(closed.card.state, 'closed');
    assert.equal(closed.card.closureRecorded, true, 'P2: the closure RECORD fact is surfaced');
    assert.equal(closed.card.closureProcessedBy, 'twin', 'self-closure carries its own processed mark');
    assert.ok(closed.card.closureProcessedAt, 'processed_at written in the same statement');
    assert.equal(closed.card.closurePending, false, 'never pending');

    // The DB row: hash-bound to the exact conclusion text.
    const mark = db.exec(
      'SELECT closure_processed_by, closure_processed_hash, closure_receipt FROM orchestration_tasks WHERE id = ?',
      [twinCard.id],
    )[0].values[0];
    assert.equal(String(mark[0]), 'twin');
    assert.equal(String(mark[1]), closureHash(CONCLUSION));
    assert.equal(mark[2], null, 'no separate receipt: the self-close IS the write-off');

    // THE invariant: the conclusion IS on the ledger (the raw candidate SQL
    // sees it — nothing was silently dropped), yet the DERIVED queue never
    // contains the card: the self-written hash mark is the only thing that
    // excludes it. Pinned so a future queue-query change cannot silently
    // resurrect twin self-closures.
    assert.equal(queueIds(db).includes(twinCard.id), true,
      'raw candidate: the self-closed conclusion is a real ledger row');
    const queue = board.listPendingClosures();
    assert.equal(queue.items.some((item) => item.cardId === twinCard.id), false,
      'the derived queue excludes the self-processed conclusion');
    assert.equal(queue.count, 0, 'with the seeds cleared, the queue is empty');

    // Blank-conclusion self-close: nothing to execute, still never queues.
    const blankCard = orchestrationStore.createTask({
      ownerIntent: 'twin blank self-close', twinMetabotId: 1, ownerGlobalMetaId: 'owner-global',
      sourceSessionId: 'probe-session-self-blank', origin: 'twin_delegate',
    });
    orchestrationStore.updateTaskStatus(blankCard.id, 'cancelled');
    board.registerLongTask(blankCard.id);
    const blank = board.closeCard({ taskId: blankCard.id, conclusion: '   ', by: 'twin' });
    assert.equal(blank.ok, true, blank.error);
    const blankHash = db.exec(
      'SELECT closure_processed_hash FROM orchestration_tasks WHERE id = ?',
      [blankCard.id],
    )[0].values[0][0];
    assert.equal(blankHash, null, 'no conclusion -> no hash mark (the summary never carried one)');
    assert.equal(board.listPendingClosures().items.some((item) => item.cardId === blankCard.id), false);
  } finally {
    sqliteStore.close();
  }
});

test('v1.5 closureRecorded (P2): the summary surfaces the closure record before and after a close', async () => {
  const { sqliteStore, board } = await openBoard();
  try {
    const before = cardById(board, 'seed-task-09');
    assert.equal(before.closureRecorded, false, 'an open card carries no closure record');
    const closed = board.closeCard({ taskId: 'seed-task-09', conclusion: 'accepted', by: 'owner' });
    assert.equal(closed.ok, true, closed.error);
    assert.equal(closed.card.closureRecorded, true);
    assert.equal(cardById(board, 'seed-task-09').closureRecorded, true,
      'the board read derives the same fact after the close');
    const detail = board.getCard('seed-task-09');
    assert.equal(detail.closureRecorded, true, 'the detail projection surfaces it too');
  } finally {
    sqliteStore.close();
  }
});

test('v1.5 pure derivation: deriveCloserRole precedence is group > scheduled > origin', () => {
  const { deriveCloserRole } = v12;
  const F = (groupOwnerInitiated, groupLinks, scheduledLinks) => ({
    groupOwnerInitiated, groupLinks, scheduledLinks,
  });
  assert.equal(deriveCloserRole(F(1, 2, 1), 'twin_delegate'), 'owner', 'group creator wins over everything');
  assert.equal(deriveCloserRole(F(0, 2, 1), 'twin_delegate'), 'twin', 'non-user group creator = twin');
  assert.equal(deriveCloserRole(F(0, 0, 1), 'twin_delegate'), 'owner', 'scheduled stays owner (conservative)');
  assert.equal(deriveCloserRole(F(0, 0, 0), 'twin_delegate'), 'twin', 'origin decides the plain card');
  assert.equal(deriveCloserRole(F(0, 0, 0), 'owner'), 'owner');
  assert.equal(deriveCloserRole(F(0, 0, 0), null), 'owner', 'missing origin fails safe to owner');
  assert.equal(deriveCloserRole(F(0, 0, 0), undefined), 'owner');
  assert.equal(deriveCloserRole(F(0, 0, 0), 'twin_delegate '), 'owner', 'exact literal only — no trim leniency');
});

/* ------------------------------------------------------------------------- *
 * v1.5 last mile (owner ruling 「谁发起，谁验收」): the ACK channel itself
 * gains the Twin self-closure entrance. closeCard could already write the
 * twin self-closure, but the Twin's ONLY session tools are
 * list_pending_card_closures + acknowledge_card_closure — without the ack
 * entrance a terminal twin-delegated card with no conclusion could never be
 * closed by anyone. The rules below pin the whole shape: who may, on which
 * cards, with which receipt, and what can never happen afterwards.
 * ------------------------------------------------------------------------- */

function insertGroupLink(db, taskId, createdBy) {
  db.run(
    `INSERT INTO group_tasks (orchestration_task_id, title, goal, chair_metabot_id, created_by, status)
     VALUES (?, 'probe group', 'probe goal', 1, ?, 'done')`,
    [taskId, createdBy],
  );
}

test('v1.5 last mile: the ack channel self-closes a terminal twin-delegated card with no conclusion — the receipt IS the conclusion, marked processed in the same statement', async () => {
  const { closureHash } = v12;
  const { sqliteStore, board, orchestrationStore } = await openBoard();
  try {
    const db = sqliteStore.getDatabase();
    clearClosures(db);
    const twinCard = orchestrationStore.createTask({
      ownerIntent: 'twin ack self-close probe', twinMetabotId: 1, ownerGlobalMetaId: 'owner-global',
      sourceSessionId: 'probe-session-ack-self', origin: 'twin_delegate',
    });
    orchestrationStore.updateTaskStatus(twinCard.id, 'completed');
    board.registerLongTask(twinCard.id);

    const RECEIPT = 'worker delivered on session probe-session-ack-self; acceptance criteria re-checked';
    const first = board.acknowledgeClosure({
      taskId: twinCard.id,
      processedBy: 'twin',
      receipt: RECEIPT,
      evidenceUri: 'sha256:deadbeef',
    });
    assert.equal(first.ok, true, first.error);
    assert.equal(first.alreadyProcessed, false);
    assert.equal(first.processedBy, 'twin');
    assert.ok(first.processedAt);
    assert.equal(first.receipt, RECEIPT);

    // Same-statement write-off, identical to closeCard's twin branch:
    // conclusion == receipt, closure_by == processed_by == 'twin', the mark
    // is hash-bound, and closure_at == processed_at proves ONE statement.
    const row = db.exec(
      'SELECT closure_conclusion, closure_by, closure_processed_by, closure_processed_hash,'
      + ' closure_at, closure_processed_at, closure_receipt FROM orchestration_tasks WHERE id = ?',
      [twinCard.id],
    )[0].values[0];
    assert.equal(row[0], RECEIPT, 'the receipt became the card conclusion');
    assert.equal(row[1], 'twin');
    assert.equal(row[2], 'twin');
    assert.equal(row[3], closureHash(RECEIPT));
    assert.equal(row[5], row[4], 'closure_at == processed_at: one statement wrote both');
    assert.equal(row[6], null, 'no separate receipt column: the self-close IS the write-off');

    // THE invariant, pinned: the self-written conclusion is a real ledger row
    // yet never queues — and after the self-closure the card is gone from
    // listPendingClosures for good.
    assert.equal(queueIds(db).includes(twinCard.id), true,
      'raw candidate: the self-closed conclusion is on the ledger');
    assert.equal(board.listPendingClosures().items.some((item) => item.cardId === twinCard.id), false,
      'the derived queue never contains the self-closed card');

    // Idempotence: a repeat ack on the self-closed card reports the existing
    // mark and rewrites NOTHING (closure_at / processed_at / receipt intact).
    const before = db.exec(
      'SELECT closure_at, closure_processed_at, closure_receipt FROM orchestration_tasks WHERE id = ?',
      [twinCard.id],
    )[0].values[0];
    const second = board.acknowledgeClosure({
      taskId: twinCard.id,
      processedBy: 'twin',
      receipt: 'a different retry wording',
      evidenceUri: 'sha256:deadbeef',
    });
    assert.equal(second.ok, true);
    assert.equal(second.alreadyProcessed, true);
    assert.equal(second.processedBy, 'twin');
    assert.equal(second.receipt, null, 'the write-off cleared the receipt column; the read-back is honest');
    const after = db.exec(
      'SELECT closure_at, closure_processed_at, closure_receipt FROM orchestration_tasks WHERE id = ?',
      [twinCard.id],
    )[0].values[0];
    assert.deepEqual(after, before, 'the repeat rewrote nothing');
  } finally {
    sqliteStore.close();
  }
});

test('v1.5 last mile: the ack self-closure reads the SAME closerRole derivation — a group-created card routes by its creator, bidirectionally', async () => {
  const { sqliteStore, board, orchestrationStore } = await openBoard();
  try {
    const db = sqliteStore.getDatabase();
    clearClosures(db);

    // A bot-created group link (created_by != 'user') makes the card
    // twin-closable EVEN THOUGH the ledger origin says 'owner': the link
    // tables are the authority, exactly as for closeCard.
    const linkCard = orchestrationStore.createTask({
      ownerIntent: 'group-created twin card via origin owner', twinMetabotId: 1,
      ownerGlobalMetaId: 'owner-global', sourceSessionId: 'probe-session-ack-group',
      origin: 'owner',
    });
    orchestrationStore.updateTaskStatus(linkCard.id, 'completed');
    board.registerLongTask(linkCard.id);
    insertGroupLink(db, linkCard.id, 'chair-bot');
    const groupSelf = board.acknowledgeClosure({
      taskId: linkCard.id, processedBy: 'twin',
      receipt: 'group task delivered; self-closing the delegation', evidenceUri: 'pin://group-evidence',
    });
    assert.equal(groupSelf.ok, true, groupSelf.error);
    assert.equal(groupSelf.processedBy, 'twin');

    // The mirror: a user-created group link keeps the card owner-only, and
    // the ack on the other side is refused with nothing written.
    const ownerLinkCard = orchestrationStore.createTask({
      ownerIntent: 'user-created group card', twinMetabotId: 1,
      ownerGlobalMetaId: 'owner-global', sourceSessionId: 'probe-session-ack-group-owner',
      origin: 'twin_delegate',
    });
    orchestrationStore.updateTaskStatus(ownerLinkCard.id, 'completed');
    board.registerLongTask(ownerLinkCard.id);
    insertGroupLink(db, ownerLinkCard.id, 'user');
    const overreach = board.acknowledgeClosure({
      taskId: ownerLinkCard.id, processedBy: 'twin',
      receipt: 'twin must not self-close a user-created group card', evidenceUri: 'pin://x',
    });
    assert.equal(overreach.ok, false);
    assert.equal(overreach.code, 'NO_CONCLUSION');
    assert.equal(orchestrationStore.hasClosureRecord(ownerLinkCard.id), false, 'nothing written');
  } finally {
    sqliteStore.close();
  }
});

test('v1.5 last mile: every refusal keeps its shape — owner card NO_CONCLUSION (v1.4 verbatim), open twin card VALIDATION, receipts still validated, nothing written', async () => {
  const { sqliteStore, board, orchestrationStore } = await openBoard();
  try {
    const db = sqliteStore.getDatabase();
    clearClosures(db);

    // owner card, no conclusion: the v1.4 refusal, VERBATIM — the Twin never
    // writes a conclusion on the owner's behalf, no matter the receipt.
    for (const processedBy of ['twin', 'owner']) {
      const refusal = board.acknowledgeClosure({
        taskId: 'seed-task-01', processedBy,
        receipt: 'record-only, no action required',
      });
      assert.equal(refusal.ok, false, `processedBy=${processedBy}`);
      assert.equal(refusal.code, 'NO_CONCLUSION', `processedBy=${processedBy}`);
      assert.match(refusal.error, /no closing conclusion/);
    }
    assert.equal(orchestrationStore.hasClosureRecord('seed-task-01'), false, 'nothing written');

    // twin-delegated card that is NOT terminal: VALIDATION — a self-closure
    // is an execution write-off, and nothing has finished yet.
    const openTwin = orchestrationStore.createTask({
      ownerIntent: 'twin ack on an open card', twinMetabotId: 1, ownerGlobalMetaId: 'owner-global',
      sourceSessionId: 'probe-session-ack-open', origin: 'twin_delegate',
    });
    board.registerLongTask(openTwin.id);
    const openRefusal = board.acknowledgeClosure({
      taskId: openTwin.id, processedBy: 'twin',
      receipt: 'premature write-off', evidenceUri: 'pin://y',
    });
    assert.equal(openRefusal.ok, false);
    assert.equal(openRefusal.code, 'VALIDATION');
    assert.match(openRefusal.error, /terminal/);
    assert.equal(orchestrationStore.hasClosureRecord(openTwin.id), false, 'nothing written');

    // The receipt contract still applies to a self-closure: blank receipts
    // and evidence-less receipts are refused before anything is written.
    for (const bad of [
      { receipt: '   ', evidenceUri: 'pin://z' },
      { receipt: 'did the work', evidenceUri: null },
    ]) {
      const badReceipt = board.acknowledgeClosure({ taskId: openTwin.id, processedBy: 'twin', ...bad });
      assert.equal(badReceipt.ok, false);
      assert.ok(badReceipt.code === 'VALIDATION' || badReceipt.code === 'RECEIPT_INCOMPLETE',
        `expected a refusal, got ${badReceipt.code}`);
    }
    assert.equal(orchestrationStore.hasClosureRecord(openTwin.id), false, 'still nothing written');

    // Positive control on the SAME card: once terminal, the marker receipt
    // (no evidence needed) self-closes — proving the VALIDATION refusals
    // above came from the terminal rule, not from the receipt checks.
    orchestrationStore.updateTaskStatus(openTwin.id, 'completed');
    const markerSelfClose = board.acknowledgeClosure({
      taskId: openTwin.id, processedBy: 'twin',
      receipt: 'record-only, no action required',
    });
    assert.equal(markerSelfClose.ok, true, markerSelfClose.error);
    assert.equal(markerSelfClose.processedBy, 'twin');
    assert.equal(board.listPendingClosures().items.some((item) => item.cardId === openTwin.id), false,
      'the marker self-closure never queues either');
  } finally {
    sqliteStore.close();
  }
});
