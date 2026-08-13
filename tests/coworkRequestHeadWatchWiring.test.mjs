/**
 * Wiring tests for the request-head byte-stability watch (item 4):
 *  - static source assertions that the proxy fingerprints main-loop request
 *    heads before conversion and persists per-session baselines;
 *  - runtime checks against the compiled proxy (memory-only baselines — the
 *    userData persistence path is inert under node) that drift is detected and
 *    subagent-style systems are skipped.
 * Requires `npm run compile:electron` to have run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

async function importCompiled(modulePath) {
  try {
    return await import(`../dist-electron/main/libs/${modulePath}.js`);
  } catch {
    return await import(`../dist-electron/libs/${modulePath}.js`);
  }
}

test('proxy watches the request head before format conversion and persists baselines', () => {
  const source = read('src/main/libs/coworkOpenAICompatProxy.ts');

  assert.ok(source.includes("import {\n  compareRequestHead,"), 'proxy must import the watch module');
  assert.ok(source.includes('request-head-hashes.json'), 'baselines persist under userData/cowork');
  const watchIndex = source.indexOf('trackRequestHeadStability(\n      messagesRouteSessionKey');
  const convertIndex = source.indexOf('anthropicToOpenAI(anthropicRequestBody)');
  assert.ok(watchIndex >= 0, 'request handler must call trackRequestHeadStability');
  assert.ok(convertIndex >= 0, 'anthropicToOpenAI must consume the body');
  assert.ok(watchIndex < convertIndex, 'head watch must run after body parse, before conversion');
});

test('request-head watch exposes its core for runtime verification', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  assert.equal(typeof __openAICompatProxyTestUtils.trackRequestHeadStability, 'function');
  assert.equal(typeof __openAICompatProxyTestUtils.extractAnthropicSystemText, 'function');
});

test('runtime: first main-loop request baselines, drift is reported, unchanged is silent', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const { trackRequestHeadStability, extractAnthropicSystemText } = __openAICompatProxyTestUtils;

  const sessionKey = 'wire-test-session';
  const mainLoopBody = {
    system: '## Workspace Safety Policy (Highest Priority)\n- rules\n\n## Memory Strategy',
    tools: [{ type: 'function', function: { name: 'Read' } }],
  };

  assert.equal(trackRequestHeadStability(sessionKey, mainLoopBody), null, 'baseline set silently');
  assert.equal(trackRequestHeadStability(sessionKey, mainLoopBody), null, 'unchanged head is silent');

  const drifted = trackRequestHeadStability(sessionKey, {
    ...mainLoopBody,
    tools: [{ type: 'function', function: { name: 'Read' } }, { type: 'function', function: { name: 'Bash' } }],
  });
  assert.equal(drifted?.kind, 'tools');
});

test('runtime: subagent-style systems (no IDBots signature) never touch the baseline', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const { trackRequestHeadStability } = __openAICompatProxyTestUtils;

  const sessionKey = 'wire-test-subagent';
  const mainLoopBody = {
    system: '## Workspace Safety Policy (Highest Priority)\n- rules',
    tools: [{ type: 'function', function: { name: 'Read' } }],
  };
  assert.equal(trackRequestHeadStability(sessionKey, mainLoopBody), null);

  // Subagent call with a different system must be ignored — and must NOT
  // register as drift for the next main-loop request.
  assert.equal(trackRequestHeadStability(sessionKey, {
    system: 'You are a subagent that edits files.',
    tools: [{ type: 'function', function: { name: 'Edit' } }],
  }), null);
  assert.equal(trackRequestHeadStability(sessionKey, mainLoopBody), null, 'baseline survived the subagent call');
});
