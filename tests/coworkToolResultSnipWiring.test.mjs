/**
 * Wiring tests for the tiered tool-result snipping feature:
 *  - static source assertions (style of coworkCacheAttribution.test.mjs) that
 *    the runner, proxy, and snip module are connected as designed;
 *  - runtime checks against the compiled proxy for the session-scoped route
 *    parsing, the SDK baseURL+path join shape, and the monotonic boundary
 *    registry. Requires `npm run compile:electron` to have run.
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

function methodBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing ${signature}`);
  const rest = source.slice(start + signature.length);
  const nextMethod = rest.search(/\n  (?:private|public|protected) /);
  return nextMethod >= 0 ? rest.slice(0, nextMethod) : rest;
}

// ---------------------------------------------------------------------------
// Static wiring
// ---------------------------------------------------------------------------

test('runner appends /s/<coworkSessionId> to ANTHROPIC_BASE_URL in local mode only', () => {
  const source = read('src/main/libs/coworkRunner.ts');
  const localBody = methodBody(source, 'private async runClaudeCodeLocal(');

  assert.ok(
    localBody.includes('/s/${encodeURIComponent(sessionId)}'),
    'runClaudeCodeLocal must scope ANTHROPIC_BASE_URL with the CoWork session id'
  );
  assert.match(localBody, /envVars\.ANTHROPIC_BASE_URL\.replace\(\/\\\/\+\$\/, ''\)/);
  // The CoWork session id survives SDK session resets; claudeSessionId does not.
  assert.ok(!localBody.includes('/s/${encodeURIComponent(claudeSessionId)}'));

  // Sandbox env handling must stay untouched by the session-scoping.
  const sandboxBody = methodBody(source, 'private buildSandboxEnv(');
  assert.ok(!sandboxBody.includes('/s/${encodeURIComponent'));
  assert.ok(!sandboxBody.includes('setCoworkSnipHeadTokens'));
  assert.ok(!sandboxBody.includes('snipStaleToolResultBlocks'));
});

test('runner soft-threshold branch tries tool-result snipping before hard compaction', () => {
  const source = read('src/main/libs/coworkRunner.ts');
  const localBody = methodBody(source, 'private async runClaudeCodeLocal(');

  const snipIndex = localBody.indexOf('setCoworkSnipHeadTokens(sessionId, snipHeadTokens)');
  const compactIndex = localBody.indexOf('buildCoworkCompactedPrompt({');
  assert.ok(snipIndex >= 0, 'soft-threshold branch must call setCoworkSnipHeadTokens');
  assert.ok(compactIndex >= 0, 'soft-threshold branch must keep the buildCoworkCompactedPrompt fallback');
  assert.ok(snipIndex < compactIndex, 'snipping must be attempted before hard compaction');

  assert.ok(localBody.includes('getCoworkSnipHeadTokens(sessionId)'), 'hysteresis reads the persisted boundary');
  assert.ok(localBody.includes('COWORK_TOOL_RESULT_SNIP_HYSTERESIS_TOKENS'));
  assert.ok(localBody.includes('COWORK_TOOL_RESULT_SNIP_TAIL_TOKENS'));
  assert.ok(localBody.includes("activeSession.pendingCacheBreakReason = 'snip'"), 'snip cache break must be attributed');
  // Hard compaction starts a fresh SDK session; the old boundary no longer applies.
  assert.ok(localBody.includes('resetCoworkSnipHeadTokens(sessionId)'));

  // The overflow-retry compaction path must stay free of snip-boundary writes:
  // exactly one call site each, both inside the soft-threshold branch above.
  // (Match full call strings: 'resetCoworkSnipHeadTokens(' contains
  // 'setCoworkSnipHeadTokens(' as a substring.)
  assert.equal(source.split('setCoworkSnipHeadTokens(sessionId, snipHeadTokens)').length - 1, 1);
  assert.equal(source.split('resetCoworkSnipHeadTokens(sessionId)').length - 1, 1);
});

test('proxy parses the session-scoped route and snips before format conversion', () => {
  const source = read('src/main/libs/coworkOpenAICompatProxy.ts');

  assert.ok(source.includes("import { snipStaleToolResultBlocks } from './coworkToolResultSnip';"));
  assert.ok(source.includes("import { writeFileAtomicSync } from './atomicFile';"));
  assert.ok(source.includes('tool-result-snip.json'), 'boundary registry persists under userData/cowork');
  assert.ok(source.includes('/^\\/s\\/([^/]+)\\/v1\\/messages$/'), 'session route pattern');
  assert.ok(source.includes('decodeURIComponent'));

  const snipIndex = source.indexOf('snipStaleToolResultBlocks(requestMessages, snipHeadTokens)');
  const convertIndex = source.indexOf('anthropicToOpenAI(anthropicRequestBody)');
  assert.ok(snipIndex >= 0, 'request handler must call snipStaleToolResultBlocks');
  assert.ok(convertIndex >= 0, 'anthropicToOpenAI must consume the (possibly snipped) body');
  assert.ok(snipIndex < convertIndex, 'snipping must happen after body parse, before conversion');
});

// ---------------------------------------------------------------------------
// Runtime behavior against the compiled proxy
// ---------------------------------------------------------------------------

test('route parsing accepts /v1/messages and /s/<key>/v1/messages only', async () => {
  const proxy = await importCompiled('coworkOpenAICompatProxy');
  const { parseMessagesRouteSessionKey } = proxy.__openAICompatProxyTestUtils;

  assert.equal(parseMessagesRouteSessionKey('/v1/messages'), null);
  assert.equal(parseMessagesRouteSessionKey('/s/abc/v1/messages'), 'abc');
  assert.equal(parseMessagesRouteSessionKey('/s/a%20b/v1/messages'), 'a b');
  assert.equal(parseMessagesRouteSessionKey('/s/abc/v1/models'), undefined);
  assert.equal(parseMessagesRouteSessionKey('/v1/models'), undefined);
  assert.equal(parseMessagesRouteSessionKey('/s//v1/messages'), undefined);
  assert.equal(parseMessagesRouteSessionKey('/s/abc/v1/messages/extra'), undefined);
});

test('Anthropic SDK baseURL+path string concat lands on the session route', () => {
  // node_modules/@anthropic-ai/sdk/client.js builds request URLs as
  // new URL(baseURL + path) — verify the env-var shape the runner produces.
  const sessionId = 'cowork-session-1';
  const baseURL = `http://127.0.0.1:8080/s/${encodeURIComponent(sessionId)}`;
  const joined = new URL(baseURL + '/v1/messages');
  assert.equal(joined.pathname, '/s/cowork-session-1/v1/messages');
  // Trailing slashes are stripped by the runner before appending.
  const withSlash = `http://127.0.0.1:8080/s/${encodeURIComponent(sessionId)}`;
  assert.equal(new URL(withSlash + '/v1/messages').pathname, '/s/cowork-session-1/v1/messages');
});

test('snip boundary registry is monotonic and resettable (memory-only in tests)', async () => {
  const proxy = await importCompiled('coworkOpenAICompatProxy');
  const key = 'tool-result-snip-wiring-test';

  proxy.resetCoworkSnipHeadTokens(key);
  assert.equal(proxy.getCoworkSnipHeadTokens(key), 0);
  proxy.setCoworkSnipHeadTokens(key, 1000);
  assert.equal(proxy.getCoworkSnipHeadTokens(key), 1000);
  // Monotonic: lower values are ignored.
  proxy.setCoworkSnipHeadTokens(key, 500);
  assert.equal(proxy.getCoworkSnipHeadTokens(key), 1000);
  proxy.setCoworkSnipHeadTokens(key, 64_000);
  assert.equal(proxy.getCoworkSnipHeadTokens(key), 64_000);
  proxy.resetCoworkSnipHeadTokens(key);
  assert.equal(proxy.getCoworkSnipHeadTokens(key), 0);
  // Unknown sessions read as 0 and junk writes are ignored.
  assert.equal(proxy.getCoworkSnipHeadTokens('never-set'), 0);
  proxy.setCoworkSnipHeadTokens(key, Number.NaN);
  assert.equal(proxy.getCoworkSnipHeadTokens(key), 0);
});

test('a snipped request body survives anthropicToOpenAI with tool pairing intact', async () => {
  const snip = await importCompiled('coworkToolResultSnip');
  const { anthropicToOpenAI } = await importCompiled('coworkFormatTransform');

  // Mimic a CLI resume request: head tool_result is snipped, the tail one is not.
  const messages = [
    { role: 'user', content: 'start' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/tmp/a.txt' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'X'.repeat(8000) }] },
    { role: 'assistant', content: 'working on it' },
    { role: 'user', content: 'continue' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-2', name: 'Bash', input: { command: 'ls' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-2', content: 'Y'.repeat(4000) }] },
  ];
  const body = { model: 'deepseek-v4-pro', max_tokens: 8192, messages, stream: true };
  const snipResult = snip.snipStaleToolResultBlocks(body.messages, 2100);
  assert.equal(snipResult.stats.snippedBlocks, 1);

  const converted = anthropicToOpenAI({ ...body, messages: snipResult.messages });
  const toolMessages = converted.messages.filter((message) => message.role === 'tool');
  assert.equal(toolMessages.length, 2);
  assert.equal(toolMessages[0].tool_call_id, 'tu-1');
  assert.ok(toolMessages[0].content.includes('[snipped tool result'));
  assert.equal(toolMessages[1].tool_call_id, 'tu-2');
  assert.equal(toolMessages[1].content, 'Y'.repeat(4000));
  // Assistant tool_calls survive so DeepSeek's tool_call/tool pairing holds.
  const assistantCalls = converted.messages.flatMap((message) => message.tool_calls ?? []);
  assert.deepEqual(assistantCalls.map((call) => call.id).sort(), ['tu-1', 'tu-2']);
});
