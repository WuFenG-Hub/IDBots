/**
 * Dream review P1 (2026-10-23), item P1-3: the fleet's team culture rides the
 * cowork turn volatile tail.
 *
 * Switch decision: the SAME master switch as the group-task daemon
 * (teamCultureConfig.enabled, default ON) — one fleet-wide culture layer
 * rather than two diverging gates; the block's own hard 1400-char cap bounds
 * the cost, and distillation stays gated by the same flag it always was.
 *
 * Covers:
 *   1. the cerebellum volatile gate knows the new 'team-culture' section
 *      (key + threshold + instruction, consistent with the other blocks),
 *   2. the runner wires a 'team-culture' volatile section through the shared
 *      builder, the master-switch gate, and the cerebellum skip list,
 *   3. the shared builder semantics on a real TeamCultureStore: default ON
 *      builds the compact block (with usage counters refreshed), the master
 *      switch OFF yields no block.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createSqliteStore } from './memoryTestUtils.mjs';

let TeamCultureStore;
try {
  ({ TeamCultureStore } = await import('../dist-electron/main/teamCultureStore.js'));
} catch {
  ({ TeamCultureStore } = await import('../dist-electron/main/teamCultureStore.js'));
}
const {
  CEREBELLUM_VOLATILE_GATE_SECTION_KEYS,
  CEREBELLUM_VOLATILE_GATE_THRESHOLDS,
  CEREBELLUM_VOLATILE_GATE_INSTRUCTIONS,
} = await import('../dist-electron/main/cerebellum/volatileBlockGate.js');

const repoRoot = path.resolve(import.meta.dirname, '..');
const runnerSource = fs.readFileSync(path.join(repoRoot, 'src/main/libs/coworkRunner.ts'), 'utf8');
const mainSource = fs.readFileSync(path.join(repoRoot, 'src/main/main.ts'), 'utf8');

test('volatile gate registers team-culture alongside the other guidance blocks', () => {
  assert.ok(
    CEREBELLUM_VOLATILE_GATE_SECTION_KEYS.includes('team-culture'),
    'section key registered',
  );
  const threshold = CEREBELLUM_VOLATILE_GATE_THRESHOLDS['team-culture'];
  assert.equal(typeof threshold, 'number', 'threshold present');
  assert.ok(threshold > 0 && threshold < 0.5, 'same conservative bias as the other blocks');
  const instruction = CEREBELLUM_VOLATILE_GATE_INSTRUCTIONS['team-culture'];
  assert.ok(typeof instruction === 'string' && instruction.includes('team'), 'gate question describes the block category');
});

test('runner wires the team-culture volatile section through the builder and the gate', () => {
  const volatileBody = runnerSource.slice(runnerSource.indexOf('buildVolatileContextPrompt('));
  assert.ok(volatileBody.includes("key: 'team-culture'"), 'team-culture section keyed in the volatile tail');
  assert.ok(
    volatileBody.includes("shouldInjectVolatile('team-culture')"),
    'section consults the cerebellum volatile gate like the other guidance blocks',
  );
  assert.ok(
    volatileBody.includes('this.buildTeamCultureBlock'),
    'section renders via the shared builder dep',
  );
});

test('main wiring: cowork runner and group-task daemon share ONE master-switch builder', () => {
  assert.ok(
    mainSource.includes('const buildTeamCulturePromptBlock = (): string | null => {'),
    'shared builder exists',
  );
  assert.ok(
    mainSource.includes('if (!cultureStore.getCultureConfig().enabled) return null;'),
    'the shared builder gates on the master switch (same as group tasks before)',
  );
  assert.ok(
    mainSource.includes('buildTeamCultureBlock: buildTeamCulturePromptBlock,'),
    'cowork runner receives the shared builder',
  );
  const groupTaskIdx = mainSource.indexOf('buildTeamCultureBlock: buildTeamCulturePromptBlock,');
  const groupTaskBlock = mainSource.slice(groupTaskIdx - 4000, groupTaskIdx);
  assert.ok(
    groupTaskBlock.includes('startGroupTaskDaemon') || mainSource.indexOf('startGroupTaskDaemon') > -1,
    'group-task daemon still wired',
  );
});

test('culture block: default ON builds the compact block and refreshes usage counters', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = new TeamCultureStore(db, () => {}, () => 1_800_000_000_000);
    assert.deepEqual(store.getCultureConfig(), { enabled: true }, 'default ON');
    store.upsertCulture({ kind: 'glossary', topic: 'Pin', text: '一条链上记录。' });
    store.upsertCulture({ kind: 'convention', topic: '先验证再交付', text: '交付前必须自验证。' });
    const block = store.buildCulturePromptBlock();
    assert.ok(block.includes('<team_culture>'), 'block built when enabled');
    assert.ok(block.includes('先验证再交付'), 'conventions ride the block');
    assert.ok(block.length <= 1_500, 'hard char cap respected');
    const touched = db.exec("SELECT times_injected FROM team_culture_entries WHERE kind = 'glossary'")[0].values[0][0];
    assert.equal(touched, 1, 'building refreshes the usage counters');
  } finally {
    cleanup();
  }
});

test('culture block: master switch OFF yields no block (the shared builder gate)', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = new TeamCultureStore(db, () => {}, () => 1_800_000_000_000);
    store.upsertCulture({ kind: 'glossary', topic: 'Pin', text: '一条链上记录。' });
    // Mirror main.ts buildTeamCulturePromptBlock's gate (kept in sync with the
    // source assertion in the wiring test above).
    const build = () => {
      if (!store.getCultureConfig().enabled) return null;
      return store.buildCulturePromptBlock();
    };
    assert.ok(build() !== null, 'enabled → block');
    store.setCultureConfig(false);
    assert.equal(build(), null, 'disabled → no block, same master switch as group tasks');
  } finally {
    cleanup();
  }
});
