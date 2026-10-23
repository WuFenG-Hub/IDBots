// cowork_sessions.follow_up_state / follow_up_source / follow_up_at — the
// "Follow-Up Tasks" (待跟进任务) bucket for sessions that currently need a
// human decision or reply.
//
// Bot-created sessions (auto_origin set) fold into the collapsed "Autonomous
// Tasks" group by default; this column family moves a row into the parallel
// Follow-Up section while a decision is pending. Three lanes set the marker:
// 'cerebellum' (turn-end classifier), 'ask_user' (a pending AskUserQuestion),
// 'manual' (the owner moved the row). Manual pins are sticky — the classifier
// never overwrites or clears them.
//
// Contract under test:
//   a. the startup migration adds the three columns, leaves them NULL (no
//      backfill), and is idempotent across reopens;
//   b. setSessionFollowUp stamps state/source/at and round-trips through
//      getSession + listSessions (+ the archived mapper) and a reopen;
//   c. manual pins are sticky: a pending 'manual' is not overwritten by
//      'cerebellum'/'ask_user', but a manual write always lands;
//   d. clearSessionFollowUp without onlySources clears any pending; with
//      onlySources it clears only a matching lane;
//   e. createSession rows start with NULLs and the auto-origin fact on the
//      same row is untouched by follow-up writes;
//   f. clearStaleAskUserFollowUpsAfterRestart (the boot-time residue sweep)
//      clears only 'ask_user' markers — a pending AskUserQuestion cannot
//      survive a process restart — while cerebellum/manual rows stay pending,
//      the sweep is idempotent, and it leaves updated_at (session-list sort
//      order) untouched on every row;
//   g. CoworkRunner.clearPendingPermissions (the session-level terminal
//      teardown every DSH abort/error/crash/shutdown path runs) clears the
//      ask_user marker through the same lane-guarded store call, so a denied
//      pending ask can never leave a stale Follow-Up row behind.
//
// Runs against the compiled output (pnpm run compile:electron first).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getColumns, getCompiledStores, getRow, getSqlJs } from './memoryTestUtils.mjs';

const { SqliteStore, CoworkStore } = getCompiledStores();

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-follow-up-'));

const cleanupDir = (dir) => fs.rmSync(dir, { recursive: true, force: true });

/** Open (or create) the file-backed store the way a real startup does. */
async function openStartupStore(dir) {
  const SQL = await getSqlJs();
  const dbPath = path.join(dir, 'test.sqlite');
  const db = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database();
  const store = new SqliteStore(db, dbPath);
  store.initializeTables(dir);
  return store;
}

const followUpRowOf = (db, id) =>
  getRow(db, 'SELECT follow_up_state, follow_up_source, follow_up_at FROM cowork_sessions WHERE id = ?', [id])
    ?? { follow_up_state: null, follow_up_source: null, follow_up_at: null };

test('fresh DB: the three follow-up columns exist, are unbackfilled and every row starts clear', async () => {
  const dir = makeTempDir();
  const sqlite = await openStartupStore(dir);
  try {
    const columns = getColumns(sqlite.getDatabase(), 'cowork_sessions');
    assert.equal(columns.includes('follow_up_state'), true);
    assert.equal(columns.includes('follow_up_source'), true);
    assert.equal(columns.includes('follow_up_at'), true);

    const cowork = new CoworkStore(sqlite.getDatabase(), sqlite.getSaveFunction());
    const human = cowork.createSession('Human chat', dir);
    const delegated = cowork.createSession('[长期] Task · #1 Sub', dir, '', 'local', [], null, 'longterm');
    cowork.setSessionAutoOrigin(delegated.id, 'longterm');

    assert.equal(human.followUpState, null, 'createSession reports no follow-up');
    assert.equal(human.followUpSource, null);
    assert.equal(human.followUpAt, null);
    assert.deepEqual(followUpRowOf(sqlite.getDatabase(), human.id), {
      follow_up_state: null,
      follow_up_source: null,
      follow_up_at: null,
    });
    assert.deepEqual(followUpRowOf(sqlite.getDatabase(), delegated.id), {
      follow_up_state: null,
      follow_up_source: null,
      follow_up_at: null,
    });

    const summary = cowork.listSessions().find((row) => row.id === delegated.id);
    assert.equal(summary?.followUpState, null);
    assert.equal(summary?.followUpSource, null);
    assert.equal(summary?.followUpAt, null);
    assert.equal(summary?.autoOrigin, 'longterm', 'the origin fact is untouched');
  } finally {
    try { sqlite.close(); } catch { /* already closed */ }
    cleanupDir(dir);
  }
});

test('migration is idempotent: reopening an existing DB keeps values and adds nothing', async () => {
  const dir = makeTempDir();
  let sessionId = '';
  const sqlite = await openStartupStore(dir);
  try {
    const cowork = new CoworkStore(sqlite.getDatabase(), sqlite.getSaveFunction());
    const session = cowork.createSession('[定时] Nightly', dir, '', 'local', [], null, 'standard');
    cowork.setSessionAutoOrigin(session.id, 'schedule');
    cowork.setSessionFollowUp(session.id, 'cerebellum');
    sessionId = session.id;
  } finally {
    try { sqlite.close(); } catch { /* already closed */ }
  }

  // Second startup against the same file: the ALTER blocks must be no-ops and
  // the stamped row must survive untouched.
  const reopened = await openStartupStore(dir);
  try {
    const cowork = new CoworkStore(reopened.getDatabase(), reopened.getSaveFunction());
    const row = followUpRowOf(reopened.getDatabase(), sessionId);
    assert.equal(row.follow_up_state, 'pending');
    assert.equal(row.follow_up_source, 'cerebellum');
    assert.equal(typeof row.follow_up_at, 'string');
    assert.equal(cowork.getSession(sessionId)?.followUpState, 'pending');
    assert.equal(cowork.getSession(sessionId)?.followUpSource, 'cerebellum');
  } finally {
    try { reopened.close(); } catch { /* already closed */ }
    cleanupDir(dir);
  }
});

test('setSessionFollowUp round-trips through getSession + listSessions (+ archived mapper) and persists', async () => {
  const dir = makeTempDir();
  const sqlite = await openStartupStore(dir);
  let sessionId = '';
  try {
    const cowork = new CoworkStore(sqlite.getDatabase(), sqlite.getSaveFunction());
    const session = cowork.createSession('[定时] Nightly', dir, '', 'local', [], null, 'standard');
    cowork.setSessionAutoOrigin(session.id, 'schedule');
    sessionId = session.id;

    cowork.setSessionFollowUp(session.id, 'cerebellum');
    const row = followUpRowOf(sqlite.getDatabase(), session.id);
    assert.equal(row.follow_up_state, 'pending');
    assert.equal(row.follow_up_source, 'cerebellum');
    assert.match(row.follow_up_at, /^\d{4}-\d{2}-\d{2}T/, 'follow_up_at is an ISO timestamp');

    const loaded = cowork.getSession(session.id);
    assert.equal(loaded?.followUpState, 'pending');
    assert.equal(loaded?.followUpSource, 'cerebellum');
    assert.equal(typeof loaded?.followUpAt, 'string');

    const summary = cowork.listSessions().find((entry) => entry.id === session.id);
    assert.equal(summary?.followUpState, 'pending');
    assert.equal(summary?.followUpSource, 'cerebellum');

    // The archived mapper carries the same fields.
    cowork.archiveSession(session.id);
    const archived = cowork.listArchivedSessions().find((entry) => entry.id === session.id);
    assert.equal(archived?.followUpState, 'pending');
    assert.equal(archived?.followUpSource, 'cerebellum');
    cowork.unarchiveSession(session.id);
  } finally {
    try { sqlite.close(); } catch { /* already closed */ }
  }

  // Reopen from disk: the marker was written, not just held in memory.
  const reopened = await openStartupStore(dir);
  try {
    const cowork = new CoworkStore(reopened.getDatabase(), reopened.getSaveFunction());
    assert.equal(cowork.getSession(sessionId)?.followUpState, 'pending');
    assert.equal(
      cowork.listSessions().find((entry) => entry.id === sessionId)?.followUpSource,
      'cerebellum',
    );
  } finally {
    try { reopened.close(); } catch { /* already closed */ }
    cleanupDir(dir);
  }
});

test('manual pins are sticky: cerebellum/ask_user never overwrite a pending manual, manual always lands', async () => {
  const dir = makeTempDir();
  const sqlite = await openStartupStore(dir);
  try {
    const cowork = new CoworkStore(sqlite.getDatabase(), sqlite.getSaveFunction());
    const session = cowork.createSession('[长期] Task', dir, '', 'local', [], null, 'longterm');
    cowork.setSessionAutoOrigin(session.id, 'longterm');

    cowork.setSessionFollowUp(session.id, 'manual');
    cowork.setSessionFollowUp(session.id, 'cerebellum');
    assert.equal(
      cowork.getSession(session.id)?.followUpSource,
      'manual',
      'the classifier never overwrites a manual pin',
    );

    cowork.setSessionFollowUp(session.id, 'ask_user');
    assert.equal(cowork.getSession(session.id)?.followUpSource, 'manual');

    // A manual write over any other lane lands immediately.
    cowork.clearSessionFollowUp(session.id);
    cowork.setSessionFollowUp(session.id, 'cerebellum');
    assert.equal(cowork.getSession(session.id)?.followUpSource, 'cerebellum');
    cowork.setSessionFollowUp(session.id, 'manual');
    assert.equal(cowork.getSession(session.id)?.followUpSource, 'manual');
  } finally {
    try { sqlite.close(); } catch { /* already closed */ }
    cleanupDir(dir);
  }
});

test('clearSessionFollowUp without onlySources clears any pending (manual move-out)', async () => {
  const dir = makeTempDir();
  const sqlite = await openStartupStore(dir);
  try {
    const cowork = new CoworkStore(sqlite.getDatabase(), sqlite.getSaveFunction());
    const session = cowork.createSession('[长期] Task', dir, '', 'local', [], null, 'longterm');
    cowork.setSessionAutoOrigin(session.id, 'longterm');

    for (const source of ['cerebellum', 'ask_user', 'manual']) {
      cowork.setSessionFollowUp(session.id, source);
      cowork.clearSessionFollowUp(session.id);
      const loaded = cowork.getSession(session.id);
      assert.equal(loaded?.followUpState, null, `${source} cleared by the manual move-out`);
      assert.equal(loaded?.followUpSource, null);
      assert.equal(loaded?.followUpAt, null);
      assert.deepEqual(followUpRowOf(sqlite.getDatabase(), session.id), {
        follow_up_state: null,
        follow_up_source: null,
        follow_up_at: null,
      });
    }
  } finally {
    try { sqlite.close(); } catch { /* already closed */ }
    cleanupDir(dir);
  }
});

test('clearSessionFollowUp with onlySources clears only the matching lane', async () => {
  const dir = makeTempDir();
  const sqlite = await openStartupStore(dir);
  try {
    const cowork = new CoworkStore(sqlite.getDatabase(), sqlite.getSaveFunction());
    const session = cowork.createSession('[定时] Nightly', dir, '', 'local', [], null, 'standard');
    cowork.setSessionAutoOrigin(session.id, 'schedule');

    // Guarded clear misses a manual pin.
    cowork.setSessionFollowUp(session.id, 'manual');
    cowork.clearSessionFollowUp(session.id, { onlySources: ['cerebellum'] });
    assert.equal(cowork.getSession(session.id)?.followUpSource, 'manual', 'manual survives the classifier clear');
    cowork.clearSessionFollowUp(session.id, { onlySources: ['ask_user'] });
    assert.equal(cowork.getSession(session.id)?.followUpSource, 'manual', 'manual survives the ask clear');

    // Unguarded reset, then: an ask_user marker survives the classifier's
    // guarded clear.
    cowork.clearSessionFollowUp(session.id);
    cowork.setSessionFollowUp(session.id, 'cerebellum');
    cowork.setSessionFollowUp(session.id, 'ask_user');
    cowork.clearSessionFollowUp(session.id, { onlySources: ['cerebellum'] });
    assert.equal(cowork.getSession(session.id)?.followUpSource, 'ask_user', 'ask_user survives the classifier clear');

    // Matching lane clears; the row returns to the auto-origin policy.
    cowork.clearSessionFollowUp(session.id, { onlySources: ['ask_user'] });
    assert.equal(cowork.getSession(session.id)?.followUpState, null);
    assert.equal(cowork.getSession(session.id)?.followUpSource, null);

    // Unknown session ids are no-ops, not errors; an explicit empty lane list
    // matches no source and therefore clears nothing (only an ABSENT
    // onlySources means "clear any pending").
    cowork.clearSessionFollowUp('no-such-session', { onlySources: ['cerebellum'] });
    cowork.setSessionFollowUp(session.id, 'cerebellum');
    cowork.clearSessionFollowUp(session.id, { onlySources: [] });
    assert.equal(cowork.getSession(session.id)?.followUpSource, 'cerebellum', 'empty onlySources clears nothing');
  } finally {
    try { sqlite.close(); } catch { /* already closed */ }
    cleanupDir(dir);
  }
});

test('follow-up writes never touch the auto-origin or fold facts on the same row', async () => {
  const dir = makeTempDir();
  const sqlite = await openStartupStore(dir);
  try {
    const cowork = new CoworkStore(sqlite.getDatabase(), sqlite.getSaveFunction());
    const session = cowork.createSession('[长期] Task', dir, '', 'local', [], null, 'longterm');
    cowork.setSessionAutoOrigin(session.id, 'longterm');
    cowork.setSessionFoldOverride(session.id, 'in');

    cowork.setSessionFollowUp(session.id, 'cerebellum');
    cowork.clearSessionFollowUp(session.id, { onlySources: ['cerebellum'] });

    const loaded = cowork.getSession(session.id);
    assert.equal(loaded?.autoOrigin, 'longterm');
    assert.equal(loaded?.foldOverride, 'in');
    assert.equal(cowork.getSessionAutoOrigin(session.id), 'longterm');
  } finally {
    try { sqlite.close(); } catch { /* already closed */ }
    cleanupDir(dir);
  }
});

test('startup sweep clears only ask_user residue: cerebellum/manual stay pending, sweep is idempotent and persists', async () => {
  const dir = makeTempDir();
  let askA = '';
  let askB = '';
  let cerebellum = '';
  let manual = '';
  /** updated_at of every row, snapshotted after the writes and before the sweep. */
  let updatedAtBefore = new Map();
  const sqlite = await openStartupStore(dir);
  try {
    const cowork = new CoworkStore(sqlite.getDatabase(), sqlite.getSaveFunction());
    // Two auto-origin sessions parked by a pending AskUserQuestion, plus one
    // cerebellum verdict and one manual pin — as a previous process left them.
    askA = cowork.createSession('[长期] Ask A', dir, '', 'local', [], null, 'longterm').id;
    askB = cowork.createSession('[长期] Ask B', dir, '', 'local', [], null, 'longterm').id;
    cerebellum = cowork.createSession('[定时] Nightly', dir, '', 'local', [], null, 'standard').id;
    manual = cowork.createSession('[长期] Manual', dir, '', 'local', [], null, 'longterm').id;
    for (const id of [askA, askB, cerebellum, manual]) {
      cowork.setSessionFollowUp(id, 'ask_user');
    }
    cowork.setSessionFollowUp(cerebellum, 'cerebellum');
    cowork.setSessionFollowUp(manual, 'manual');
    updatedAtBefore = new Map(
      [askA, askB, cerebellum, manual].map((id) => [
        id,
        getRow(sqlite.getDatabase(), 'SELECT updated_at FROM cowork_sessions WHERE id = ?', [id])?.updated_at,
      ]),
    );
  } finally {
    try { sqlite.close(); } catch { /* already closed */ }
  }

  // "Restart": reopen the same file the way app startup does and run the
  // residue sweep on the fresh store.
  const reopened = await openStartupStore(dir);
  try {
    const cowork = new CoworkStore(reopened.getDatabase(), reopened.getSaveFunction());
    const cleared = cowork.clearStaleAskUserFollowUpsAfterRestart();
    assert.equal(cleared, 2, 'exactly the two ask_user rows are swept');

    for (const id of [askA, askB]) {
      assert.deepEqual(
        followUpRowOf(reopened.getDatabase(), id),
        { follow_up_state: null, follow_up_source: null, follow_up_at: null },
        'ask_user residue is cleared',
      );
    }
    assert.equal(
      cowork.getSession(cerebellum)?.followUpSource,
      'cerebellum',
      'a cerebellum verdict survives the sweep',
    );
    assert.equal(cowork.getSession(cerebellum)?.followUpState, 'pending');
    assert.equal(
      cowork.getSession(manual)?.followUpSource,
      'manual',
      'a manual pin survives the sweep',
    );
    assert.equal(cowork.getSession(manual)?.followUpState, 'pending');

    // The sweep is a pure follow-up-column reset: updated_at (and therefore
    // session-list sort order) must be untouched on every row, swept or not.
    for (const [id, before] of updatedAtBefore) {
      const after = getRow(reopened.getDatabase(), 'SELECT updated_at FROM cowork_sessions WHERE id = ?', [id])?.updated_at;
      assert.equal(after, before, `updated_at unchanged by the sweep for ${id}`);
    }

    assert.equal(
      cowork.clearStaleAskUserFollowUpsAfterRestart(),
      0,
      'second sweep is a no-op (idempotent)',
    );
  } finally {
    try { reopened.close(); } catch { /* already closed */ }
  }

  // The sweep is persisted, not just held in memory.
  const rereopened = await openStartupStore(dir);
  try {
    const cowork = new CoworkStore(rereopened.getDatabase(), rereopened.getSaveFunction());
    assert.equal(cowork.getSession(askA)?.followUpState, null);
    assert.equal(cowork.getSession(cerebellum)?.followUpSource, 'cerebellum');
    assert.equal(cowork.getSession(manual)?.followUpSource, 'manual');
    for (const [id, before] of updatedAtBefore) {
      const after = getRow(rereopened.getDatabase(), 'SELECT updated_at FROM cowork_sessions WHERE id = ?', [id])?.updated_at;
      assert.equal(after, before, `updated_at still unchanged after reopen for ${id}`);
    }
  } finally {
    try { rereopened.close(); } catch { /* already closed */ }
    cleanupDir(dir);
  }
});

test('runner terminal teardown: clearPendingPermissions clears the ask_user marker through the lane-guarded store call', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { CoworkRunner } = require('../dist-electron/main/libs/coworkRunner.js');

  const cleared = [];
  const fakeStore = new Proxy({}, {
    get: (_target, prop) => {
      if (prop === 'clearSessionFollowUp') {
        return (sessionId, opts) => cleared.push([sessionId, opts]);
      }
      return () => undefined;
    },
  });
  const runner = new CoworkRunner(fakeStore);
  // The session-level teardown every DSH terminal path (turn failure, stall
  // abort, DSH shutdown, turn crash, stop) runs — a pending ask is denied
  // here and can never be answered afterwards, so the persisted Follow-Up
  // marker must drop in the same beat (cerebellum/manual lanes untouched).
  runner.clearPendingPermissions('session-1');
  assert.deepEqual(
    cleared,
    [['session-1', { onlySources: ['ask_user'] }]],
    'terminal teardown clears ONLY the ask_user follow-up lane',
  );
});

test('runner source anchor: clearPendingPermissions itself calls clearAskUserFollowUp', () => {
  const source = fs.readFileSync(
    new URL('../src/main/libs/coworkRunner.ts', import.meta.url),
    'utf8',
  );
  const method = source.match(
    /private clearPendingPermissions\(sessionId: string\): void \{[\s\S]*?\n  \}/,
  );
  assert.ok(method, 'clearPendingPermissions method is present in the runner source');
  assert.match(
    method[0],
    /this\.clearAskUserFollowUp\(sessionId\);/,
    'the centralized teardown must clear the ask_user marker — otherwise a terminal cleanup leaves a stale Follow-Up row',
  );
});
