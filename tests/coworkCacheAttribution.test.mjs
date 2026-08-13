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
    'snip',
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

  assert.match(source, /pendingCacheBreakReason \?\? untrackedMissReason/);
  assert.match(source, /activeForAttribution\.pendingCacheBreakReason = null;/);
  // First turn stays a cold start regardless of any pending reason.
  assert.match(source, /nextTurn === 1\s*\?\s*'cold_start'/);
});

test('ActiveSession declares the attribution fields', () => {
  const source = read('src/main/libs/coworkRunner.ts');

  assert.match(source, /pendingCacheBreakReason\?: string \| null;/);
  assert.match(source, /lastSystemPromptHash\?: string \| null;/);
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

test('startSession system-prompt reset also records the attribution (no silent unknown)', () => {
  const source = read('src/main/libs/coworkRunner.ts');

  assert.match(source, /let systemPromptChanged = false;/);
  assert.match(source, /if \(systemPromptChanged\) \{\s*\n\s*\/\/ Same attribution as continueSession's reset/);
  assert.match(source, /activeSession\.pendingCacheBreakReason = 'system_prompt_changed';/);
});

test('untracked misses are labeled append_only vs unknown by the turn hit ratio', () => {
  const source = read('src/main/libs/coworkRunner.ts');

  // Normal turns always miss on the newly appended tail; only a near-total
  // miss means an untracked prefix break. 'append_only' must be the default
  // label so the chip is not flooded with meaningless 'unknown' entries.
  assert.match(source, /turnHitRatio < 0\.3 \? 'unknown' : 'append_only'/);
  assert.match(source, /pendingCacheBreakReason \?\? untrackedMissReason/);
});

test('turn hit ratio never double-counts cache tokens for cache-inclusive providers', () => {
  const source = read('src/main/libs/coworkRunner.ts');

  // Non-Anthropic upstreams (DeepSeek, OpenAI-compat) report input_tokens as
  // TOTAL input (cache included). The attribution ratio must use that total
  // directly instead of adding the cache counters on top — the old
  // double-counted denominator halved the ratio and mislabeled healthy
  // append-only turns as 'unknown' prefix breaks.
  assert.match(
    source,
    /const turnInputTotal = cacheIncludedInInput\s*\?\s*inputTokens\s*:\s*inputTokens \+ cacheReadTokens \+ cacheCreationTokens;/,
  );
});
