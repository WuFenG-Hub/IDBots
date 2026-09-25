// Orchestration ledger origin-column migration (board v1.5 heritage).
//
// The ledger-projection tracked-task BOARD that consumed `origin` for
// closer-role derivation was retired (180c8bc4); the column remains a stored
// FACT on the ledger row and migrateOrchestrationTaskOriginColumn still runs
// at every startup. This standalone suite ports the migration contract out of
// the retired tests/trackedTaskBoard.test.mjs (release-audit follow-up
// 2026-09-19): the frozen dev-install id list flips exactly those ids, and
// the structural predicate flips any UNLINKED pre-v1.5 card — by construction
// only delegateLocalWorker ever created unlinked cards (every owner-reachable
// path links the card synchronously; verified back to v0.9.4) — so other
// upgrading installs get accurate origin facts too. Linked cards never flip.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Dynamic import needs a file:// URL: on Windows an absolute path is read as
// the scheme "c:" and the ESM loader rejects it (ERR_UNSUPPORTED_ESM_URL_SCHEME).
const { SqliteStore } = await import(
  pathToFileURL(path.join(repoRoot, 'dist-electron', 'main', 'sqliteStore.js')).href,
);

const insertTask = (db, id, at) => db.run(
  `INSERT INTO orchestration_tasks
     (id, owner_intent, twin_metabot_id, owner_global_meta_id, status, created_at, updated_at)
   VALUES (?, 'row', 1, 'owner-global', 'review', ?, ?)`,
  [id, at, at],
);
const originOf = (db, id) => String(
  db.exec('SELECT origin FROM orchestration_tasks WHERE id = ?', [id])[0]?.values?.[0]?.[0],
);

test('the origin migration flips unlinked pre-v1.5 cards and spares every linked card', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-origin-migration-'));
  const seeded = await SqliteStore.create(dir);
  try {
    const db = seeded.getDatabase();
    insertTask(db, 'unlinked-row-pre-v15', '2026-09-18T23:30:00.000Z');
    insertTask(db, 'owner-row-control', '2026-09-18T23:00:00.000Z');
    insertTask(db, 'scheduled-row-control', '2026-09-18T23:10:00.000Z');
    db.run(
      `INSERT INTO group_tasks
         (orchestration_task_id, group_id, title, goal, status, chair_metabot_id, created_by, created_at, updated_at)
       VALUES ('owner-row-control', 'origin-group-1', 'g', 'g', 'executing', 1, 'user', '2026-09-18T23:00:00.000Z', '2026-09-18T23:00:00.000Z')`,
    );
    db.run(
      `INSERT INTO scheduled_tasks
         (id, name, schedule_json, prompt, working_directory, system_prompt, execution_mode,
          orchestration_task_id, created_at, updated_at)
       VALUES ('sched-1', 's', '{}', 'p', '/tmp', '', 'auto', 'scheduled-row-control', '2026-09-18T23:10:00.000Z', '2026-09-18T23:10:00.000Z')`,
    );
  } finally {
    seeded.close();
  }

  // Reopen: the startup migration runs again over the seeded rows.
  const reopened = await SqliteStore.create(dir);
  try {
    const db = reopened.getDatabase();
    assert.equal(originOf(db, 'unlinked-row-pre-v15'), 'twin_delegate',
      'an unlinked pre-v1.5 card (delegateLocalWorker by construction) flips on ANY install, not just the dev machine');
    assert.equal(originOf(db, 'owner-row-control'), 'owner',
      'a group-linked card keeps the group creator as its authority');
    assert.equal(originOf(db, 'scheduled-row-control'), 'owner',
      'a scheduled-linked card stays owner (conservative branch)');

    // Idempotent: a third startup moves nothing.
    reopened.close();
    const third = await SqliteStore.create(dir);
    try {
      assert.equal(originOf(third.getDatabase(), 'unlinked-row-pre-v15'), 'twin_delegate');
      assert.equal(originOf(third.getDatabase(), 'owner-row-control'), 'owner');
      assert.equal(originOf(third.getDatabase(), 'scheduled-row-control'), 'owner');
    } finally {
      third.close();
    }
  } finally {
    // reopened may already be closed in the idempotency block — closing again is safe here
    try { reopened.close(); } catch { /* already closed */ }
  }
});
