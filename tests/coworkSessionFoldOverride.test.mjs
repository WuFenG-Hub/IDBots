// cowork_sessions.fold_override — manual placement of a session in the
// sidebar's "Delegated Tasks" (委派任务) fold.
//
// The fold policy (long-term task runs + orchestration delegations) decides by
// default; this column lets the owner overrule it per row: 'out' pulls a
// delegated run back into the main conversation list, 'in' parks a human row in
// the fold, and NULL (every untouched row) hands the decision back to the
// policy. Pure renderer preference — the column never changes a session's
// content, status or origin marker.
//
// Contract under test:
//   a. the startup migration adds the column and leaves it NULL (no backfill);
//   b. setSessionFoldOverride round-trips through getSession + listSessions and
//      survives a reopen;
//   c. passing null clears the override back to NULL;
//   d. the auto-origin facts on the same row are untouched by a fold move.
//
// Runs against the compiled output (pnpm run compile:electron first).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getColumns, getCompiledStores, getRow, getSqlJs } from './memoryTestUtils.mjs';

const { SqliteStore, CoworkStore } = getCompiledStores();

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-fold-override-'));

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

const overrideOf = (db, id) =>
  getRow(db, 'SELECT fold_override FROM cowork_sessions WHERE id = ?', [id])?.fold_override ?? null;

test('fresh DB: fold_override exists, is unbackfilled and every row starts on the policy', async () => {
  const dir = makeTempDir();
  const sqlite = await openStartupStore(dir);
  try {
    assert.equal(getColumns(sqlite.getDatabase(), 'cowork_sessions').includes('fold_override'), true);

    const cowork = new CoworkStore(sqlite.getDatabase(), sqlite.getSaveFunction());
    // A human row and an auto-created row: neither carries an override until the
    // owner asks for one.
    const human = cowork.createSession('Human chat', dir);
    const delegated = cowork.createSession('[长期] Task · #1 Sub', dir, '', 'local', [], null, 'longterm');
    cowork.setSessionAutoOrigin(delegated.id, 'longterm');

    assert.equal(human.foldOverride, null, 'createSession reports no manual placement');
    assert.equal(overrideOf(sqlite.getDatabase(), human.id), null);
    assert.equal(overrideOf(sqlite.getDatabase(), delegated.id), null);

    const summary = cowork.listSessions().find((row) => row.id === delegated.id);
    assert.equal(summary?.foldOverride, null);
    assert.equal(summary?.autoOrigin, 'longterm', 'the creation fact is untouched');
  } finally {
    try { sqlite.close(); } catch { /* already closed */ }
    cleanupDir(dir);
  }
});

test('setSessionFoldOverride round-trips through getSession + listSessions, and persists', async () => {
  const dir = makeTempDir();
  const sqlite = await openStartupStore(dir);
  let delegatedId = '';
  try {
    const cowork = new CoworkStore(sqlite.getDatabase(), sqlite.getSaveFunction());
    const delegated = cowork.createSession('[长期] Task · #1 Sub', dir, '', 'local', [], null, 'longterm');
    cowork.setSessionAutoOrigin(delegated.id, 'longterm');
    delegatedId = delegated.id;

    // Pull it out of the fold into the main list.
    cowork.setSessionFoldOverride(delegated.id, 'out');
    assert.equal(overrideOf(sqlite.getDatabase(), delegated.id), 'out');
    assert.equal(cowork.getSession(delegated.id)?.foldOverride, 'out');
    assert.equal(
      cowork.listSessions().find((row) => row.id === delegated.id)?.foldOverride,
      'out',
    );
    assert.equal(
      cowork.getSession(delegated.id)?.autoOrigin,
      'longterm',
      'a fold move never rewrites the origin marker',
    );

    // And back in.
    cowork.setSessionFoldOverride(delegated.id, 'in');
    assert.equal(cowork.getSession(delegated.id)?.foldOverride, 'in');
  } finally {
    try { sqlite.close(); } catch { /* already closed */ }
  }

  // Reopen from disk: the placement was written, not just held in memory.
  const reopened = await openStartupStore(dir);
  try {
    const cowork = new CoworkStore(reopened.getDatabase(), reopened.getSaveFunction());
    assert.equal(cowork.getSession(delegatedId)?.foldOverride, 'in');
    assert.equal(
      cowork.listSessions().find((row) => row.id === delegatedId)?.foldOverride,
      'in',
    );
  } finally {
    try { reopened.close(); } catch { /* already closed */ }
    cleanupDir(dir);
  }
});

test('null clears the override, handing the row back to the auto-origin policy', async () => {
  const dir = makeTempDir();
  const sqlite = await openStartupStore(dir);
  try {
    const cowork = new CoworkStore(sqlite.getDatabase(), sqlite.getSaveFunction());
    const human = cowork.createSession('Human chat', dir);

    cowork.setSessionFoldOverride(human.id, 'in');
    assert.equal(overrideOf(sqlite.getDatabase(), human.id), 'in');

    cowork.setSessionFoldOverride(human.id, null);
    assert.equal(overrideOf(sqlite.getDatabase(), human.id), null, 'the column holds NULL again, not "null"');
    assert.equal(cowork.getSession(human.id)?.foldOverride, null);
    assert.equal(cowork.listSessions().find((row) => row.id === human.id)?.foldOverride, null);

    // Archived rows read the same fact (the archived list is its own mapper).
    cowork.setSessionFoldOverride(human.id, 'out');
    cowork.archiveSession(human.id);
    assert.equal(overrideOf(sqlite.getDatabase(), human.id), 'out');
    const archived = cowork.listArchivedSessions().find((row) => row.id === human.id);
    assert.equal(archived?.foldOverride, 'out', 'the archived mapper carries the placement too');
    assert.equal(archived?.autoOrigin, null);
  } finally {
    try { sqlite.close(); } catch { /* already closed */ }
    cleanupDir(dir);
  }
});
