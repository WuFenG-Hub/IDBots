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

test('culture hygiene: revision pruning and emergent-entry decay', async () => {
  const harness = await createSqliteStore();
  try {
    const { db } = harness;
    let now = 1_700_000_000_000;
    const store = new TeamCultureStore(db, () => {}, () => now);
    for (let version = 1; version <= 5; version += 1) {
      now += 1_000;
      store.upsertCulture({ kind: 'convention', topic: 'evolving rule', text: `rule v${version}`, origin: 'distillation', taskId: 1 });
    }
    store.upsertCulture({ kind: 'glossary', topic: 'owner term', text: 'never decays' });
    assert.equal(
      Number(db.exec('SELECT COUNT(*) AS n FROM team_culture_revisions')[0]?.values?.[0]?.[0]),
      4,
    );

    const pruned = store.pruneCultureRevisions({ keepPerEntry: 2 });
    assert.equal(pruned, 2);
    assert.equal(
      Number(db.exec("SELECT COUNT(*) AS n FROM team_culture_revisions WHERE text IN ('rule v3', 'rule v4')")[0]?.values?.[0]?.[0]),
      2,
      'newest two revisions survive',
    );

    now = 1_800_000_000_000;
    const fresh = new TeamCultureStore(db, () => {}, () => now);
    const decayed = fresh.archiveDecayedCulture({
      cutoffMs: now - 30 * 86_400_000,
      archivedAt: now,
    });
    assert.equal(decayed, 1, 'the stale emergent entry decays; the owner entry stays');
    const statuses = fresh.listCulture({ status: 'all' });
    const evolving = statuses.find((entry) => entry.topic === 'evolving rule');
    const ownerTerm = statuses.find((entry) => entry.topic === 'owner term');
    assert.equal(evolving.status, 'archived');
    assert.equal(ownerTerm.status, 'active');
  } finally {
    harness.cleanup();
  }
});

test('task comm stats: stamped at close and listed for the trend view', async () => {
  const harness = await createSqliteStore();
  try {
    const { db } = harness;
    let GroupTaskStoreCtor;
    try {
      ({ GroupTaskStore: GroupTaskStoreCtor } = await import('../dist-electron/main/groupTaskStore.js'));
    } catch {
      ({ GroupTaskStore: GroupTaskStoreCtor } = await import('../dist-electron/groupTaskStore.js'));
    }
    const store = new GroupTaskStoreCtor(db, () => {});
    db.run(
      `INSERT INTO group_tasks (id, group_id, title, goal, chair_metabot_id, status, updated_at)
       VALUES (31, 'grp-comm', 'Poster', 'Make it', 1, 'done', '2026-08-25 10:00:00')`,
    );
    for (const [index, size] of [120, 80, 200].entries()) {
      db.run(
        `INSERT INTO group_chat_messages (pin_id, group_id, sender_metaid, sender_global_metaid, protocol, content, chain_timestamp)
         VALUES (?, 'grp-comm', ?, ?, 'simplechat', ?, 1)`,
        [`pin-cm-${index}`, `metaid-${index}`, `gmid-${index}`, 'x'.repeat(size)],
      );
    }
    db.run(
      `INSERT INTO group_task_deliverables (task_id, author_globalmetaid, kind, uri, status, created_at)
       VALUES (31, 'gmid-0', 'metafile', 'metafile://x', 'accepted', 1)`,
    );

    assert.equal(store.recordTaskCommStats(31, 'grp-comm'), true);
    const trend = store.listRecentTaskCommStats(15);
    assert.equal(trend.length, 1);
    assert.equal(trend[0].commTotalBytes, 400);
    assert.equal(trend[0].commMessageCount, 3);
    assert.equal(trend[0].deliverableCount, 1);
    assert.equal(store.recordTaskCommStats(31, null), false, 'no group id → skip');
  } finally {
    harness.cleanup();
  }
});
