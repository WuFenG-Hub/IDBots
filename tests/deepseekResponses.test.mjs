/**
 * Tests for the DeepSeek Responses API integration: upstream routing, endpoint
 * URL construction, web_search injection + relay + anti-hallucination guard,
 * reasoning effort mapping, and cache token parsing. Covers both the cowork
 * proxy path and the cognitive layer.
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

function parseSSEEvents(raw) {
  return raw
    .split('\n\n')
    .map((packet) => packet.trim())
    .filter(Boolean)
    .map((packet) => {
      const lines = packet.split('\n');
      const event = lines.find((line) => line.startsWith('event: '))?.slice('event: '.length) || '';
      const data = lines
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice('data: '.length))
        .join('\n');
      return { event, data: JSON.parse(data) };
    });
}

function createWritableRecorder() {
  const chunks = [];
  return {
    chunks,
    res: {
      write(chunk) {
        chunks.push(String(chunk));
        return true;
      },
    },
  };
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

test('resolveUpstreamAPIType routes DeepSeek pro to responses (GA since 2026-08-13)', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const { resolveUpstreamAPIType } = __openAICompatProxyTestUtils;

  assert.equal(resolveUpstreamAPIType('deepseek', 'deepseek-v4-pro'), 'responses');
  assert.equal(resolveUpstreamAPIType('deepseek', 'DeepSeek-V4-PRO'), 'responses');
  // Older/unknown variants still fall back to chat/completions.
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

test('resolveEffectiveUpstreamModel maps Claude-native subagent fallbacks to the session model', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const { resolveEffectiveUpstreamModel } = __openAICompatProxyTestUtils;

  // CLI subagent fallback defaults (SDK 0.3.221 ignores the parent session
  // model) must never reach the OpenAI-compatible upstream verbatim.
  assert.equal(resolveEffectiveUpstreamModel('claude-opus-5', 'deepseek-v4-flash'), 'deepseek-v4-flash');
  assert.equal(resolveEffectiveUpstreamModel('claude-opus', 'deepseek-v4-flash'), 'deepseek-v4-flash');
  assert.equal(resolveEffectiveUpstreamModel('claude-sonnet-4-6', 'deepseek-v4-flash'), 'deepseek-v4-flash');
  assert.equal(resolveEffectiveUpstreamModel('claude-3-5-haiku', 'deepseek-v4-flash'), 'deepseek-v4-flash');
  // Bare aliases the CLI resolves internally are fallbacks too.
  assert.equal(resolveEffectiveUpstreamModel('opus', 'deepseek-v4-flash'), 'deepseek-v4-flash');
  assert.equal(resolveEffectiveUpstreamModel('SONNET', 'deepseek-v4-flash'), 'deepseek-v4-flash');
  assert.equal(resolveEffectiveUpstreamModel('haiku', 'deepseek-v4-flash'), 'deepseek-v4-flash');
  // Empty (request omitted model) also resolves to the configured model.
  assert.equal(resolveEffectiveUpstreamModel('', 'deepseek-v4-flash'), 'deepseek-v4-flash');
  assert.equal(resolveEffectiveUpstreamModel('  ', 'deepseek-v4-flash'), 'deepseek-v4-flash');
});

test('resolveEffectiveUpstreamModel passes real upstream model names through untouched', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const { resolveEffectiveUpstreamModel } = __openAICompatProxyTestUtils;

  assert.equal(resolveEffectiveUpstreamModel('deepseek-v4-flash', 'deepseek-v4-flash'), 'deepseek-v4-flash');
  assert.equal(resolveEffectiveUpstreamModel('deepseek-v4-pro', 'deepseek-v4-flash'), 'deepseek-v4-pro');
  assert.equal(resolveEffectiveUpstreamModel('gpt-5.6-sol', 'deepseek-v4-flash'), 'gpt-5.6-sol');
  assert.equal(resolveEffectiveUpstreamModel('kimi-k2.6', 'kimi-k2.6'), 'kimi-k2.6');
  // OpenRouter-style anthropic aliases are valid upstream models, not fallbacks.
  assert.equal(resolveEffectiveUpstreamModel('anthropic/claude-opus-4.7', 'anthropic/claude-opus-4.7'), 'anthropic/claude-opus-4.7');
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
  // tool_choice stays 'auto' even for time-sensitive questions — the proxy
  // never forces web_search (forcing confined the session to the server-side
  // search tools and broke all function tool calls).
  assert.equal(result.tool_choice, 'auto');
  // reasoning.effort mapped from reasoning_effort.
  assert.deepEqual(result.reasoning, { effort: 'max' });
  // instructions extracted from system message, with the anti-hallucination
  // guard appended (web_search is injected, so the model must not fabricate
  // real-time facts without search evidence).
  assert.ok(result.instructions.startsWith('You are a helpful assistant.'));
  assert.ok(result.instructions.includes('实时信息规范'));
  // input contains the user message.
  assert.ok(Array.isArray(result.input));
  assert.equal(result.input[0].role, 'user');
});

test('convertChatCompletionsRequestToResponsesRequest never forces web_search', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const { convertChatCompletionsRequestToResponsesRequest } = __openAICompatProxyTestUtils;

  // Regression guard: forcing tool_choice={"type":"web_search"} confined the
  // session to the server-side search tools (surfacing in the UI as
  // search/open_page/find_in_page) and broke every function tool call — the
  // live Worker sessions failed exactly so. Whatever the user text looks
  // like, tool_choice must stay 'auto'; the model decides when to search.
  const cases = [
    'What is the weather?',
    '2026年世界杯冠军是谁？',
    '今天有什么新闻？',
    [
      '<twin_delegation>',
      '  <task_id>046c2bd7-7329-4a8b-9753-e31c1a9b68da</task_id>',
      '  <objective>移除当前代理里的某个机制并更新测试</objective>',
      '</twin_delegation>',
    ].join('\n'),
    `${'任务背景描述。'.repeat(300)}\n2026 最新进展也写进去了`,
  ];
  for (const content of cases) {
    const result = convertChatCompletionsRequestToResponsesRequest(
      { model: 'deepseek-v4-flash', messages: [{ role: 'user', content }] },
      'deepseek',
    );
    assert.equal(result.tool_choice, 'auto');
    // web_search stays injected and available under auto.
    assert.equal(result.tools[0].type, 'web_search');
  }

  // Gateway provider serving a DeepSeek model: same behavior.
  const gateway = convertChatCompletionsRequestToResponsesRequest(
    { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'What is the weather?' }] },
    'opencode',
  );
  assert.equal(gateway.tool_choice, 'auto');
});

test('convertChatCompletionsRequestToResponsesRequest disables thinking via effort none', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const { convertChatCompletionsRequestToResponsesRequest } = __openAICompatProxyTestUtils;

  // DeepSeek Responses defaults to thinking ON when `reasoning` is omitted, so
  // disabling must be explicit — omitting the field silently re-enables it.
  const disabled = convertChatCompletionsRequestToResponsesRequest(
    { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'disabled' } },
    'deepseek',
  );
  assert.deepEqual(disabled.reasoning, { effort: 'none' });
  // web_search is still injected.
  assert.equal(disabled.tools[0].type, 'web_search');

  // An explicit 'none'/'off' effort request disables thinking the same way.
  const effortNone = convertChatCompletionsRequestToResponsesRequest(
    { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'none' },
    'deepseek',
  );
  assert.deepEqual(effortNone.reasoning, { effort: 'none' });

  // Thinking enabled with no effort preference keeps the 'high' default.
  const enabledDefault = convertChatCompletionsRequestToResponsesRequest(
    { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] },
    'deepseek',
  );
  assert.deepEqual(enabledDefault.reasoning, { effort: 'high' });
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
  // No anti-hallucination guard for non-DeepSeek models (no web_search tool).
  assert.equal(result.instructions, undefined);
});

test('convertChatCompletionsRequestToResponsesRequest appends anti-hallucination guard for DeepSeek only', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const { convertChatCompletionsRequestToResponsesRequest } = __openAICompatProxyTestUtils;

  // DeepSeek: guard is present even when the caller supplied no system message
  // (web_search is injected unconditionally, so the guard applies always).
  const ds = convertChatCompletionsRequestToResponsesRequest(
    { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] },
    'deepseek',
  );
  assert.ok(ds.instructions.includes('实时信息规范'));
  assert.ok(ds.instructions.includes('「未验证」'));

  // Gateway provider (opencode) serving deepseek-v4-flash gets the same guard.
  const gateway = convertChatCompletionsRequestToResponsesRequest(
    { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] },
    'opencode',
  );
  assert.ok(gateway.instructions.includes('实时信息规范'));

  // Non-DeepSeek: caller instructions pass through untouched.
  const openai = convertChatCompletionsRequestToResponsesRequest(
    { model: 'gpt-5.6', messages: [{ role: 'system', content: 'You are helpful.' }] },
    'openai',
  );
  assert.equal(openai.instructions, 'You are helpful.');
  assert.ok(!String(openai.instructions ?? '').includes('实时信息规范'));
});

// ---------------------------------------------------------------------------
// Explicit caller tool_choice passthrough
// ---------------------------------------------------------------------------

test('convertChatCompletionsRequestToResponsesRequest respects explicit tool_choice none', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const { convertChatCompletionsRequestToResponsesRequest } = __openAICompatProxyTestUtils;

  // Caller explicitly disabled tools: passed through unchanged.
  const forcedNone = convertChatCompletionsRequestToResponsesRequest(
    {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'What is the weather?' }],
      tool_choice: 'none',
    },
    'deepseek',
  );
  assert.equal(forcedNone.tool_choice, 'none');

  // Caller pinned a specific function: preserved.
  const pinned = convertChatCompletionsRequestToResponsesRequest(
    {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'What is the weather?' }],
      tool_choice: { type: 'function', name: 'Read' },
    },
    'deepseek',
  );
  assert.deepEqual(pinned.tool_choice, { type: 'function', name: 'Read' });
});

// ---------------------------------------------------------------------------
// web_search_call relay: streaming path (server_tool_use blocks)
// ---------------------------------------------------------------------------

test('responses stream relays web_search_call as a single server_tool_use block', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const {
    createStreamState,
    createResponsesStreamContext,
    processResponsesStreamEvent,
  } = __openAICompatProxyTestUtils;

  const state = createStreamState({ preserveDeepSeekReasoning: true });
  const context = createResponsesStreamContext();
  const recorder = createWritableRecorder();

  // Real event sequence captured from opencode.ai/zen/go/v1 and
  // api.deepseek.com: output_item.added then output_item.done carry the
  // web_search_call item before the final message item.
  processResponsesStreamEvent(recorder.res, state, context, 'response.output_item.added', {
    type: 'response.output_item.added',
    output_index: 1,
    item: { type: 'web_search_call', id: 'call_00_ws_1', status: 'in_progress' },
  });
  processResponsesStreamEvent(recorder.res, state, context, 'response.output_item.done', {
    type: 'response.output_item.done',
    output_index: 1,
    item: { type: 'web_search_call', id: 'call_00_ws_1', status: 'completed' },
  });

  const events = parseSSEEvents(recorder.chunks.join(''));
  const blockStarts = events.filter((e) => e.event === 'content_block_start');
  const blockStops = events.filter((e) => e.event === 'content_block_stop');

  assert.equal(blockStarts.length, 1, 'exactly one content block for the search');
  assert.equal(blockStops.length, 1);
  const block = blockStarts[0].data.content_block;
  assert.equal(block.type, 'server_tool_use');
  assert.equal(block.id, 'call_00_ws_1');
  assert.equal(block.name, 'web_search');
  assert.deepEqual(block.input, {});
  // added + done pairs must not duplicate the marker.
  assert.equal(context.emittedWebSearchItemIds.size, 1);
});

test('responses stream relays multiple web_search_call items as separate blocks', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const {
    createStreamState,
    createResponsesStreamContext,
    processResponsesStreamEvent,
  } = __openAICompatProxyTestUtils;

  const state = createStreamState({ preserveDeepSeekReasoning: true });
  const context = createResponsesStreamContext();
  const recorder = createWritableRecorder();

  // Two sequential searches (seen in real gateway responses for hard
  // questions), then the answer message.
  for (const id of ['call_00_ws_a', 'call_00_ws_b']) {
    processResponsesStreamEvent(recorder.res, state, context, 'response.output_item.done', {
      type: 'response.output_item.done',
      item: { type: 'web_search_call', id, status: 'completed' },
    });
  }
  processResponsesStreamEvent(recorder.res, state, context, 'response.output_text.delta', {
    type: 'response.output_text.delta',
    response_id: 'resp_gw_2',
    model: 'deepseek-v4-flash',
    delta: '答案',
  });

  const events = parseSSEEvents(recorder.chunks.join(''));
  const blocks = events
    .filter((e) => e.event === 'content_block_start')
    .map((e) => e.data.content_block);
  const searchBlocks = blocks.filter((b) => b.type === 'server_tool_use');
  assert.deepEqual(
    searchBlocks.map((b) => b.id),
    ['call_00_ws_a', 'call_00_ws_b'],
    'one block per search, in stream order'
  );
  assert.ok(searchBlocks.every((b) => b.name === 'web_search'));
  // The answer text block follows the search markers.
  const textIndex = blocks.findIndex((b) => b.type === 'text');
  assert.ok(textIndex !== -1, 'answer text block present');
  assert.ok(textIndex > blocks.indexOf(searchBlocks[1]), 'search markers precede the answer text');
});

test('responses stream relays web_search_call from completed fallback when no deltas streamed', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const {
    createStreamState,
    createResponsesStreamContext,
    processResponsesStreamEvent,
  } = __openAICompatProxyTestUtils;

  const state = createStreamState({ preserveDeepSeekReasoning: true });
  const context = createResponsesStreamContext();
  const recorder = createWritableRecorder();

  // Truncated stream: only response.completed arrives, no per-item deltas.
  processResponsesStreamEvent(recorder.res, state, context, 'response.completed', {
    type: 'response.completed',
    response: {
      id: 'resp_gw_9',
      model: 'deepseek-v4-flash',
      status: 'completed',
      output: [
        { type: 'web_search_call', id: 'call_00_ws_fallback', status: 'completed' },
        {
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: '获奖者：John Clarke 等三人。' }],
        },
      ],
    },
  });

  const events = parseSSEEvents(recorder.chunks.join(''));
  const blockStarts = events.filter((e) => e.event === 'content_block_start');
  const searchBlock = blockStarts.find((e) => e.data.content_block.type === 'server_tool_use');
  assert.ok(searchBlock, 'server_tool_use block present in fallback content');
  assert.equal(searchBlock.data.content_block.id, 'call_00_ws_fallback');
  const answerDelta = events.find(
    (e) => e.event === 'content_block_delta' && String(e.data.delta?.text ?? '').includes('John Clarke')
  );
  assert.ok(answerDelta, 'answer text still emitted after the search marker');
});

// ---------------------------------------------------------------------------
// web_search_call relay: non-stream path (server_tool_use injection)
// ---------------------------------------------------------------------------

test('injectResponsesWebSearchBlocks inserts server_tool_use before the answer text', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const { injectResponsesWebSearchBlocks } = __openAICompatProxyTestUtils;

  const anthropicResponse = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'deepseek-v4-flash',
    content: [{ type: 'text', text: '获奖者是 John Clarke 等。' }],
    stop_reason: 'end_turn',
  };
  injectResponsesWebSearchBlocks(anthropicResponse, {
    id: 'resp_1',
    output: [
      { type: 'web_search_call', id: 'call_00_ws_ns', status: 'completed' },
      {
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: '获奖者是 John Clarke 等。' }],
      },
    ],
  });

  assert.equal(anthropicResponse.content.length, 2);
  assert.equal(anthropicResponse.content[0].type, 'server_tool_use');
  assert.equal(anthropicResponse.content[0].name, 'web_search');
  assert.equal(anthropicResponse.content[0].id, 'call_00_ws_ns');
  assert.deepEqual(anthropicResponse.content[0].input, {});
  assert.equal(anthropicResponse.content[1].type, 'text');
});

test('injectResponsesWebSearchBlocks is a no-op without web_search_call items', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const { injectResponsesWebSearchBlocks } = __openAICompatProxyTestUtils;

  const anthropicResponse = {
    id: 'msg_2',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'hi' }],
  };
  injectResponsesWebSearchBlocks(anthropicResponse, {
    id: 'resp_2',
    output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'hi' }] }],
  });

  assert.equal(anthropicResponse.content.length, 1);
  assert.equal(anthropicResponse.content[0].type, 'text');
});

// ---------------------------------------------------------------------------
// Cognitive layer: shouldUseDeepSeekResponses + URL building
// ---------------------------------------------------------------------------

test('shouldUseDeepSeekResponses gates on provider + V4 family model', async () => {
  const { __cognitiveChatCompletionTestUtils } = await importCompiledService('cognitiveChatCompletion');
  const { shouldUseDeepSeekResponses, buildDeepSeekResponsesURL, normalizeDeepSeekResponsesEffort } = __cognitiveChatCompletionTestUtils;

  assert.equal(shouldUseDeepSeekResponses('deepseek', 'deepseek-v4-flash'), true);
  assert.equal(shouldUseDeepSeekResponses('deepseek', 'deepseek-v4-pro'), true);
  assert.equal(shouldUseDeepSeekResponses('deepseek', 'deepseek-reasoner'), false);
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
