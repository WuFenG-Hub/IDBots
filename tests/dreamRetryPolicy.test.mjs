// H-80 addendum (b225a203 follow-up): tests for libs/dreamRetryPolicy.ts and
// the scheduler-side terminal/cap semantics in libs/dreamPrompt.ts.
//
// Provenance: the original tests/dreamRetryPolicy.test.mjs from the H-80 fix
// was lost in a worktree cleanup (untracked file swallowed by the repo-wide
// tests/* ignore) before it could be committed. This file is a faithful
// rewrite from the H-80 report spec: real-sample 400·1210 classification,
// non-regression for 429/408/5xx/network/parse, primary-route-first composite
// errors, service-level 400 terminal-on-first-attempt, and retry-cap
// degradation.
//
// Imports target the dist-electron build (compiled by test:dream-retry's
// compile:electron step), matching tests/dreamPrompt.test.mjs convention.

import test from 'node:test';
import assert from 'node:assert/strict';

const { classifyDreamError, DREAM_RETRY_MAX_ATTEMPTS, isTransientDreamLlmError, DREAM_TRANSIENT_LLM_RETRY_DELAYS_MS } = await import(
  '../dist-electron/main/libs/dreamRetryPolicy.js'
);
const { computeDueDreamDates, computeDreamRetryDelayMs } = await import(
  '../dist-electron/main/libs/dreamPrompt.js'
);

// cognitiveChatCompletion throws `LLM request failed: <status> <body>`; the
// passthrough status is anchored to that prefix. Body numbers like zhipu's
// error id `1210:` must never read as statuses, and llmFallback's combined
// error keeps the primary message first — the first match is the primary
// route's status.

test('real sample: glm 400 passthrough with JSON envelope (1210 always-thinking) is terminal', () => {
  const error =
    'LLM request failed: 400 {"error":{"code":"1210","message":"该模型始终思考，不支持关闭思考"}}';
  assert.equal(classifyDreamError(error), 'terminal');
});

test('real sample: glm 400 passthrough with plain-text envelope (1210: …) is terminal', () => {
  const error = 'LLM request failed: 400 1210: 该模型始终思考，不支持关闭思考';
  assert.equal(classifyDreamError(error), 'terminal');
});

test('body error id 1210 must not masquerade as the passthrough status', () => {
  // Primary route answered 500; the 1210 id sits in the body and must not be
  // scanned as a status — the run stays in the retryable class.
  const error = 'LLM request failed: 500 {"error":{"code":"1210","message":"server hiccup"}}';
  assert.equal(classifyDreamError(error), 'retryable');
});

test('digit-boundary trap: 400/401/403 embedded in larger numbers are not statuses', () => {
  // No `LLM request failed:` anchor at all; bare 400/…4401x in prose must
  // not trigger the 4xx/401/403 rules.
  const error = 'cache kept 400 rows; token budget 34001 exceeded after 1400ms; hint 4401x';
  assert.equal(classifyDreamError(error), 'retryable');
});

test('non-regression: 429 stays retryable', () => {
  assert.equal(classifyDreamError('LLM request failed: 429 rate limited, retry after 60s'), 'retryable');
});

test('non-regression: 408 stays retryable', () => {
  assert.equal(classifyDreamError('LLM request failed: 408 upstream read timeout'), 'retryable');
});

test('non-regression: 5xx family stays retryable', () => {
  for (const status of [500, 502, 503, 504]) {
    assert.equal(
      classifyDreamError(`LLM request failed: ${status} upstream temporarily unavailable`),
      'retryable',
      `HTTP ${status} must remain retryable`,
    );
  }
});

test('non-regression: network errors stay retryable', () => {
  assert.equal(classifyDreamError(new Error('fetch failed')), 'retryable');
  assert.equal(classifyDreamError('request to https://open.bigmodel.cn failed: ECONNRESET'), 'retryable');
});

test('non-regression: parse errors and unknown errors stay retryable', () => {
  assert.equal(classifyDreamError('Unexpected token < in JSON at position 0'), 'retryable');
  assert.equal(classifyDreamError(undefined), 'retryable');
});

test('composite error: primary route 400 wins over fallback 5xx', () => {
  // llmFallback combines route messages with the primary first.
  const combined = [
    'LLM request failed: 400 {"error":{"code":"1210"}}',
    'LLM request failed: 503 fallback route unavailable',
  ].join('\n');
  assert.equal(classifyDreamError(combined), 'terminal');
});

test('composite error: primary route 5xx wins over fallback 400', () => {
  // Mirrored case: the later fallback 400 must not flip a primary-5xx run
  // into the terminal class.
  const combined = [
    'LLM request failed: 503 primary route unavailable',
    'LLM request failed: 400 {"error":{"code":"1210"}}',
  ].join('\n');
  assert.equal(classifyDreamError(combined), 'retryable');
});

test('service-level 400 is terminal on the first attempt; retry budget exists only for the retryable class', () => {
  assert.equal(classifyDreamError('LLM request failed: 400 invalid model parameter'), 'terminal');
  assert.equal(DREAM_RETRY_MAX_ATTEMPTS, 5);
});

test('scheduler: terminal-failed dates never queue again (one attempt and out)', () => {
  const runStates = new Map([
    ['2026-08-06', { status: 'terminal-failed', attemptCount: 1, startedAt: Date.now(), dreamVersion: 1 }],
  ]);
  const { dueDates } = computeDueDreamDates({ now: new Date(2026, 7, 8, 12, 0), metabotId: 1, runStates });
  assert.equal(dueDates.includes('2026-08-06'), false, 'terminal-failed must be invisible to the scheduler');
});

test('cap degradation: legacy failed rows stop at DREAM_RETRY_MAX_ATTEMPTS, below-cap rows keep bounded backoff', () => {
  const now = new Date(2026, 7, 8, 12, 0);
  const hours = (n) => n * 60 * 60 * 1000;
  // attempt 4 → 30min * 2^3 = 4h backoff.
  assert.equal(computeDreamRetryDelayMs(4), hours(4));

  const failedAt = (attemptCount, startedAt) =>
    new Map([['2026-08-06', { status: 'failed', attemptCount, startedAt, dreamVersion: 1 }]]);
  const due = (states) =>
    computeDueDreamDates({ now, metabotId: 1, runStates: states }).dueDates.includes('2026-08-06');

  // Below cap, backoff elapsed → still queues (bounded retry intact).
  assert.equal(due(failedAt(4, now.getTime() - hours(5))), true);
  // Below cap, backoff not elapsed → waits for retryAt.
  assert.equal(due(failedAt(4, now.getTime() - hours(1))), false);
  // At cap → degraded instead of retrying forever.
  assert.equal(due(failedAt(DREAM_RETRY_MAX_ATTEMPTS, now.getTime() - hours(48))), false);
  // Above cap (pre-H-80 row that burned extra attempts) → degraded too.
  assert.equal(due(failedAt(DREAM_RETRY_MAX_ATTEMPTS + 3, now.getTime() - hours(96))), false);
});

// In-run transient retry (2026-09-29): which failures the dream call layer
// re-drives immediately (primary→fallback pair, bounded rounds) instead of
// failing the run into the 30-minute scheduled backoff.

test('in-run transient retry: the 2026-09-28 real failure signature qualifies', () => {
  // Verbatim shape of the error that killed the 45-minute nightly run at its
  // 54th fragment: proxy-wrapped TLS flap on the primary, timeout on the
  // fallback, combined by llmFallback.
  const real = "LLM request failed: 502 {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"net::ERR_SSL_PROTOCOL_ERROR\"}} (fallback 'glm-5.3-flash@custom-provider' also failed: The operation was aborted due to timeout)";
  assert.equal(isTransientDreamLlmError(real), true);
  assert.equal(classifyDreamError(real), 'retryable', 'must stay in the run-level retryable class too');
});

test('in-run transient retry: transport and gateway signatures qualify', () => {
  assert.equal(isTransientDreamLlmError('LLM request failed: 502 Bad Gateway'), true);
  assert.equal(isTransientDreamLlmError('LLM request failed: 503 Service Unavailable'), true);
  assert.equal(isTransientDreamLlmError('LLM request failed: 504 Gateway Timeout'), true);
  assert.equal(isTransientDreamLlmError('LLM request failed: 408 upstream read timeout'), true);
  assert.equal(isTransientDreamLlmError('LLM request failed: 429 concurrency limit, retry soon'), true);
  assert.equal(isTransientDreamLlmError(new Error('fetch failed')), true);
  assert.equal(isTransientDreamLlmError('request to https://open.bigmodel.cn failed: ECONNRESET'), true);
  assert.equal(isTransientDreamLlmError('net::ERR_CONNECTION_CLOSED'), true);
  assert.equal(isTransientDreamLlmError('The operation was aborted due to timeout'), true);
  assert.equal(isTransientDreamLlmError('LLM returned empty content'), true);
  assert.equal(isTransientDreamLlmError('socket hang up'), true);
});

test('in-run transient retry: terminal and non-transport errors never qualify', () => {
  // Deterministic rejections: re-driving the same prompt can never help.
  assert.equal(isTransientDreamLlmError('LLM request failed: 400 {"error":{"code":"1210","message":"该模型始终思考"}}'), false);
  assert.equal(isTransientDreamLlmError('LLM request failed: 401 invalid api key'), false);
  assert.equal(isTransientDreamLlmError('LLM request failed: 403 forbidden'), false);
  assert.equal(isTransientDreamLlmError('LLM request failed: 429 free_quota_exhausted'), false, 'terminal quota class wins over the 429 gateway pattern');
  // 500s are often request-specific rejections misreported by relays — the
  // proxy makes the same call; the run-level backoff owns them.
  assert.equal(isTransientDreamLlmError('LLM request failed: 500 internal error'), false);
  // Parse failures belong to generateAndParse's own retry, not this loop.
  assert.equal(isTransientDreamLlmError('dream output unparseable after retry: no json object found'), false);
  assert.equal(isTransientDreamLlmError(undefined), false);
});

test('in-run transient retry budget: two bounded re-drives', () => {
  assert.deepEqual([...DREAM_TRANSIENT_LLM_RETRY_DELAYS_MS], [10_000, 30_000]);
});
