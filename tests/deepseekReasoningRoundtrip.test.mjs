import test from 'node:test';
import assert from 'node:assert/strict';

async function importCompiled(modulePath) {
  try {
    return await import(`../dist-electron/main/libs/${modulePath}.js`);
  } catch {
    return import(`../dist-electron/libs/${modulePath}.js`);
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
// Regression: reasoning pass-back must apply to gateway providers (e.g. the
// opencode "Console Go" upstream) that serve DeepSeek thinking models, even
// though their provider name / base URL carry no "deepseek" marker.
// ---------------------------------------------------------------------------

test('hydration applies to gateway provider (opencode) serving deepseek-v4-flash', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const { hydrateDeepSeekReasoningForRequest, resetDeepSeekReasoningCache } = __openAICompatProxyTestUtils;
  resetDeepSeekReasoningCache();

  const request = {
    model: 'deepseek-v4-flash',
    messages: [{
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_gw_1',
        type: 'function',
        function: { name: 'Bash', arguments: '{"command":"ls"}' },
      }],
    }],
  };

  const hydrateResult = hydrateDeepSeekReasoningForRequest(
    request,
    'opencode',
    'https://opencode.ai/zen/go/v1'
  );

  // The tool-call message must carry reasoning_content (empty placeholder here,
  // since nothing was cached) so the upstream DeepSeek thinking API accepts it.
  assert.deepEqual(hydrateResult, { ok: true, hydratedCount: 0, placeholderCount: 1 });
  assert.equal(request.messages[0].reasoning_content, '');
});

test('hydration restores cached reasoning for gateway provider tool calls', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const {
    createStreamState,
    processOpenAIChunk,
    hydrateDeepSeekReasoningForRequest,
    resetDeepSeekReasoningCache,
  } = __openAICompatProxyTestUtils;
  resetDeepSeekReasoningCache();

  const state = createStreamState({ preserveDeepSeekReasoning: true });
  const recorder = createWritableRecorder();

  // Simulate a gateway chat-completions stream carrying reasoning_content.
  processOpenAIChunk(recorder.res, state, {
    id: 'chatcmpl_gw_1',
    model: 'deepseek-v4-flash',
    choices: [{ delta: { reasoning_content: 'need to inspect git state first' } }],
  });
  processOpenAIChunk(recorder.res, state, {
    id: 'chatcmpl_gw_1',
    model: 'deepseek-v4-flash',
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call_gw_2',
          type: 'function',
          function: { name: 'Bash', arguments: '{"command":"git status"}' },
        }],
      },
    }],
  });

  const request = {
    model: 'deepseek-v4-flash',
    messages: [{
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_gw_2',
        type: 'function',
        function: { name: 'Bash', arguments: '{"command":"git status"}' },
      }],
    }],
  };

  const hydrateResult = hydrateDeepSeekReasoningForRequest(
    request,
    'opencode',
    'https://opencode.ai/zen/go/v1'
  );

  assert.deepEqual(hydrateResult, { ok: true, hydratedCount: 1, placeholderCount: 0 });
  assert.equal(request.messages[0].reasoning_content, 'need to inspect git state first');
});

test('hydration is skipped for non-DeepSeek models on the same gateway', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const { hydrateDeepSeekReasoningForRequest, resetDeepSeekReasoningCache } = __openAICompatProxyTestUtils;
  resetDeepSeekReasoningCache();

  const request = {
    model: 'gpt-5.6-sol',
    messages: [{
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_non_ds',
        type: 'function',
        function: { name: 'Bash', arguments: '{}' },
      }],
    }],
  };

  const hydrateResult = hydrateDeepSeekReasoningForRequest(request, 'opencode', 'https://opencode.ai/zen/go/v1');

  assert.deepEqual(hydrateResult, { ok: true, hydratedCount: 0, placeholderCount: 0 });
  assert.equal(request.messages[0].reasoning_content, undefined);
});

// ---------------------------------------------------------------------------
// Responses API: `reasoning` input items must be emitted for DeepSeek thinking
// turns (the upstream rejects requests whose tool-call turns lack reasoning).
// ---------------------------------------------------------------------------

test('responses conversion emits reasoning item before assistant tool-call message', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const { convertChatCompletionsRequestToResponsesRequest } = __openAICompatProxyTestUtils;

  const responsesRequest = convertChatCompletionsRequestToResponsesRequest({
    model: 'deepseek-v4-flash',
    messages: [
      { role: 'user', content: 'Inspect the repo' },
      {
        role: 'assistant',
        content: 'Let me check git status first.',
        reasoning_content: 'The user wants repo state; git status is the fastest signal.',
        tool_calls: [{
          id: 'call_r1',
          type: 'function',
          function: { name: 'Bash', arguments: '{"command":"git status"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_r1', content: 'On branch main' },
    ],
  }, 'deepseek');

  const reasoningItems = responsesRequest.input.filter((item) => item.type === 'reasoning');
  assert.equal(reasoningItems.length, 1);
  assert.deepEqual(reasoningItems[0].content, [{
    type: 'reasoning_text',
    text: 'The user wants repo state; git status is the fastest signal.',
  }]);

  const messageIndex = responsesRequest.input.findIndex((item) => (
    item.type === undefined || item.type === 'message'
  ) && item.role === 'assistant');
  const functionCallIndex = responsesRequest.input.findIndex((item) => item.type === 'function_call');
  const reasoningIndex = responsesRequest.input.findIndex((item) => item.type === 'reasoning');
  // reasoning must precede both the assistant message and the function call
  assert.ok(reasoningIndex < messageIndex);
  assert.ok(reasoningIndex < functionCallIndex);
});

test('responses conversion falls back to a constant placeholder for lost reasoning', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const { convertChatCompletionsRequestToResponsesRequest } = __openAICompatProxyTestUtils;

  const responsesRequest = convertChatCompletionsRequestToResponsesRequest({
    model: 'deepseek-v4-flash',
    messages: [
      { role: 'user', content: 'Inspect the repo' },
      {
        role: 'assistant',
        content: 'Let me check git status first.',
        reasoning_content: '',
        tool_calls: [{
          id: 'call_r2',
          type: 'function',
          function: { name: 'Bash', arguments: '{"command":"git status"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_r2', content: 'On branch main' },
    ],
  }, 'deepseek');

  const reasoningItems = responsesRequest.input.filter((item) => item.type === 'reasoning');
  assert.equal(reasoningItems.length, 1);
  assert.equal(reasoningItems[0].content[0].text, '[reasoning unavailable]');
});

test('responses conversion does not emit reasoning items for non-DeepSeek models', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const { convertChatCompletionsRequestToResponsesRequest } = __openAICompatProxyTestUtils;

  const responsesRequest = convertChatCompletionsRequestToResponsesRequest({
    model: 'gpt-5.6-sol',
    messages: [
      { role: 'user', content: 'Inspect the repo' },
      {
        role: 'assistant',
        content: 'Let me check git status first.',
        reasoning_content: 'irrelevant for openai responses input',
        tool_calls: [{
          id: 'call_openai',
          type: 'function',
          function: { name: 'Bash', arguments: '{}' },
        }],
      },
    ],
  }, 'openai');

  const reasoningItems = responsesRequest.input.filter((item) => item.type === 'reasoning');
  assert.equal(reasoningItems.length, 0);
});

// ---------------------------------------------------------------------------
// Responses streaming: `response.reasoning_text.delta` (DeepSeek's event name)
// must be forwarded to the client and cached for future request hydration.
// ---------------------------------------------------------------------------

test('responses stream forwards response.reasoning_text.delta and caches it for tool calls', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const {
    createStreamState,
    createResponsesStreamContext,
    processResponsesStreamEvent,
    hydrateDeepSeekReasoningForRequest,
    resetDeepSeekReasoningCache,
  } = __openAICompatProxyTestUtils;
  resetDeepSeekReasoningCache();

  const state = createStreamState({ preserveDeepSeekReasoning: true });
  const context = createResponsesStreamContext();
  const recorder = createWritableRecorder();

  processResponsesStreamEvent(recorder.res, state, context, 'response.reasoning_text.delta', {
    type: 'response.reasoning_text.delta',
    response_id: 'resp_gw_1',
    model: 'deepseek-v4-flash',
    item_id: 'rs_1',
    output_index: 0,
    delta: 'The user wants repo state',
  });
  processResponsesStreamEvent(recorder.res, state, context, 'response.reasoning_text.delta', {
    type: 'response.reasoning_text.delta',
    response_id: 'resp_gw_1',
    model: 'deepseek-v4-flash',
    item_id: 'rs_1',
    output_index: 0,
    delta: '; git status is fastest.',
  });
  processResponsesStreamEvent(recorder.res, state, context, 'response.output_item.done', {
    type: 'response.output_item.done',
    response_id: 'resp_gw_1',
    model: 'deepseek-v4-flash',
    item: {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_resp_1',
      name: 'Bash',
      arguments: '{"command":"git status"}',
    },
  });

  const sseEvents = parseSSEEvents(recorder.chunks.join(''));
  const thinkingDeltas = sseEvents
    .filter((item) => (
      item.event === 'content_block_delta'
      && item.data.delta?.type === 'thinking_delta'
    ))
    .map((item) => item.data.delta.thinking);
  assert.equal(thinkingDeltas.join(''), 'The user wants repo state; git status is fastest.');

  // The reasoning must now be restorable for the tool call in a later request.
  const request = {
    model: 'deepseek-v4-flash',
    messages: [{
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_resp_1',
        type: 'function',
        function: { name: 'Bash', arguments: '{"command":"git status"}' },
      }],
    }],
  };
  const hydrateResult = hydrateDeepSeekReasoningForRequest(request, 'deepseek', 'https://api.deepseek.com');
  assert.deepEqual(hydrateResult, { ok: true, hydratedCount: 1, placeholderCount: 0 });
  assert.equal(request.messages[0].reasoning_content, 'The user wants repo state; git status is fastest.');
});

test('responses stream emits reasoning once from the *_done event when no deltas arrived', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const {
    createStreamState,
    createResponsesStreamContext,
    processResponsesStreamEvent,
  } = __openAICompatProxyTestUtils;

  const state = createStreamState({ preserveDeepSeekReasoning: true });
  const context = createResponsesStreamContext();
  const recorder = createWritableRecorder();

  processResponsesStreamEvent(recorder.res, state, context, 'response.reasoning_text.done', {
    type: 'response.reasoning_text.done',
    response_id: 'resp_done_1',
    model: 'deepseek-v4-flash',
    item_id: 'rs_done_1',
    output_index: 0,
    text: 'Full chain-of-thought delivered on done only.',
  });

  const sseEvents = parseSSEEvents(recorder.chunks.join(''));
  const thinkingDeltas = sseEvents
    .filter((item) => (
      item.event === 'content_block_delta'
      && item.data.delta?.type === 'thinking_delta'
    ))
    .map((item) => item.data.delta.thinking);
  assert.deepEqual(thinkingDeltas, ['Full chain-of-thought delivered on done only.']);
});

test('responses stream does not duplicate reasoning when deltas already streamed', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const {
    createStreamState,
    createResponsesStreamContext,
    processResponsesStreamEvent,
  } = __openAICompatProxyTestUtils;

  const state = createStreamState({ preserveDeepSeekReasoning: true });
  const context = createResponsesStreamContext();
  const recorder = createWritableRecorder();

  processResponsesStreamEvent(recorder.res, state, context, 'response.reasoning_text.delta', {
    type: 'response.reasoning_text.delta',
    response_id: 'resp_dedup_1',
    model: 'deepseek-v4-flash',
    delta: 'streamed part',
  });
  processResponsesStreamEvent(recorder.res, state, context, 'response.reasoning_text.done', {
    type: 'response.reasoning_text.done',
    response_id: 'resp_dedup_1',
    model: 'deepseek-v4-flash',
    text: 'streamed part plus more that must not be re-emitted',
  });

  const sseEvents = parseSSEEvents(recorder.chunks.join(''));
  const thinkingDeltas = sseEvents
    .filter((item) => (
      item.event === 'content_block_delta'
      && item.data.delta?.type === 'thinking_delta'
    ))
    .map((item) => item.data.delta.thinking);
  assert.deepEqual(thinkingDeltas, ['streamed part']);
});
