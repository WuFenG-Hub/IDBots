import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const skillManagerPath = (() => {
  try {
    return require.resolve('../dist-electron/main/skillManager.js');
  } catch {
    return require.resolve('../dist-electron/skillManager.js');
  }
})();
const { SkillManager } = require(skillManagerPath);

/** Minimal SqliteDatabase-shape adapter over node:sqlite for store-level tests. */
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

class MemoryStore {
  constructor(initial = {}) {
    this.values = { ...initial };
    this.db = new TestSqliteDb();
  }

  get(key) {
    return this.values[key];
  }

  set(key, value) {
    this.values[key] = value;
  }

  getDatabase() {
    return this.db;
  }

  getSaveFunction() {
    return () => {};
  }
}

function writeSkill(root, id, name = id) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} description.\n---\n\nRun ${name}.\n`,
    'utf8'
  );
}

const BOT_ID = 7;

function createManager(initialStoreValues = {}) {
  // Bundled root: official skills, implicitly visible to every bot.
  const bundledRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-bundled-skills-'));
  writeSkill(bundledRoot, 'official-core-skill', 'Official Core Skill');

  // Writable root: external installs gated by scope/assignment.
  const skillRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-chat-skills-'));
  writeSkill(skillRoot, 'assigned-skill', 'Assigned Skill');
  writeSkill(skillRoot, 'assigned-by-name', 'Friendly Display Skill');
  writeSkill(skillRoot, 'disabled-skill', 'Disabled Skill');
  writeSkill(skillRoot, 'library-skill', 'Library Skill');

  const store = new MemoryStore({
    skills_state: {
      'disabled-skill': { enabled: false },
    },
    ...initialStoreValues,
  });
  const manager = new SkillManager(() => store);

  manager.getSkillsRoot = () => skillRoot;
  manager.ensureSkillsRoot = () => skillRoot;
  manager.getBundledSkillsRoot = () => bundledRoot;
  manager.getSkillRoots = () => [bundledRoot, skillRoot];
  // No Electron BrowserWindow in node:test.
  manager.notifySkillsChanged = () => {};

  return { manager, skillRoot };
}

function extractSkillIds(prompt) {
  return Array.from(prompt.matchAll(/<id>([^<]+)<\/id>/g), (match) => match[1]);
}

test('applyMetabotAssignedSkills resolves names, drops bundled skills, and replaces the set', () => {
  const { manager } = createManager();

  const resolved = manager.applyMetabotAssignedSkills(BOT_ID, [
    'assigned-skill',
    'Friendly Display Skill',
    'official-core-skill',
    'missing-skill',
    'assigned-skill',
  ], 'ui');

  assert.deepEqual(resolved, ['assigned-skill', 'assigned-by-name']);

  // Replace-set semantics: second call drops the first entry.
  manager.applyMetabotAssignedSkills(BOT_ID, ['assigned-by-name'], 'ui');
  assert.deepEqual(
    manager.resolveChatSkillIds({ metabotId: BOT_ID }),
    ['assigned-by-name']
  );
});

test('chat routing baseline: only the bot\'s assigned enabled skills are routable', () => {
  const { manager } = createManager();
  manager.applyMetabotAssignedSkills(BOT_ID, [
    'assigned-skill',
    'Friendly Display Skill',
    'disabled-skill',
    'official-core-skill',
  ], 'ui');

  const result = manager.buildChatSkillsRoutingPrompt({ metabotId: BOT_ID });

  assert.deepEqual(result.activeSkillIds, ['assigned-skill', 'assigned-by-name']);
  assert.deepEqual(extractSkillIds(result.prompt), result.activeSkillIds);
  assert.doesNotMatch(result.prompt, /disabled-skill/);
  assert.doesNotMatch(result.prompt, /library-skill/);
  assert.doesNotMatch(result.prompt, /official-core-skill/);
});

test('chat routing widened: capped at the bot\'s full visible set (bundled + global + assigned)', () => {
  const { manager } = createManager();
  manager.applyMetabotAssignedSkills(BOT_ID, ['assigned-skill'], 'ui');
  manager.setSkillScopeForSkill('library-skill', 'global');

  const result = manager.buildChatSkillsRoutingPrompt({ metabotId: BOT_ID, widened: true });

  assert.deepEqual(result.activeSkillIds, [
    'assigned-skill',
    'library-skill',
    'official-core-skill',
  ]);
  assert.doesNotMatch(result.prompt, /disabled-skill/);
  assert.doesNotMatch(result.prompt, /assigned-by-name/);
});

test('unassigned bot and bot-less sessions route no assigned-only skills', () => {
  const { manager } = createManager();
  manager.applyMetabotAssignedSkills(BOT_ID, ['assigned-skill'], 'ui');

  assert.deepEqual(manager.resolveChatSkillIds({ metabotId: BOT_ID + 1 }), []);
  assert.deepEqual(manager.resolveChatSkillIds({ metabotId: null }), []);
  assert.deepEqual(manager.resolveChatSkillIds({}), []);
});

test('listSkillsForMetabot: bot-less view = bundled + global only', () => {
  const { manager } = createManager();
  manager.setSkillScopeForSkill('library-skill', 'global');

  const visible = manager.listSkillsForMetabot(null).map((skill) => skill.id);
  assert.deepEqual(visible, ['library-skill', 'official-core-skill']);
});

test('listSkillsForMetabot: bot view = bundled + global + assigned, library-enabled gated', () => {
  const { manager } = createManager();
  manager.applyMetabotAssignedSkills(BOT_ID, ['assigned-skill', 'disabled-skill'], 'ui');

  const visible = manager.listSkillsForMetabot(BOT_ID).map((skill) => skill.id);
  assert.deepEqual(visible, ['assigned-skill', 'official-core-skill']);

  // A global skill stays invisible to everyone while library-level disabled.
  manager.setSkillScopeForSkill('library-skill', 'global');
  const visibleAfterGlobal = manager.listSkillsForMetabot(null).map((skill) => skill.id);
  assert.deepEqual(visibleAfterGlobal, ['library-skill', 'official-core-skill']);
});

test('buildCoworkSkillPromptParts scopes the catalog to the session bot', () => {
  const { manager } = createManager();
  manager.applyMetabotAssignedSkills(BOT_ID, ['assigned-skill'], 'ui');

  const botParts = manager.buildCoworkSkillPromptParts(BOT_ID);
  assert.match(botParts.catalog, /Official Core Skill/);
  assert.match(botParts.catalog, /Assigned Skill/);
  assert.doesNotMatch(botParts.catalog, /Library Skill/);

  const botlessParts = manager.buildCoworkSkillPromptParts(null);
  assert.match(botlessParts.catalog, /Official Core Skill/);
  assert.doesNotMatch(botlessParts.catalog, /Assigned Skill/);
  assert.doesNotMatch(botlessParts.catalog, /Library Skill/);
});

test('readSkillCatalogEntry is scoped to the bot view when a metabotId is given', () => {
  const { manager } = createManager();
  manager.applyMetabotAssignedSkills(BOT_ID, ['assigned-skill'], 'ui');

  assert.ok(manager.readSkillCatalogEntry('assigned-skill', BOT_ID));
  assert.equal(manager.readSkillCatalogEntry('assigned-skill', BOT_ID + 1), null);
  // Bundled skills stay readable for every bot.
  assert.ok(manager.readSkillCatalogEntry('official-core-skill', BOT_ID + 1));
  // Unscoped read (legacy callers) still resolves.
  assert.ok(manager.readSkillCatalogEntry('library-skill'));
});

test('getSkillAssignmentInfo reports scope + assigned bots for external skills only', () => {
  const { manager } = createManager();
  manager.setSkillScopeForSkill('library-skill', 'global');
  manager.applyMetabotAssignedSkills(BOT_ID, ['assigned-skill'], 'ui');

  const info = manager.getSkillAssignmentInfo();

  assert.equal(info['official-core-skill'], undefined);
  assert.deepEqual(info['library-skill'], { scope: 'global', assignedMetabotIds: [] });
  assert.deepEqual(info['assigned-skill'], { scope: 'library', assignedMetabotIds: [BOT_ID] });
});

test('buildAutoRoutingPromptForSkillIds excludes disabled skills from chat routing prompts', () => {
  const { manager } = createManager();

  const prompt = manager.buildAutoRoutingPromptForSkillIds([
    'assigned-skill',
    'disabled-skill',
  ]);

  assert.ok(prompt);
  assert.deepEqual(extractSkillIds(prompt), ['assigned-skill']);
  assert.doesNotMatch(prompt, /disabled-skill/);
});
