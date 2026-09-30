import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const storeLibPath = (() => {
  try {
    return require.resolve('../dist-electron/main/libs/skillAssignmentStore.js');
  } catch {
    return require.resolve('../dist-electron/main/libs/skillAssignmentStore.js');
  }
})();
const {
  ensureSkillAssignmentSchema,
  listAssignedSkillIds,
  listAssignmentMetabotIds,
  listAssignments,
  removeMetabotAssignments,
  setMetabotAssignedSkills,
  setSkillAssignments,
  assignSkillToMetabot,
  removeSkillFromAssignmentStore,
  getGlobalScopeMap,
  getSkillScope,
  setSkillScope,
  syncAllowChatSkillsColumnsFromRows,
  listMissingAuthorizedSkillIds,
  runSkillAssignmentMigration,
  SKILL_SCOPE_KEY,
  SKILL_ASSIGNMENT_MIGRATION_KEY,
} = require(storeLibPath);

/** Minimal SqliteDatabase-shape adapter over node:sqlite. */
class TestSqliteDb {
  constructor() {
    this.db = new DatabaseSync(':memory:');
  }

  exec(sql, params = []) {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
      this.db.exec(sql);
      return [];
    }
    const stmt = this.db.prepare(sql);
    if (/^\s*(SELECT|PRAGMA)/i.test(sql)) {
      const rows = stmt.all(...params);
      const columns = stmt.columns().map((column) => column.name || column.column || '');
      return [{ columns, values: rows.map((row) => columns.map((column) => row[column])) }];
    }
    stmt.run(...params);
    return [];
  }

  run(sql, params = []) {
    this.exec(sql, params);
  }
}

class MemoryKvStore {
  constructor(initial = {}) {
    this.values = { ...initial };
    // Mirror writes into a real kv table so the migration's raw-row probe
    // (corrupt-flag detection) behaves like the production SqliteStore.
    this.db = new TestSqliteDb();
    this.db.run('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)');
  }

  get(key) {
    return this.values[key];
  }

  set(key, value) {
    this.values[key] = value;
    this.db.run(
      'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
      [key, JSON.stringify(value), 1]
    );
  }

  getDatabase() {
    return this.db;
  }
}

function createFixture() {
  const db = new TestSqliteDb();
  ensureSkillAssignmentSchema(db);
  const kv = new MemoryKvStore();
  return { db, kv, saveDb: () => {} };
}

test('schema creation is idempotent', () => {
  const db = new TestSqliteDb();
  ensureSkillAssignmentSchema(db);
  ensureSkillAssignmentSchema(db);
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metabot_skill_assignments'");
  assert.equal(tables[0].values.length, 1);
});

test('setMetabotAssignedSkills replaces the bot set and normalizes duplicates', () => {
  const { db, saveDb } = createFixture();

  setMetabotAssignedSkills(db, saveDb, 1, ['skill-a', 'skill-b'], 'ui');
  setMetabotAssignedSkills(db, saveDb, 1, ['skill-a', 'skill-a', 'skill-c'], 'ui');

  assert.deepEqual(listAssignedSkillIds(db, 1), ['skill-a', 'skill-c']);
  assert.deepEqual(listAssignments(db, 1).map((row) => row.skillId), ['skill-a', 'skill-c']);
  assert.equal(listAssignments(db, 1)[0].enabled, true);
});

test('setSkillAssignments replaces the skill set (skill-side scope editor)', () => {
  const { db, saveDb } = createFixture();

  setSkillAssignments(db, saveDb, 'skill-a', [1, 2, 3], 'ui');
  setSkillAssignments(db, saveDb, 'skill-a', [2, 2], 'ui');

  assert.deepEqual(listAssignmentMetabotIds(db, 'skill-a'), [2]);
  // Other skills untouched.
  assert.deepEqual(listAssignmentMetabotIds(db, 'skill-b'), []);
});

test('assignSkillToMetabot adds one row without touching the rest', () => {
  const { db, saveDb } = createFixture();

  setMetabotAssignedSkills(db, saveDb, 1, ['skill-a'], 'ui');
  assignSkillToMetabot(db, saveDb, 'skill-b', 1, 'skill_tool');

  assert.deepEqual(listAssignedSkillIds(db, 1), ['skill-a', 'skill-b']);
  const rows = listAssignments(db, 1);
  assert.equal(rows[1].assignedVia, 'skill_tool');
});

test('removeSkillFromAssignmentStore clears rows and the scope entry', () => {
  const { db, kv, saveDb } = createFixture();

  setSkillAssignments(db, saveDb, 'skill-a', [1, 2], 'ui');
  setSkillScope(kv, 'skill-a', 'global');
  assert.equal(getSkillScope(kv, 'skill-a'), 'global');

  removeSkillFromAssignmentStore(db, saveDb, kv, 'skill-a');

  assert.deepEqual(listAssignmentMetabotIds(db, 'skill-a'), []);
  assert.equal(getSkillScope(kv, 'skill-a'), 'library');
  assert.equal(getGlobalScopeMap(kv)['skill-a'], undefined);
});

test('migration seeds global scope for external skills and converts allowlists once', () => {
  const db = new TestSqliteDb();
  ensureSkillAssignmentSchema(db);
  const kv = new MemoryKvStore();
  const saveDb = () => {};

  const registry = [
    { id: 'bundled-one', isBuiltIn: true },
    { id: 'external-one', isBuiltIn: false },
    { id: 'external-two', isBuiltIn: false },
  ];
  const metabots = [
    { id: 1, allow_chat_skills: ['external-one', 'Friendly Two', 'no-such-skill'] },
    { id: 2, allow_chat_skills: [] },
  ];
  const resolveSkillId = (idOrName) => {
    if (idOrName === 'external-one') return 'external-one';
    if (idOrName === 'Friendly Two') return 'external-two';
    return null;
  };

  const first = runSkillAssignmentMigration({
    db, saveDb, store: kv,
    listSkills: () => registry,
    listMetabots: () => metabots,
    resolveSkillId,
  });

  assert.equal(first.ran, true);
  assert.equal(first.globalSeeded, 2);
  assert.equal(first.assignmentsMigrated, 2);
  assert.deepEqual(getGlobalScopeMap(kv), {
    'external-one': 'global',
    'external-two': 'global',
  });
  assert.deepEqual(listAssignedSkillIds(db, 1), ['external-one', 'external-two']);
  assert.deepEqual(listAssignedSkillIds(db, 2), []);
  assert.equal(kv.get(SKILL_ASSIGNMENT_MIGRATION_KEY), true);

  // Second run is a flagged no-op — post-mutation data is not re-seeded.
  setSkillScope(kv, 'external-one', 'library');
  const second = runSkillAssignmentMigration({
    db, saveDb, store: kv,
    listSkills: () => registry,
    listMetabots: () => metabots,
    resolveSkillId,
  });
  assert.equal(second.ran, false);
  assert.equal(getSkillScope(kv, 'external-one'), 'library');
  assert.equal(kv.get(SKILL_SCOPE_KEY)['external-one'], undefined);
});


test('removeMetabotAssignments drops every row the deleted bot owned', () => {
  const { db, saveDb } = createFixture();
  setSkillAssignments(db, saveDb, 'skill-a', [1, 2], 'ui');
  setSkillAssignments(db, saveDb, 'skill-b', [2, 3], 'ui');

  removeMetabotAssignments(db, saveDb, 2);

  assert.deepEqual(listAssignmentMetabotIds(db, 'skill-a'), [1]);
  assert.deepEqual(listAssignmentMetabotIds(db, 'skill-b'), [3]);
});

test('migration flag: corrupt KV row counts as already-run (no re-seed over owner changes)', () => {
  const db = new TestSqliteDb();
  ensureSkillAssignmentSchema(db);
  // A kv row whose JSON no longer parses — SqliteStore.get would return
  // undefined, which must NOT be treated as "never ran".
  db.run(
    'CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)'
  );
  db.run(
    'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
    [SKILL_ASSIGNMENT_MIGRATION_KEY, '{corrupt json', 1]
  );
  const kv = {
    get: () => undefined,
    set: () => {},
    getDatabase: () => db,
  };

  const result = runSkillAssignmentMigration({
    db, saveDb: () => {}, store: kv,
    listSkills: () => [{ id: 'external-one', isBuiltIn: false }],
    listMetabots: () => [],
    resolveSkillId: () => null,
  });

  assert.equal(result.ran, false, 'corrupt flag row must suppress re-seeding');
});

test('migration flag: absent row runs the migration (fresh install)', () => {
  const db = new TestSqliteDb();
  ensureSkillAssignmentSchema(db);
  db.run(
    'CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)'
  );
  const values = {};
  const kv = {
    get: (key) => values[key],
    set: (key, value) => { values[key] = value; },
    getDatabase: () => db,
  };

  const result = runSkillAssignmentMigration({
    db, saveDb: () => {}, store: kv,
    listSkills: () => [{ id: 'external-one', isBuiltIn: false }],
    listMetabots: () => [],
    resolveSkillId: () => null,
  });

  assert.equal(result.ran, true);
  assert.equal(result.globalSeeded, 1);
});

test('syncAllowChatSkillsColumnsFromRows mirrors rows into the column, writes only on drift', () => {
  const { db, saveDb } = createFixture();
  setMetabotAssignedSkills(db, saveDb, 1, ['skill-a'], 'skill_tool');
  setMetabotAssignedSkills(db, saveDb, 2, ['skill-b'], 'ui');

  const updates = [];
  const bots = new Map([
    [1, { allow_chat_skills: [] }],
    [2, { allow_chat_skills: ['skill-b'] }],
  ]);
  const metabotStore = {
    getMetabotById: (id) => bots.get(id) ?? null,
    updateMetabot: (id, input) => {
      updates.push([id, input]);
      bots.get(id).allow_chat_skills = input.allow_chat_skills;
    },
  };

  // Bot 2 already in sync; bot 99 does not exist — only bot 1 is written.
  const synced = syncAllowChatSkillsColumnsFromRows(db, saveDb, metabotStore, [1, 2, 99]);
  assert.deepEqual(synced, [1]);
  assert.deepEqual(updates, [[1, { allow_chat_skills: ['skill-a'] }]]);
  assert.deepEqual(bots.get(1).allow_chat_skills, ['skill-a']);

  // Second run: no drift, no writes.
  const again = syncAllowChatSkillsColumnsFromRows(db, saveDb, metabotStore, [1]);
  assert.deepEqual(again, []);
  assert.equal(updates.length, 1);

  // A row removal is mirrored too (un-assign clears the column entry) — this
  // is the regression guard for skill_tool installs vanishing on bot edits.
  setMetabotAssignedSkills(db, saveDb, 1, [], 'metabot_update');
  syncAllowChatSkillsColumnsFromRows(db, saveDb, metabotStore, [1]);
  assert.deepEqual(bots.get(1).allow_chat_skills, []);
});

test('listMissingAuthorizedSkillIds reports authorized-but-absent skills only', () => {
  const { db, kv, saveDb } = createFixture();
  setMetabotAssignedSkills(db, saveDb, 1, ['skill-a', 'skill-b'], 'ui');
  setSkillScope(kv, 'skill-c', 'global');
  setSkillScope(kv, 'skill-d', 'library');

  // skill-a on disk; skill-b (assigned) + skill-c (global) missing; library
  // scope without rows is not authorized, so skill-d never appears.
  assert.deepEqual(
    listMissingAuthorizedSkillIds(db, kv, new Set(['skill-a'])),
    ['skill-b', 'skill-c']
  );
  assert.deepEqual(
    listMissingAuthorizedSkillIds(db, kv, new Set(['skill-a', 'skill-b', 'skill-c'])),
    []
  );
});

test('migration crash-recovery: flag lost but assignment data exists -> no re-seed', () => {
  const { db, kv, saveDb } = createFixture();
  // Simulate a post-migration install whose flag row was lost in a crash:
  // assignment rows + a deliberately de-globalized scope map survive.
  setMetabotAssignedSkills(db, saveDb, 1, ['skill-a'], 'skill_tool');
  setSkillScope(kv, 'skill-b', 'global');
  // flag row absent by construction (fresh fixture)

  let listed = 0;
  const result = runSkillAssignmentMigration({
    db,
    saveDb,
    store: kv,
    listSkills: () => {
      listed += 1;
      return [
        { id: 'skill-c', isBuiltIn: false },
        { id: 'skill-d', isBuiltIn: false },
      ];
    },
    listMetabots: () => [],
    resolveSkillId: (x) => x,
  });

  assert.equal(result.ran, false, 'no re-seed when assignment data exists');
  assert.equal(result.globalSeeded, 0);
  assert.equal(listed, 0, 'skills never even enumerated');
  assert.deepEqual(getGlobalScopeMap(kv), { 'skill-b': 'global' }, 'scope map untouched — skill-c/skill-d NOT globalized');
  assert.equal(kv.get(SKILL_ASSIGNMENT_MIGRATION_KEY), true, 'flag re-armed so later launches short-circuit');
});

test('migration crash-recovery: truly fresh store (no rows, no scope) still seeds', () => {
  const { db, kv, saveDb } = createFixture();
  const result = runSkillAssignmentMigration({
    db,
    saveDb,
    store: kv,
    listSkills: () => [{ id: 'skill-c', isBuiltIn: false }],
    listMetabots: () => [],
    resolveSkillId: (x) => x,
  });
  assert.equal(result.ran, true);
  assert.equal(result.globalSeeded, 1);
  assert.equal(getGlobalScopeMap(kv)['skill-c'], 'global');
});
