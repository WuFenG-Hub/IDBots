/**
 * Runtime tests for the cowork OpenAI-compat proxy's per-session upstream
 * isolation. Historically the proxy held a single module-level `upstreamConfig`
 * that every proxy-routed session overwrote, so concurrent sessions on different
 * openai/responses providers (e.g. opencode vs a direct deepseek gateway)
 * clobbered each other: a request carrying model A was forwarded to provider B's
 * baseURL with provider B's apiKey.
 *
 * configureCoworkOpenAICompatProxy pins a per-session upstream under the cowork
 * session key WITHOUT republishing the shared singleton; only unscoped configures
 * (no sessionKey — legacy / non-session callers) republish the singleton.
 * handleRequest resolves the per-session entry first and falls back to the
 * singleton for non-session callers. Requires `npm run compile:electron`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

let proxy;
try {
  proxy = await import('../dist-electron/main/libs/coworkOpenAICompatProxy.js');
} catch {
  proxy = await import('../dist-electron/libs/coworkOpenAICompatProxy.js');
}

const { configureCoworkOpenAICompatProxy, getUpstreamForSession, clearCoworkSessionUpstream } = proxy;

const upstreamA = {
  baseURL: 'https://provider-a.example.com/v1',
  apiKey: 'sk-a',
  model: 'model-a',
  provider: 'providerA',
  apiFormat: 'openai',
};
const upstreamB = {
  baseURL: 'https://provider-b.example.com/v1',
  apiKey: 'sk-b',
  model: 'model-b',
  provider: 'providerB',
  apiFormat: 'responses',
};

test('unscoped configure republishes the shared singleton', () => {
  configureCoworkOpenAICompatProxy({ ...upstreamA });
  // Unknown session, null, and empty all fall back to the singleton (upstreamA).
  assert.equal(getUpstreamForSession(null).baseURL, upstreamA.baseURL);
  assert.equal(getUpstreamForSession('').baseURL, upstreamA.baseURL);
  assert.equal(getUpstreamForSession('never-registered').baseURL, upstreamA.baseURL);
});

test('session-scoped configure does NOT republish the shared singleton', () => {
  configureCoworkOpenAICompatProxy({ ...upstreamA });
  // Pinning sessionB must not clobber the singleton that an unscoped caller
  // (memory judge, title generation) is currently relying on.
  configureCoworkOpenAICompatProxy({ ...upstreamB, sessionKey: 'sessionB' });
  assert.equal(getUpstreamForSession(null).baseURL, upstreamA.baseURL);
  assert.equal(getUpstreamForSession('sessionB').baseURL, upstreamB.baseURL);
});

test('two sessions on different providers do not clobber each other', () => {
  configureCoworkOpenAICompatProxy({ ...upstreamA, sessionKey: 'sessionA' });
  configureCoworkOpenAICompatProxy({ ...upstreamB, sessionKey: 'sessionB' });

  assert.equal(getUpstreamForSession('sessionA').baseURL, upstreamA.baseURL);
  assert.equal(getUpstreamForSession('sessionA').apiKey, 'sk-a');
  assert.equal(getUpstreamForSession('sessionB').baseURL, upstreamB.baseURL);
  assert.equal(getUpstreamForSession('sessionB').apiKey, 'sk-b');
});

test('per-session entry wins over the shared singleton', () => {
  configureCoworkOpenAICompatProxy({ ...upstreamA });
  configureCoworkOpenAICompatProxy({ ...upstreamA, sessionKey: 'sessionA' });
  configureCoworkOpenAICompatProxy({ ...upstreamB, sessionKey: 'sessionB' });

  const resolved = getUpstreamForSession('sessionA');
  assert.equal(resolved.baseURL, upstreamA.baseURL);
  assert.notEqual(resolved.baseURL, upstreamB.baseURL);
});

test('clearCoworkSessionUpstream makes the session fall back to the singleton', () => {
  configureCoworkOpenAICompatProxy({ ...upstreamA });
  configureCoworkOpenAICompatProxy({ ...upstreamB, sessionKey: 'sessionB' });
  // Before clearing, sessionB is pinned to B.
  assert.equal(getUpstreamForSession('sessionB').baseURL, upstreamB.baseURL);

  clearCoworkSessionUpstream('sessionB');
  // After clearing, sessionB has no per-session entry and falls back to the
  // singleton (upstreamA).
  assert.equal(getUpstreamForSession('sessionB').baseURL, upstreamA.baseURL);
});

test('clearCoworkSessionUpstream is a no-op for unknown / empty keys', () => {
  configureCoworkOpenAICompatProxy({ ...upstreamB });
  const before = getUpstreamForSession(null);
  clearCoworkSessionUpstream(null);
  clearCoworkSessionUpstream('');
  clearCoworkSessionUpstream('never-registered');
  assert.deepEqual(getUpstreamForSession(null), before);
});
