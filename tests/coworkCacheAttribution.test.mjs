import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// Cache-break attribution (Reasonix CompareShape, adapted): every point that
// resets the provider-visible prefix must record a reason, and the next
// cache-miss event must carry it instead of 'unknown'.

test('every claudeSessionId reset point records a pendingCacheBreakReason', () => {
  const source = read('src/main/libs/coworkRunner.ts');

  for (const reason of [
    'system_prompt_changed',
    'compaction',
    'overflow_retry',
    'reasoning_history_retry',
    'multimodal_retry',
  ]) {
    assert.ok(
      source.includes(`activeSession.pendingCacheBreakReason = '${reason}'`),
      `missing pendingCacheBreakReason = '${reason}'`
    );
  }
  // Stale-session retries (result-event + exception paths).
  const staleCount = source.split("activeSession.pendingCacheBreakReason = 'stale_session_retry'").length - 1;
  assert.ok(staleCount >= 2, `expected 2 stale_session_retry markers, got ${staleCount}`);
});

test('accumulateResultUsage consumes the pending reason for non-first-turn misses', () => {
  const source = read('src/main/libs/coworkRunner.ts');

  assert.match(source, /pendingCacheBreakReason \?\? 'unknown'/);
  assert.match(source, /activeForAttribution\.pendingCacheBreakReason = null;/);
  // First turn stays a cold start regardless of any pending reason.
  assert.match(source, /nextTurn === 1\s*\?\s*'cold_start'/);
});

test('system prompt drift is hashed and labeled as a regression alarm', () => {
  const source = read('src/main/libs/coworkRunner.ts');

  assert.match(source, /private trackSystemPromptHash\(/);
  assert.match(source, /createHash\('sha256'\)\.update\(effectiveSystemPrompt\)/);
  assert.match(source, /pendingCacheBreakReason = 'system_prompt_drift'/);
  // Wired into both startSession and continueSession.
  const callCount = source.split('this.trackSystemPromptHash(activeSession, sessionId, effectiveSystemPrompt);').length - 1;
  assert.ok(callCount >= 2, `expected trackSystemPromptHash calls in start and continue, got ${callCount}`);
});

test('ActiveSession declares the attribution fields', () => {
  const source = read('src/main/libs/coworkRunner.ts');

  assert.match(source, /pendingCacheBreakReason\?: string \| null;/);
  assert.match(source, /lastSystemPromptHash\?: string \| null;/);
});
