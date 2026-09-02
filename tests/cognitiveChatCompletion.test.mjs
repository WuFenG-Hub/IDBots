import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);

function loadTestUtils() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => process.cwd(),
        },
        BrowserWindow: { getAllWindows: () => [] },
        session: {},
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    const compiledRoot = require.resolve('../dist-electron/main/services/cognitiveChatCompletion.js');
    return require(compiledRoot).__cognitiveChatCompletionTestUtils;
  } catch {
    return require('../dist-electron/services/cognitiveChatCompletion.js').__cognitiveChatCompletionTestUtils;
  } finally {
    Module._load = originalLoad;
  }
}

const { resolveThinkingForModel, extractAnthropicThinkingText, resolveDeepSeekResponsesReasoning, resolveDefaultMaxOutputTokens, buildDeepSeekResponsesTools } = loadTestUtils();

test('one-shot completion reads the Anthropic thinking field emitted by the proxy', () => {
  assert.equal(
    extractAnthropicThinkingText({ type: 'thinking', thinking: 'provider reasoning' }),
    'provider reasoning',
  );
  assert.equal(
    extractAnthropicThinkingText({ type: 'thinking', text: 'legacy reasoning' }),
    'legacy reasoning',
  );
  assert.equal(extractAnthropicThinkingText({ type: 'text', text: 'final answer' }), '');
});

test('thinking controls are sent only to compatible DeepSeek models', () => {
  assert.equal(resolveThinkingForModel('deepseek-v4-flash', 'disabled'), 'disabled');
  assert.equal(resolveThinkingForModel('deepseek-reasoner', 'enabled'), 'enabled');
  assert.equal(resolveThinkingForModel('claude-sonnet-4-6', 'disabled'), undefined);
  assert.equal(resolveThinkingForModel('gpt-5.6-sol', 'disabled'), undefined);
});

test('DeepSeek Responses reasoning disable must be explicit effort none', () => {
  // Omitting `reasoning` leaves DeepSeek's server-side default (thinking ON,
  // effort high) in effect — the 2026-08-08 dream-diary outage root cause.
  assert.deepEqual(resolveDeepSeekResponsesReasoning('disabled'), { effort: 'none' });
  assert.deepEqual(resolveDeepSeekResponsesReasoning('enabled'), { effort: 'max' });
  assert.deepEqual(resolveDeepSeekResponsesReasoning(undefined), { effort: 'max' });
});

test('default output budget leaves headroom for thinking-mode reasoning', () => {
  // Reasoning shares the output budget: thinking-enabled calls get 16K,
  // thinking-disabled calls keep the lean 4K default.
  assert.equal(resolveDefaultMaxOutputTokens('disabled'), 4_096);
  assert.equal(resolveDefaultMaxOutputTokens('enabled'), 16_384);
  assert.equal(resolveDefaultMaxOutputTokens(undefined), 16_384);
});

test('Responses tools keep the default web_search injection for chat callers', () => {
  // 982fca66 product behavior: flash/pro chat via the Responses API carries
  // the built-in web_search tool first, caller tools after.
  assert.deepEqual(buildDeepSeekResponsesTools(undefined, undefined), [{ type: 'web_search' }]);
  assert.deepEqual(buildDeepSeekResponsesTools(undefined, true), [{ type: 'web_search' }]);
  const callerTool = { type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } };
  assert.deepEqual(buildDeepSeekResponsesTools([callerTool], undefined), [
    { type: 'web_search' },
    { type: 'function', name: 'lookup', parameters: { type: 'object' } },
  ]);
});

test('webSearch:false strips the built-in search from the Responses tools', () => {
  // Structured JSON tasks (deep-consolidation, culture distillation, dream)
  // opt out: a stray search call derails the JSON contract — the 2026-09-02
  // "unparseable output" root cause.
  const callerTool = { type: 'function', function: { name: 'lookup' } };
  assert.deepEqual(buildDeepSeekResponsesTools([callerTool], false), [
    { type: 'function', name: 'lookup', parameters: {} },
  ]);
  // No caller tools + opt-out means the request body must omit tools entirely.
  assert.deepEqual(buildDeepSeekResponsesTools(undefined, false), []);
});
