/**
 * Runtime tests for the cowork proxy's GLM thinking→reasoning wire mapping.
 *
 * The chat→Responses conversion mapped the thinking toggle to
 * `reasoning.effort` for DeepSeek ONLY; every other responses-format provider
 * (zhipu open.bigmodel.cn, z.ai, relays serving glm-*) silently dropped the
 * toggle, so GLM-5.x kept thinking at its default effort and hidden reasoning
 * consumed the whole max_output_tokens budget — the 2026-09-20 dream-fragment
 * outage (stop_reason=max_tokens, blocks=none, output_tokens=4096 on every
 * glm-5.3-flash run). Requires `pnpm run compile:electron`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

let proxy;
try {
  proxy = await import('../dist-electron/main/libs/coworkOpenAICompatProxy.js');
} catch {
  proxy = await import('../dist-electron/main/libs/coworkOpenAICompatProxy.js');
}

const { convertChatCompletionsRequestToResponsesRequest } = proxy.__openAICompatProxyTestUtils;

const baseChatRequest = (model, thinking) => ({
  model,
  max_tokens: 16_384,
  messages: [{ role: 'user', content: '总结今天' }],
  ...(thinking !== undefined ? { thinking } : {}),
});

test('GLM-5.x thinking:disabled maps to reasoning effort low (cannot disable)', () => {
  const converted = convertChatCompletionsRequestToResponsesRequest(
    baseChatRequest('glm-5.3-flash', { type: 'disabled' }),
    'zhipu'
  );
  assert.deepEqual(converted.reasoning, { effort: 'low' });
});

test('GLM-4.x thinking:disabled maps to reasoning effort none (honored)', () => {
  const converted = convertChatCompletionsRequestToResponsesRequest(
    baseChatRequest('glm-4.7', { type: 'disabled' }),
    'custom-relay'
  );
  assert.deepEqual(converted.reasoning, { effort: 'none' });
});

test('GLM thinking:enabled with a small budget maps to effort low', () => {
  // The one-shot anthropic wire downgrades a "disabled" request for
  // always-thinking models to enabled+budget 4000 (zhipu 400 code 1210
  // rejects disabled outright); the proxy must carry that low intent onto the
  // Responses wire instead of dropping it back to the provider default.
  const converted = convertChatCompletionsRequestToResponsesRequest(
    baseChatRequest('glm-5.3-flash', { type: 'enabled', budget_tokens: 4000 }),
    'zhipu'
  );
  assert.deepEqual(converted.reasoning, { effort: 'low' });
  const highBudget = convertChatCompletionsRequestToResponsesRequest(
    baseChatRequest('glm-5.3-flash', { type: 'enabled', budget_tokens: 10_000 }),
    'zhipu'
  );
  assert.deepEqual(highBudget.reasoning, { effort: 'high' });
});

test('GLM without a thinking toggle keeps the provider default (no reasoning field)', () => {
  const converted = convertChatCompletionsRequestToResponsesRequest(
    baseChatRequest('glm-5.3-flash', undefined),
    'zhipu'
  );
  assert.equal('reasoning' in converted, false);
});

test('DeepSeek mapping is unchanged by the GLM branch', () => {
  const disabled = convertChatCompletionsRequestToResponsesRequest(
    baseChatRequest('deepseek-flash', { type: 'disabled' }),
    'deepseek'
  );
  assert.deepEqual(disabled.reasoning, { effort: 'none' });

  const enabled = convertChatCompletionsRequestToResponsesRequest(
    baseChatRequest('deepseek-v4-pro', { type: 'enabled' }),
    'deepseek'
  );
  assert.deepEqual(enabled.reasoning, { effort: 'high' });
});

test('unknown model families still omit the reasoning field entirely', () => {
  // No known dialect: guessing an effort value could 400 on an arbitrary
  // relay. The thinking-aware output budget at the caller carries headroom.
  const converted = convertChatCompletionsRequestToResponsesRequest(
    baseChatRequest('brand-new-model', { type: 'disabled' }),
    'custom-relay'
  );
  assert.equal('reasoning' in converted, false);
});
