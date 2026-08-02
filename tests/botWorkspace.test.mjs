import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSqliteStore, createCoworkStore } from './memoryTestUtils.mjs';

let formatBotWorkspaceDate;
let resolveBotWorkspaceCwd;
let resolveSessionWorkingDirectory;
let isWorkspaceMetabotId;
let shouldUseBotWorkspaceCwd;
try {
  ({
    formatBotWorkspaceDate,
    resolveBotWorkspaceCwd,
    resolveSessionWorkingDirectory,
    isWorkspaceMetabotId,
    shouldUseBotWorkspaceCwd,
  } = await import('../dist-electron/main/libs/botWorkspace.js'));
} catch {
  ({
    formatBotWorkspaceDate,
    resolveBotWorkspaceCwd,
    resolveSessionWorkingDirectory,
    isWorkspaceMetabotId,
    shouldUseBotWorkspaceCwd,
  } = await import('../dist-electron/libs/botWorkspace.js'));
}

const makeTempBase = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-bot-workspace-'));

test('formatBotWorkspaceDate pads month and day in local time', () => {
  assert.equal(formatBotWorkspaceDate(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(formatBotWorkspaceDate(new Date(2026, 11, 25)), '2026-12-25');
});

test('isWorkspaceMetabotId accepts only positive integers', () => {
  assert.equal(isWorkspaceMetabotId(3), true);
  assert.equal(isWorkspaceMetabotId(0), false);
  assert.equal(isWorkspaceMetabotId(-2), false);
  assert.equal(isWorkspaceMetabotId(1.5), false);
  assert.equal(isWorkspaceMetabotId(Number.NaN), false);
  assert.equal(isWorkspaceMetabotId('3'), false);
  assert.equal(isWorkspaceMetabotId(null), false);
  assert.equal(isWorkspaceMetabotId(undefined), false);
});

test('resolveBotWorkspaceCwd creates <base>/bots/<id>/<date> and is idempotent', () => {
  const base = makeTempBase();
  const fixed = new Date(2026, 7, 2);

  const first = resolveBotWorkspaceCwd(base, 3, fixed);
  assert.equal(first, path.join(path.resolve(base), 'bots', '3', '2026-08-02'));
  assert.equal(fs.statSync(first).isDirectory(), true);

  const second = resolveBotWorkspaceCwd(base, 3, fixed);
  assert.equal(second, first);
});

test('resolveBotWorkspaceCwd separates bots and days', () => {
  const base = makeTempBase();

  const botA = resolveBotWorkspaceCwd(base, 1, new Date(2026, 7, 2));
  const botB = resolveBotWorkspaceCwd(base, 2, new Date(2026, 7, 2));
  const botANextDay = resolveBotWorkspaceCwd(base, 1, new Date(2026, 7, 3));

  assert.notEqual(botA, botB);
  assert.notEqual(botA, botANextDay);
  assert.ok(botA.includes(`${path.sep}bots${path.sep}1${path.sep}`));
  assert.ok(botB.includes(`${path.sep}bots${path.sep}2${path.sep}`));
});

test('resolveBotWorkspaceCwd rejects invalid input', () => {
  const base = makeTempBase();
  assert.throws(() => resolveBotWorkspaceCwd(base, 0));
  assert.throws(() => resolveBotWorkspaceCwd(base, -1));
  assert.throws(() => resolveBotWorkspaceCwd(base, 1.5));
  assert.throws(() => resolveBotWorkspaceCwd('', 3));
  assert.throws(() => resolveBotWorkspaceCwd('   ', 3));
});

test('resolveSessionWorkingDirectory falls back to the plain base without a metabot id', () => {
  const base = makeTempBase();

  const withBot = resolveSessionWorkingDirectory(base, 4, new Date(2026, 7, 2));
  assert.equal(withBot, path.join(path.resolve(base), 'bots', '4', '2026-08-02'));

  const withoutBot = resolveSessionWorkingDirectory(base, null, new Date(2026, 7, 2));
  assert.equal(withoutBot, path.resolve(base));
  assert.equal(fs.existsSync(path.join(base, 'bots', '4', '2026-08-03')), false);
});

test('shouldUseBotWorkspaceCwd treats the pre-filled default as no explicit pick', () => {
  const defaultDir = path.join(os.homedir(), 'idbots', 'project');

  // No bot → never bot workspace.
  assert.equal(shouldUseBotWorkspaceCwd({ explicitCwd: null, defaultWorkingDirectory: defaultDir, metabotId: null }), false);
  assert.equal(shouldUseBotWorkspaceCwd({ explicitCwd: null, defaultWorkingDirectory: defaultDir, metabotId: 0 }), false);

  // Bot + nothing sent → bot workspace.
  assert.equal(shouldUseBotWorkspaceCwd({ explicitCwd: undefined, defaultWorkingDirectory: defaultDir, metabotId: 3 }), true);
  assert.equal(shouldUseBotWorkspaceCwd({ explicitCwd: '  ', defaultWorkingDirectory: defaultDir, metabotId: 3 }), true);

  // Bot + pre-filled default (what the renderer actually sends) → bot workspace.
  assert.equal(shouldUseBotWorkspaceCwd({ explicitCwd: defaultDir, defaultWorkingDirectory: defaultDir, metabotId: 3 }), true);
  assert.equal(
    shouldUseBotWorkspaceCwd({ explicitCwd: `${defaultDir}${path.sep}`, defaultWorkingDirectory: defaultDir, metabotId: 3 }),
    true,
    'trailing separator still counts as the default'
  );

  // Bot + a genuinely different folder → user choice wins.
  const custom = makeTempBase();
  assert.equal(shouldUseBotWorkspaceCwd({ explicitCwd: custom, defaultWorkingDirectory: defaultDir, metabotId: 3 }), false);

  // Explicit cwd with no configured default to compare against → user choice wins.
  assert.equal(shouldUseBotWorkspaceCwd({ explicitCwd: custom, defaultWorkingDirectory: '', metabotId: 3 }), false);
});

test('listRecentCwds collapses per-bot dated folders back to the workspace root', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const root = makeTempBase();
    const other = makeTempBase();

    store.createSession('bot day one', path.join(root, 'bots', '3', '2026-08-01'));
    store.createSession('bot day two', path.join(root, 'bots', '3', '2026-08-02'));
    store.createSession('plain root', root);
    store.createSession('other root', other);

    const recent = store.listRecentCwds(8);
    assert.equal(recent.filter((entry) => entry === path.resolve(root)).length, 1);
    assert.ok(recent.includes(path.resolve(other)));
    assert.equal(recent.some((entry) => entry.includes(`${path.sep}bots${path.sep}`)), false);
  } finally {
    cleanup();
  }
});
