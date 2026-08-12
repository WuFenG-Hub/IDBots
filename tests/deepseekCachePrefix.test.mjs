import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// DeepSeek's automatic context cache matches the longest common request
// prefix. The system prompt leads that prefix, so anything volatile placed
// there (dream summaries rewritten nightly, persona rows edited mid-session)
// wipes the cache for every turn afterwards. These tests pin the prefix
// discipline: experience/dream blocks ride the current user message, and the
// persona block is frozen for the active session's lifetime.

test('experience/dream blocks are NOT composed into the system prompt', () => {
  const source = read('src/main/libs/coworkRunner.ts');

  // The system-prompt persona sections must contain only the frozen persona
  // block and the static Twin orchestration prompt — never the volatile
  // experiencePromptBlocksXml (self-identity + rolling dream summaries).
  const personaCompositions = source.match(/personaWithExperience = \[[^\]]*\]/g) ?? [];
  assert.ok(personaCompositions.length >= 2, 'expected persona composition in startSession and continueSession');
  for (const composition of personaCompositions) {
    assert.ok(!composition.includes('experiencePromptBlocksXml'),
      `system prompt persona sections must not include experience blocks: ${composition}`);
  }
  // No call site may gate experience blocks for the system prompt anymore.
  assert.ok(!source.includes('const experiencePromptBlocksXml ='),
    'experience blocks must not be materialized for the system prompt path');
});

test('experience/dream blocks are injected via the volatile user-message path', () => {
  const source = read('src/main/libs/coworkRunner.ts');

  const volatileStart = source.indexOf('private async buildVolatileContextPrompt');
  assert.ok(volatileStart > 0, 'buildVolatileContextPrompt must exist');
  const volatileBody = source.slice(volatileStart, volatileStart + 3000);
  assert.match(volatileBody, /this\.buildExperiencePromptBlocksXml\(sessionId\)/,
    'experience blocks must be pushed into the volatile per-turn user-message context');
  assert.match(volatileBody, /if \(sessionMemoryEnabled\)/,
    'experience injection stays gated on the session memory switch');
});

test('persona block is frozen per active session instead of re-read per turn', () => {
  const source = read('src/main/libs/coworkRunner.ts');

  // ActiveSession carries the frozen block.
  assert.match(source, /personaBlock\?: string;/);
  // startSession freezes it onto the active session.
  assert.match(source, /activeSession\.personaBlock = personaBlock;/);
  // continueSession reuses the frozen block (fresh read only as a legacy fallback).
  assert.match(source, /activeSession\.personaBlock \?\? this\.buildMetabotPersonaBlock\(sessionId\)/);
});
