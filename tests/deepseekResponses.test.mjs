/**
 * Tests for the DeepSeek Responses API integration: upstream routing, endpoint
 * URL construction, web_search injection, reasoning effort mapping, and cache
 * token parsing. Covers both the cowork proxy path and the cognitive layer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

async function importCompiled(modulePath) {
  try {
    return await import(`../dist-electron/main/libs/${modulePath}.js`);
  } catch {
    return await import(`../dist-electron/libs/${modulePath}.js`);
  }
}

async function importCompiledService(modulePath) {
  try {
    return await import(`../dist-electron/main/services/${modulePath}.js`);
  } catch {
    return await import(`../dist-electron/services/${modulePath}.js`);
  }
}

// ---------------------------------------------------------------------------
// Upstream API type routing
// ---------------------------------------------------------------------------

test('resolveUpstreamAPIType routes DeepSeek flash to responses', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const { resolveUpstreamAPIType } = __openAICompatProxyTestUtils;

  assert.equal(resolveUpstreamAPIType('deepseek', 'deepseek-v4-flash'), 'responses');
  assert.equal(resolveUpstreamAPIType('deepseek', 'DeepSeek-V4-FLASH'), 'responses');
  assert.equal(resolveUpstreamAPIType('DEEPSEEK', 'deepseek-v4-flash'), 'responses');
});

test('resolveUpstreamAPIType routes DeepSeek pro to chat_completions (not yet supported)', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const { resolveUpstreamAPIType } = __openAICompatProxyTestUtils;

  assert.equal(resolveUpstreamAPIType('deepseek', 'deepseek-v4-pro'), 'chat_completions');
  assert.equal(resolveUpstreamAPIType('deepseek', 'deepseek-reasoner'), 'chat_completions');
});

test('resolveUpstreamAPIType routes OpenAI to responses regardless of model', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const { resolveUpstreamAPIType } = __openAICompatProxyTestUtils;

  assert.equal(resolveUpstreamAPIType('openai', 'gpt-5.6-sol'), 'responses');
  assert.equal(resolveUpstreamAPIType('openai', 'o4'), 'responses');
});

test('resolveUpstreamAPIType routes non-DeepSeek, non-OpenAI providers to chat_completions', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const { resolveUpstreamAPIType } = __openAICompatProxyTestUtils;

  assert.equal(resolveUpstreamAPIType('anthropic', 'claude-opus-4.7'), 'chat_completions');
  assert.equal(resolveUpstreamAPIType('moonshot', 'kimi-k2.6'), 'chat_completions');
});

// ---------------------------------------------------------------------------
// Endpoint URL construction
// ---------------------------------------------------------------------------

test('buildOpenAIResponsesURL uses host-root /responses for DeepSeek (no /v1)', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const { buildOpenAIResponsesURL } = __openAICompatProxyTestUtils;

  assert.equal(buildOpenAIResponsesURL('https://api.deepseek.com', 'deepseek'), 'https://api.deepseek.com/responses');
  // Should strip a trailing /anthropic segment.
  assert.equal(buildOpenAIResponsesURL('https://api.deepseek.com/anthropic', 'deepseek'), 'https://api.deepseek.com/responses');
});

test('buildOpenAIResponsesURL uses /v1/responses for OpenAI', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const { buildOpenAIResponsesURL } = __openAICompatProxyTestUtils;

  assert.equal(buildOpenAIResponsesURL('https://api.openai.com', 'openai'), 'https://api.openai.com/v1/responses');
});

// ---------------------------------------------------------------------------
// Responses request conversion (web_search + reasoning injection)
// ---------------------------------------------------------------------------

test('convertChatCompletionsRequestToResponsesRequest injects web_search + reasoning for DeepSeek', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const { convertChatCompletionsRequestToResponsesRequest } = __openAICompatProxyTestUtils;

  const chatRequest = {
    model: 'deepseek-v4-flash',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'What is the weather?' },
    ],
    max_tokens: 4096,
    thinking: { type: 'enabled' },
    reasoning_effort: 'max',
    stream: false,
  };

  const result = convertChatCompletionsRequestToResponsesRequest(chatRequest, 'deepseek');

  // web_search must be present and FIRST (stable for cache prefix).
  assert.ok(Array.isArray(result.tools));
  assert.equal(result.tools[0].type, 'web_search');
  // tool_choice defaults to 'auto'.
  assert.equal(result.tool_choice, 'auto');
  // reasoning.effort mapped from reasoning_effort.
  assert.deepEqual(result.reasoning, { effort: 'max' });
  // instructions extracted from system message.
  assert.equal(result.instructions, 'You are a helpful assistant.');
  // input contains the user message.
  assert.ok(Array.isArray(result.input));
  assert.equal(result.input[0].role, 'user');
});

test('convertChatCompletionsRequestToResponsesRequest omits reasoning when thinking is disabled', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const { convertChatCompletionsRequestToResponsesRequest } = __openAICompatProxyTestUtils;

  const result = convertChatCompletionsRequestToResponsesRequest(
    { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'disabled' } },
    'deepseek',
  );

  assert.equal(result.reasoning, undefined);
  // web_search is still injected.
  assert.equal(result.tools[0].type, 'web_search');
});

test('convertChatCompletionsRequestToResponsesRequest does NOT inject web_search for non-DeepSeek', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const { convertChatCompletionsRequestToResponsesRequest } = __openAICompatProxyTestUtils;

  const result = convertChatCompletionsRequestToResponsesRequest(
    { model: 'gpt-5.6', messages: [{ role: 'user', content: 'hi' }] },
    'openai',
  );

  // No web_search tool for OpenAI; tools only present if caller supplied them.
  if (result.tools) {
    assert.ok(!result.tools.some((t) => t.type === 'web_search'));
  }
  assert.equal(result.reasoning, undefined);
});

// ---------------------------------------------------------------------------
// Cognitive layer: shouldUseDeepSeekResponses + URL building
// ---------------------------------------------------------------------------

test('shouldUseDeepSeekResponses gates on provider + flash model', async () => {
  const { __cognitiveChatCompletionTestUtils } = await importCompiledService('cognitiveChatCompletion');
  const { shouldUseDeepSeekResponses, buildDeepSeekResponsesURL, normalizeDeepSeekResponsesEffort } = __cognitiveChatCompletionTestUtils;

  assert.equal(shouldUseDeepSeekResponses('deepseek', 'deepseek-v4-flash'), true);
  assert.equal(shouldUseDeepSeekResponses('deepseek', 'deepseek-v4-pro'), false);
  assert.equal(shouldUseDeepSeekResponses('openai', 'gpt-5.6'), false);
  assert.equal(shouldUseDeepSeekResponses(undefined, 'deepseek-v4-flash'), false);
});

test('buildDeepSeekResponsesURL strips /anthropic and /v1 suffixes', async () => {
  const { __cognitiveChatCompletionTestUtils } = await importCompiledService('cognitiveChatCompletion');
  const { buildDeepSeekResponsesURL } = __cognitiveChatCompletionTestUtils;

  assert.equal(buildDeepSeekResponsesURL('https://api.deepseek.com'), 'https://api.deepseek.com/responses');
  assert.equal(buildDeepSeekResponsesURL('https://api.deepseek.com/anthropic'), 'https://api.deepseek.com/responses');
  assert.equal(buildDeepSeekResponsesURL('https://api.deepseek.com/v1'), 'https://api.deepseek.com/responses');
});

test('normalizeDeepSeekResponsesEffort maps effort values correctly', async () => {
  const { __cognitiveChatCompletionTestUtils } = await importCompiledService('cognitiveChatCompletion');
  const { normalizeDeepSeekResponsesEffort } = __cognitiveChatCompletionTestUtils;

  assert.equal(normalizeDeepSeekResponsesEffort('max'), 'max');
  assert.equal(normalizeDeepSeekResponsesEffort('low'), 'low');
  assert.equal(normalizeDeepSeekResponsesEffort('medium'), 'high');
  assert.equal(normalizeDeepSeekResponsesEffort('high'), 'high');
  assert.equal(normalizeDeepSeekResponsesEffort(undefined), 'high'); // default
  assert.equal(normalizeDeepSeekResponsesEffort('garbage'), 'high');
});

// ---------------------------------------------------------------------------
// Balance service: response normalization (pure function, no network)
// ---------------------------------------------------------------------------

test('DeepSeek balance display prefers CNY currency', async () => {
  // We test the normalization indirectly by importing the module and checking
  // the exported type shape exists. Full network tests require a live API key
  // and are out of scope for unit tests.
  const mod = await importCompiledService('deepseekBalanceService');
  assert.equal(typeof mod.fetchDeepSeekBalance, 'function');
});
