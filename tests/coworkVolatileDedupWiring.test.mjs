/**
 * Static wiring tests for the volatile-context content dedup (item 6): the
 * runner must route every volatile section through applyVolatileDedup, bind
 * the dedup hashes to the current SDK session generation, and exempt the
 * per-turn re-ranked memory block from dedup.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('runner dedups volatile sections with SDK-session generation invalidation', () => {
  const source = read('src/main/libs/coworkRunner.ts');

  assert.ok(source.includes("import {\n  applyVolatileDedup,"), 'runner must import the dedup module');
  assert.ok(source.includes('private volatileDedupBySessionId'), 'dedup state must be runner-scoped (survives per-turn activeSession cleanup)');
  assert.ok(source.includes('const generation = activeForDedup?.claudeSessionId ?? null;'), 'dedup validity is bound to the SDK session generation');
  assert.ok(source.includes('dedupState.generation !== generation'), 'a changed generation invalidates cached hashes');
  assert.ok(source.includes('applyVolatileDedup(sections, dedupState)'), 'sections must flow through the pure dedup function');
});

test('memory block is alwaysInject; other volatile sections are dedup candidates', () => {
  const source = read('src/main/libs/coworkRunner.ts');

  const promptBody = source.slice(source.indexOf('private async buildVolatileContextPrompt('));
  assert.ok(promptBody.includes("key: 'memory'"), 'memory section keyed');
  assert.ok(promptBody.includes('alwaysInject: true'), 'memory block is exempt from dedup (re-ranked per turn)');
  assert.ok(promptBody.includes("key: 'experience'"), 'experience section keyed');
  assert.ok(promptBody.includes("key: 'twin-impression'"), 'twin-impression section keyed');
  assert.ok(promptBody.includes("key: 'browser'"), 'browser section keyed');
  assert.ok(promptBody.includes("key: 'remote-services'"), 'remote-services section keyed');
});
