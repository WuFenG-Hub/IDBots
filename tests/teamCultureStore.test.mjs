import test from 'node:test';
import assert from 'node:assert/strict';

import { createLegacyMemoryDb, createSqliteStore, getColumns, getRow } from './memoryTestUtils.mjs';

let TeamCultureStore;
let ensureTeamCultureSchema;
try {
  ({ TeamCultureStore, ensureTeamCultureSchema } =
    await import('../dist-electron/main/teamCultureStore.js'));
} catch {
  ({ TeamCultureStore, ensureTeamCultureSchema } =
    await import('../dist-electron/teamCultureStore.js'));
}

test('team culture schema is additive and idempotent', async () => {
  const db = await createLegacyMemoryDb();
  try {
    ensureTeamCultureSchema(db);
    ensureTeamCultureSchema(db);
    for (const table of ['team_culture_entries', 'team_culture_revisions', 'team_culture_sources']) {
      assert.ok(getColumns(db, table).length > 0, `${table} should exist`);
    }
    assert.ok(getColumns(db, 'team_culture_entries').includes('topic_fingerprint'));
    assert.ok(getColumns(db, 'team_culture_entries').includes('origin'));
  } finally {
    db.close();
  }
});

test('upsert lifecycle: create, no-op, revision, owner protection, owner edit promotes', async () => {
  const harness = await createSqliteStore();
  try {
    const { db } = harness;
    const store = new TeamCultureStore(db, () => {}, () => 1_800_000_000_000);

    const created = store.upsertCulture({
      kind: 'convention',
      topic: 'Deliverable verification',
      text: 'Chair verifies every verification JSON before acceptance.',
    });
    assert.equal(created.created, true);
    assert.equal(created.entry.version, 1);
    assert.equal(created.entry.origin, 'owner');

    const noop = store.upsertCulture({
      kind: 'convention',
      topic: 'deliverable   VERIFICATION',
      text: 'Chair verifies every verification JSON before acceptance.',
    });
    assert.equal(noop.created, false);
    assert.equal(noop.revised, false, 'same content + normalized topic is a no-op');

    const revised = store.upsertCulture({
      kind: 'convention',
      topic: 'Deliverable verification',
      text: 'Chair verifies every verification JSON AND the on-chain metafile URI before acceptance.',
    });
    assert.equal(revised.revised, true);
    assert.equal(revised.entry.version, 2);
    const revisionCount = Number(
      db.exec('SELECT COUNT(*) AS n FROM team_culture_revisions')[0]?.values?.[0]?.[0],
    );
    assert.equal(revisionCount, 1, 'prior text archived as a revision');

    const protectedWrite = store.upsertCulture({
      kind: 'convention',
      topic: 'Deliverable verification',
      text: 'distilled rewrite attempt',
      origin: 'distillation',
      taskId: 42,
    });
    assert.equal(protectedWrite.protected, true);
    assert.equal(store.getCulture(revised.entry.id).text.includes('on-chain metafile URI'), true,
      'owner-authored entry is shielded from distillation rewrites');

    const distilled = store.upsertCulture({
      kind: 'team_lesson',
      topic: 'ffmpeg budget',
      text: 'Transcoding tasks need schedule buffer.',
      origin: 'distillation',
      taskId: 42,
    });
    assert.equal(distilled.entry.origin, 'distillation');
    assert.ok(getRow(db, 'SELECT id FROM team_culture_sources WHERE task_id = 42'), 'task provenance recorded');

    const promoted = store.updateCulture({
      id: distilled.entry.id,
      text: 'Transcoding tasks need 2x schedule buffer.',
    });
    assert.equal(promoted.origin, 'owner', 'a human edit promotes the entry to owner governance');
    assert.equal(promoted.version, 2);

    assert.deepEqual(store.countCultureByKind('active'), { glossary: 0, convention: 1, team_lesson: 1 });
  } finally {
    harness.cleanup();
  }
});

test('per-kind caps: emergent displacement, owner sovereignty, capacity skip', async () => {
  const harness = await createSqliteStore();
  try {
    const { db } = harness;
    const store = new TeamCultureStore(db, () => {}, () => 1_800_000_000_000, { convention: 2 });

    const first = store.upsertCulture({ kind: 'convention', topic: 'c1', text: 'one', origin: 'distillation', taskId: 1 });
    store.upsertCulture({ kind: 'convention', topic: 'c2', text: 'two', origin: 'distillation', taskId: 1 });
    assert.equal(store.countCultureByKind('active').convention, 2);

    const displaced = store.upsertCulture({ kind: 'convention', topic: 'c3', text: 'three', origin: 'distillation', taskId: 2 });
    assert.equal(displaced.created, true);
    assert.equal(displaced.displacedTopic, 'c1', 'least-used emergent entry is displaced');
    assert.equal(store.getCulture(first.entry.id).status, 'archived');
    assert.equal(store.countCultureByKind('active').convention, 2);

    // Fill both slots with owner entries; each owner write displaces an
    // emergent entry first (owner sovereignty, cap respected).
    const ownerA = store.upsertCulture({ kind: 'convention', topic: 'owner-a', text: 'a' });
    const ownerB = store.upsertCulture({ kind: 'convention', topic: 'owner-b', text: 'b' });
    assert.equal(ownerA.displacedTopic !== null, true);
    assert.equal(ownerB.displacedTopic !== null, true);
    assert.equal(store.countCultureByKind('active').convention, 2, 'owner writes displace emergent entries, staying at cap');

    const skipped = store.upsertCulture({ kind: 'convention', topic: 'c4', text: 'four', origin: 'distillation', taskId: 3 });
    assert.equal(skipped.capacitySkipped, true);
    assert.equal(skipped.entry, null);
    assert.equal(store.countCultureByKind('active').convention, 2, 'no emergent entry sneaks past full owner slots');
  } finally {
    harness.cleanup();
  }
});

test('buildCulturePromptBlock renders sections, bumps usage, and stays null when empty', async () => {
  const harness = await createSqliteStore();
  try {
    const { db } = harness;
    const store = new TeamCultureStore(db, () => {}, () => 1_800_000_000_000);
    assert.equal(store.buildCulturePromptBlock(), null, 'empty culture injects nothing');

    store.upsertCulture({ kind: 'glossary', topic: 'deliverable', text: 'An on-chain metafile with verification JSON.' });
    store.upsertCulture({ kind: 'convention', topic: 'rework asks', text: 'Rework requests must list verifiable change points.' });
    store.upsertCulture({ kind: 'team_lesson', topic: 'scheduling', text: 'Leave buffer for transcoding.' });

    const block = store.buildCulturePromptBlock();
    assert.match(block, /<team_culture>/);
    assert.match(block, /Shared glossary \(use these exact terms\):/);
    assert.match(block, /- deliverable: An on-chain metafile with verification JSON\./);
    assert.match(block, /Team conventions \(how this fleet works together\):/);
    assert.match(block, /Team lessons \(cross-member, keep them in mind\):/);

    const used = store.listCulture({ kind: 'glossary', status: 'all' })[0];
    assert.equal(used.timesInjected, 1);
    assert.ok(used.lastUsedAt > 0);
  } finally {
    harness.cleanup();
  }
});
