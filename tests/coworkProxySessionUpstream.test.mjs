/**
 * Runtime tests for the cowork OpenAI-compat proxy's per-session upstream
 * isolation. Historically the proxy held a single module-level `upstreamConfig`
 * that every proxy-routed session overwrote, so concurrent sessions on different
 * openai/responses providers (e.g. opencode vs a direct deepseek gateway)
 * clobbered each other: a request carrying model A was forwarded to provider B's
 * baseURL with provider B's apiKey.
 *
 * configureCoworkOpenAICompatProxy now additionally pins the upstream under the
 * cowork session key; handleRequest resolves that per-session entry first and
 * falls back to the singleton for non-session callers. Requires
 * `npm run compile:electron` to have run.
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

test('two sessions on different providers do not clobber each other', () => {
  configureCoworkOpenAICompatProxy({ ...upstreamA, sessionKey: 'sessionA' });
  configureCoworkOpenAICompatProxy({ ...upstreamB, sessionKey: 'sessionB' });

  // Each session resolves its OWN upstream, even though the singleton was
  // overwritten to upstreamB by the second call.
  assert.equal(getUpstreamForSession('sessionA').baseURL, upstreamA.baseURL);
  assert.equal(getUpstreamForSession('sessionA').apiKey, 'sk-a');
  assert.equal(getUpstreamForSession('sessionB').baseURL, upstreamB.baseURL);
  assert.equal(getUpstreamForSession('sessionB').apiKey, 'sk-b');
});

test('per-session entry wins over the shared singleton', () => {
  // sessionA pinned to A; singleton then set to B by registering sessionB.
  configureCoworkOpenAICompatProxy({ ...upstreamA, sessionKey: 'sessionA' });
  configureCoworkOpenAICompatProxy({ ...upstreamB, sessionKey: 'sessionB' });

  const resolved = getUpstreamForSession('sessionA');
  assert.equal(resolved.baseURL, upstreamA.baseURL);
  assert.notEqual(resolved.baseURL, upstreamB.baseURL);
});

test('non-session callers fall back to the shared singleton', () => {
  configureCoworkOpenAICompatProxy({ ...upstreamB, sessionKey: 'sessionB' });
  // Unknown session, null, and empty all resolve to the singleton (upstreamB).
  assert.equal(getUpstreamForSession('never-registered').baseURL, upstreamB.baseURL);
  assert.equal(getUpstreamForSession(null).baseURL, upstreamB.baseURL);
  assert.equal(getUpstreamForSession('').baseURL, upstreamB.baseURL);
});

test('clearCoworkSessionUpstream makes the session fall back to the singleton', () => {
  configureCoworkOpenAICompatProxy({ ...upstreamA, sessionKey: 'sessionA' });
  configureCoworkOpenAICompatProxy({ ...upstreamB, sessionKey: 'sessionB' });
  // Before clearing, sessionA is pinned to A despite the singleton being B.
  assert.equal(getUpstreamForSession('sessionA').baseURL, upstreamA.baseURL);

  clearCoworkSessionUpstream('sessionA');
  // After clearing, sessionA has no per-session entry and falls back to the
  // singleton (upstreamB).
  assert.equal(getUpstreamForSession('sessionA').baseURL, upstreamB.baseURL);
});

test('clearCoworkSessionUpstream is a no-op for unknown / empty keys', () => {
  const before = getUpstreamForSession(null);
  clearCoworkSessionUpstream(null);
  clearCoworkSessionUpstream('');
  clearCoworkSessionUpstream('never-registered');
  assert.deepEqual(getUpstreamForSession(null), before);
});
