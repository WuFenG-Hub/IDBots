import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const distMain = path.resolve(import.meta.dirname, '../dist-electron/main');

async function importCompiled(modulePath) {
  return import(pathToFileURL(path.join(distMain, 'libs', `${modulePath}.js`)).href);
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

function parseSSEEvents(text) {
  const events = [];
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n');
    let event = null;
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) continue;
    const data = JSON.parse(dataLines.join('\n'));
    events.push({ event, data });
  }
  return events;
}

// Reproduces how DeepSeek chat/completions streams report usage. With
// stream_options.include_usage=true the FINAL chunk carries usage and an
// EMPTY choices array (OpenAI convention):
//   {"choices": [], "usage": {"prompt_tokens":..,"completion_tokens":..,
//    "prompt_cache_hit_tokens":..,"prompt_cache_miss_tokens":..}}
test('usage-only chunk (choices: []) must surface real cache tokens in message_delta', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const { createStreamState, processOpenAIChunk } = __openAICompatProxyTestUtils;

  const state = createStreamState({ preserveDeepSeekReasoning: true });
  const recorder = createWritableRecorder();

  // Stream: content chunk, finish chunk, then the FINAL usage-only chunk.
  processOpenAIChunk(recorder.res, state, {
    id: 'chatcmpl_usage',
    model: 'deepseek-v4-pro',
    choices: [{ delta: { content: 'hello' } }],
  });
  processOpenAIChunk(recorder.res, state, {
    id: 'chatcmpl_usage',
    model: 'deepseek-v4-pro',
    choices: [{ delta: {}, finish_reason: 'stop' }],
  });
  processOpenAIChunk(recorder.res, state, {
    id: 'chatcmpl_usage',
    model: 'deepseek-v4-pro',
    choices: [],
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 50,
      prompt_cache_hit_tokens: 900,
      prompt_cache_miss_tokens: 100,
    },
  });

  const events = parseSSEEvents(recorder.chunks.join(''));
  const deltas = events.filter((item) => item.event === 'message_delta');
  assert.ok(deltas.length >= 1, 'at least one message_delta must be emitted');
  const lastDelta = deltas[deltas.length - 1];
  assert.equal(lastDelta.data.usage.input_tokens, 1000, 'input_tokens must be real');
  assert.equal(lastDelta.data.usage.cache_read_input_tokens, 900, 'cache hit tokens must be real');
  assert.equal(lastDelta.data.usage.cache_creation_input_tokens, 100, 'cache miss tokens must be real');
});

// Some relays attach usage to the finish chunk itself; this must keep working.
test('finish chunk carrying usage is mapped to Anthropic cache fields', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const { createStreamState, processOpenAIChunk } = __openAICompatProxyTestUtils;

  const state = createStreamState({ preserveDeepSeekReasoning: true });
  const recorder = createWritableRecorder();

  processOpenAIChunk(recorder.res, state, {
    id: 'chatcmpl_finish_usage',
    model: 'deepseek-v4-pro',
    choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 2000,
      completion_tokens: 30,
      prompt_cache_hit_tokens: 1800,
      prompt_cache_miss_tokens: 200,
    },
  });

  const events = parseSSEEvents(recorder.chunks.join(''));
  const deltas = events.filter((item) => item.event === 'message_delta');
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].data.usage.cache_read_input_tokens, 1800);
  assert.equal(deltas[0].data.usage.cache_creation_input_tokens, 200);
});

// The usage-only chunk must be COLLECTED on the stream state (never silently
// dropped) so the pending message_delta at stream end carries the real
// numbers. Without a prior finish chunk no premature delta may be emitted.
test('usage-only chunk is collected on stream state, no premature message_delta', async () => {
  const { __openAICompatProxyTestUtils } = await importCompiled('coworkOpenAICompatProxy');
  const { createStreamState, processOpenAIChunk } = __openAICompatProxyTestUtils;

  const state = createStreamState({ preserveDeepSeekReasoning: true });
  const recorder = createWritableRecorder();

  processOpenAIChunk(recorder.res, state, {
    id: 'chatcmpl_usage_only',
    model: 'deepseek-v4-pro',
    choices: [],
    usage: {
      prompt_tokens: 9999,
      completion_tokens: 99,
      prompt_cache_hit_tokens: 8000,
      prompt_cache_miss_tokens: 1999,
    },
  });

  // The usage is preserved on the stream state for the stream-end emit path.
  assert.equal(state.collectedUsage.prompt_cache_hit_tokens, 8000);
  assert.equal(state.collectedUsage.prompt_cache_miss_tokens, 1999);
  // No finish reason has been seen yet, so no message_delta may be emitted.
  const events = parseSSEEvents(recorder.chunks.join(''));
  const deltas = events.filter((item) => item.event === 'message_delta');
  assert.equal(deltas.length, 0, 'no premature message_delta without a finish chunk');
});
