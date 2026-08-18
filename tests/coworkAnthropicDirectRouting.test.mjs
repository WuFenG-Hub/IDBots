/**
 * Regression tests for the anthropic-direct provider routing bug.
 *
 * The cowork runner splices a session-scoped proxy path (/s/<sessionId>) onto
 * ANTHROPIC_BASE_URL so the local cowork proxy can apply the per-session
 * tool-result snip boundary. That path only exists ON the local proxy. For
 * anthropic-direct providers the resolved ANTHROPIC_BASE_URL is the remote
 * provider endpoint, and the splice made the upstream return 404 — which the
 * Claude Agent SDK then surfaced as
 *   "There's an issue with the selected model (<model>). It may not exist or
 *    you may not have access to it."
 *
 * Verified externally: a clean request to a Qwen token-plan endpoint returns
 * HTTP 200, while the same request to `…/apps/anthropic/s/<id>/v1/messages`
 * returns HTTP 404.
 *
 * These are static source assertions (style of coworkToolResultSnipWiring.test.mjs)
 * that the splice is gated on the base URL actually being the proxy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('coworkRunner imports the proxy base URL helper to detect proxy routing', () => {
  const src = read('src/main/libs/coworkRunner.ts');
  assert.ok(
    /getCoworkOpenAICompatProxyBaseURL/.test(src),
    'coworkRunner must import getCoworkOpenAICompatProxyBaseURL to tell proxy-routed base URLs apart from remote (anthropic-direct) ones',
  );
});

test('the /s/<sessionId> splice is gated on the base URL being the local proxy', () => {
  const src = read('src/main/libs/coworkRunner.ts');
  // The splice lives mid-template-literal, so search for the literal segment
  // (no leading backtick — it sits right after the `.replace(...)` expression).
  const spliceIdx = src.indexOf('/s/${encodeURIComponent(sessionId)}');
  assert.ok(spliceIdx > 0, 'session-scoped path splice must still be present for proxy-routed providers');

  // The detection block must precede and gate the splice.
  const detectionIdx = src.lastIndexOf('const proxyBaseURL = getCoworkOpenAICompatProxyBaseURL', spliceIdx);
  assert.ok(detectionIdx > -1, 'proxyBaseURL detection must precede the splice');

  const block = src.slice(detectionIdx, spliceIdx);
  assert.match(block, /startsWith\(proxyBaseURL\)/, 'must check the env base URL starts with the proxy base URL');
  assert.match(block, /isProxyRouted/, 'must derive an isProxyRouted flag');

  // The splice itself must sit inside an `if (isProxyRouted …)` guard, not a
  // bare `if (envVars.ANTHROPIC_BASE_URL)`.
  const between = src.slice(detectionIdx, spliceIdx + 1);
  const ifIdx = between.lastIndexOf('if (');
  assert.ok(ifIdx > -1, 'an if-guard must wrap the splice');
  assert.match(between.slice(ifIdx), /isProxyRouted/, 'the splice guard must test isProxyRouted');
});

test('no unconditional append of /s/<sessionId> to ANTHROPIC_BASE_URL remains', () => {
  const src = read('src/main/libs/coworkRunner.ts');
  // The old buggy form appended the segment under a bare
  // `if (envVars.ANTHROPIC_BASE_URL)`. Ensure every splice occurrence is now
  // preceded (within the same block) by the isProxyRouted guard.
  let cursor = 0;
  let occurrence;
  while ((occurrence = src.indexOf('/s/${encodeURIComponent(sessionId)}', cursor)) !== -1) {
    const guard = src.slice(src.lastIndexOf('const proxyBaseURL', occurrence), occurrence);
    assert.match(
      guard,
      /isProxyRouted/i,
      'found a /s/<sessionId> splice without a preceding isProxyRouted guard',
    );
    cursor = occurrence + 1;
  }
});
