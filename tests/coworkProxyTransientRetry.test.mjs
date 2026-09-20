/**
 * Runtime tests for the cowork OpenAI-compat proxy's transient upstream retry.
 *
 * The proxy's only upstream transport is Electron's `session.defaultSession.fetch`
 * (Chromium network stack). Before 2026-09-20 any single transport exception —
 * `net::ERR_CONNECTION_CLOSED` from a server/LB dropping a keep-alive socket
 * mid-request, a network flap, a relay teardown — was wrapped straight into a
 * 502 and killed the caller's whole attempt (three nightly dream runs died on
 * one zhipu gateway flap). sendUpstreamRequestWithTransientRetry now retries
 * transient network errors and 502/503/504 gateway statuses a bounded number
 * of times on a fresh connection. Requires `pnpm run compile:electron`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

let proxy;
try {
  proxy = await import('../dist-electron/main/libs/coworkOpenAICompatProxy.js');
} catch {
  proxy = await import('../dist-electron/main/libs/coworkOpenAICompatProxy.js');
}

const { isTransientUpstreamNetworkError, sendUpstreamRequestWithTransientRetry } = proxy;

const TARGET_URL = 'https://upstream.example.com/v1/messages';

function makeResponse(status) {
  return new Response(status === 200 ? '{"ok":true}' : '{"error":"boom"}', { status });
}

test('isTransientUpstreamNetworkError matches Chromium net error codes', () => {
  assert.equal(isTransientUpstreamNetworkError('net::ERR_CONNECTION_CLOSED'), true);
  assert.equal(isTransientUpstreamNetworkError('net::ERR_CONNECTION_RESET'), true);
  assert.equal(isTransientUpstreamNetworkError('net::ERR_EMPTY_RESPONSE'), true);
  assert.equal(isTransientUpstreamNetworkError('net::ERR_TIMED_OUT'), true);
  assert.equal(isTransientUpstreamNetworkError('net::ERR_NETWORK_CHANGED'), true);
  assert.equal(isTransientUpstreamNetworkError('net::ERR_NAME_NOT_RESOLVED'), true);
  assert.equal(isTransientUpstreamNetworkError('fetch failed'), false);
  assert.equal(isTransientUpstreamNetworkError('LLM request failed: 429 free_quota_exhausted'), false);
  assert.equal(isTransientUpstreamNetworkError(''), false);
});

test('a transient network error is retried and the retry answer is returned', async () => {
  let sends = 0;
  const response = await sendUpstreamRequestWithTransientRetry(
    async () => {
      sends += 1;
      if (sends === 1) {
        throw new Error('net::ERR_CONNECTION_CLOSED');
      }
      return makeResponse(200);
    },
    { model: 'm' },
    TARGET_URL
  );
  assert.equal(sends, 2);
  assert.equal(response.status, 200);
});

test('two transient network errors still recover on the third attempt', async () => {
  let sends = 0;
  const response = await sendUpstreamRequestWithTransientRetry(
    async () => {
      sends += 1;
      if (sends <= 2) {
        throw new Error(sends === 1 ? 'net::ERR_CONNECTION_CLOSED' : 'net::ERR_CONNECTION_RESET');
      }
      return makeResponse(200);
    },
    { model: 'm' },
    TARGET_URL
  );
  assert.equal(sends, 3);
  assert.equal(response.status, 200);
});

test('a persistent transient error exhausts the retries and throws the last error', async () => {
  let sends = 0;
  await assert.rejects(
    sendUpstreamRequestWithTransientRetry(
      async () => {
        sends += 1;
        throw new Error('net::ERR_CONNECTION_CLOSED');
      },
      { model: 'm' },
      TARGET_URL
    ),
    /net::ERR_CONNECTION_CLOSED/
  );
  assert.equal(sends, 3);
});

test('non-transient errors surface immediately without retry', async () => {
  let sends = 0;
  await assert.rejects(
    sendUpstreamRequestWithTransientRetry(
      async () => {
        sends += 1;
        throw new Error('some permanent failure');
      },
      { model: 'm' },
      TARGET_URL
    ),
    /some permanent failure/
  );
  assert.equal(sends, 1);
});

test('a 502/503 gateway status is retried on a fresh connection', async () => {
  let sends = 0;
  const response = await sendUpstreamRequestWithTransientRetry(
    async () => {
      sends += 1;
      return makeResponse(sends <= 2 ? 503 : 200);
    },
    { model: 'm' },
    TARGET_URL
  );
  assert.equal(sends, 3);
  assert.equal(response.status, 200);
});

test('a 502 gateway status that persists surfaces the last response', async () => {
  let sends = 0;
  const response = await sendUpstreamRequestWithTransientRetry(
    async () => {
      sends += 1;
      return makeResponse(502);
    },
    { model: 'm' },
    TARGET_URL
  );
  assert.equal(sends, 3);
  assert.equal(response.status, 502);
});

test('429 and other non-retryable statuses pass through untouched on the first attempt', async () => {
  for (const status of [429, 401, 400, 500]) {
    let sends = 0;
    const response = await sendUpstreamRequestWithTransientRetry(
      async () => {
        sends += 1;
        return makeResponse(status);
      },
      { model: 'm' },
      TARGET_URL
    );
    assert.equal(sends, 1, `status ${status} must not be retried`);
    assert.equal(response.status, status);
  }
});

test('every retry re-sends the payload to the same target URL', async () => {
  const seen = [];
  await sendUpstreamRequestWithTransientRetry(
    async (payload, targetURL) => {
      seen.push({ payload, targetURL });
      if (seen.length < 3) {
        throw new Error('net::ERR_CONNECTION_CLOSED');
      }
      return makeResponse(200);
    },
    { model: 'replay-me' },
    TARGET_URL
  );
  assert.equal(seen.length, 3);
  for (const send of seen) {
    assert.deepEqual(send.payload, { model: 'replay-me' });
    assert.equal(send.targetURL, TARGET_URL);
  }
});
