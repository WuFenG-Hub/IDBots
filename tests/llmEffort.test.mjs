// App-wide effort vocabulary (llmEffort.ts): four-step ladder, legacy
// five-step conversion, and per-wire mappings.

import test from 'node:test';
import assert from 'node:assert/strict';

let llmEffort;
try {
  llmEffort = await import('../dist-electron/main/libs/llmEffort.js');
} catch {
  llmEffort = await import('../dist-electron/libs/llmEffort.js');
}

const {
  isLlmEffortLevel,
  convertLegacyEffortLevel,
  toLlmEffortLevel,
  effortForClaudeSdk,
  effortForAnthropicWire,
  effortForOpenAiWire,
} = llmEffort;

test('isLlmEffortLevel accepts exactly the four canonical levels', () => {
  for (const level of ['off', 'low', 'high', 'max']) {
    assert.equal(isLlmEffortLevel(level), true, level);
  }
  assert.equal(isLlmEffortLevel('medium'), false);
  assert.equal(isLlmEffortLevel(''), false);
  assert.equal(isLlmEffortLevel(null), false);
  assert.equal(isLlmEffortLevel(undefined), false);
});

test('convertLegacyEffortLevel maps the old five-step ladder', () => {
  assert.equal(convertLegacyEffortLevel(null), null);
  assert.equal(convertLegacyEffortLevel(undefined), null);
  assert.equal(convertLegacyEffortLevel(''), null);
  // 快速(low) historically meant thinking-off.
  assert.equal(convertLegacyEffortLevel('low'), 'off');
  assert.equal(convertLegacyEffortLevel('minimal'), 'off');
  assert.equal(convertLegacyEffortLevel('medium'), 'low');
  assert.equal(convertLegacyEffortLevel('high'), 'high');
  assert.equal(convertLegacyEffortLevel('max'), 'max');
  assert.equal(convertLegacyEffortLevel('xhigh'), 'max');
  assert.equal(convertLegacyEffortLevel('MAX'), 'max');
  assert.equal(convertLegacyEffortLevel('turbo'), null);
});

test('toLlmEffortLevel passes canonical values through and converts legacy ones', () => {
  assert.equal(toLlmEffortLevel('off'), 'off');
  assert.equal(toLlmEffortLevel('high'), 'high');
  assert.equal(toLlmEffortLevel('max'), 'max');
  assert.equal(toLlmEffortLevel('low'), 'off', 'legacy low converts to off');
  assert.equal(toLlmEffortLevel('medium'), 'low');
  assert.equal(toLlmEffortLevel(null), null);
});

test('effortForClaudeSdk maps onto SDK effort/thinking options', () => {
  assert.deepEqual(effortForClaudeSdk('off'), { thinking: { type: 'disabled' } });
  assert.deepEqual(effortForClaudeSdk('low'), { effort: 'low' });
  assert.deepEqual(effortForClaudeSdk('high'), { effort: 'high' });
  assert.deepEqual(effortForClaudeSdk('max'), { effort: 'max', thinking: { type: 'enabled' } });
  assert.deepEqual(effortForClaudeSdk(null), {});
});

test('effortForAnthropicWire maps onto thinking budget tiers', () => {
  assert.deepEqual(effortForAnthropicWire('off'), { thinking: { type: 'disabled' } });
  assert.deepEqual(effortForAnthropicWire('low'), { thinking: { type: 'enabled', budget_tokens: 4000 } });
  assert.deepEqual(effortForAnthropicWire('high'), { thinking: { type: 'enabled', budget_tokens: 10000 } });
  assert.deepEqual(effortForAnthropicWire('max'), { thinking: { type: 'enabled', budget_tokens: 32000 } });
  assert.deepEqual(effortForAnthropicWire(null), {});
});

test('effortForOpenAiWire maps onto reasoning_effort, capping max at high', () => {
  assert.equal(effortForOpenAiWire('off'), undefined);
  assert.equal(effortForOpenAiWire('low'), 'low');
  assert.equal(effortForOpenAiWire('high'), 'high');
  assert.equal(effortForOpenAiWire('max'), 'high');
  assert.equal(effortForOpenAiWire(null), undefined);
});
