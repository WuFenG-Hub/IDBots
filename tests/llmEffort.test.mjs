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

test('convertLegacyEffortLevel maps leftover five-step tokens only', () => {
  assert.equal(convertLegacyEffortLevel(null), null);
  assert.equal(convertLegacyEffortLevel(undefined), null);
  assert.equal(convertLegacyEffortLevel(''), null);
  // Canonical rungs pass through, including `low` (light thinking).
  assert.equal(convertLegacyEffortLevel('off'), 'off');
  assert.equal(convertLegacyEffortLevel('low'), 'low');
  assert.equal(convertLegacyEffortLevel('high'), 'high');
  assert.equal(convertLegacyEffortLevel('max'), 'max');
  // Legacy-only tokens.
  assert.equal(convertLegacyEffortLevel('minimal'), 'off');
  assert.equal(convertLegacyEffortLevel('none'), 'off');
  assert.equal(convertLegacyEffortLevel('disabled'), 'off');
  assert.equal(convertLegacyEffortLevel('medium'), 'low');
  assert.equal(convertLegacyEffortLevel('xhigh'), 'max');
  assert.equal(convertLegacyEffortLevel('MAX'), 'max');
  assert.equal(convertLegacyEffortLevel('turbo'), null);
});

test('the explicit-Default sentinel stays truthy and resolves to the model default', () => {
  const sentinel = llmEffort.LLM_EFFORT_DEFAULT_SENTINEL;
  assert.equal(sentinel, 'default');
  // Truthiness is the contract: the per-turn chain is
  // `effortOverride ?? brainEffort ?? globalEffort ?? modelDefault`, so the
  // sentinel must stop that chain before the brain/global rungs…
  assert.ok(Boolean(sentinel), 'sentinel must be truthy to short-circuit the ?? chain');
  assert.equal(isLlmEffortLevel(sentinel), false);
  // …while converting to null = the model's own default.
  assert.equal(convertLegacyEffortLevel(sentinel), null);
  assert.equal(toLlmEffortLevel(sentinel), null);
  // Runtime chain shape: a sentinel override beats brain/global values, a
  // null override still falls through to them.
  assert.equal(toLlmEffortLevel(sentinel ?? 'max' ?? 'high'), null);
  assert.equal(toLlmEffortLevel(null ?? 'max' ?? 'high'), 'max');
});

test('toLlmEffortLevel passes canonical values through and converts leftover tokens', () => {
  assert.equal(toLlmEffortLevel('off'), 'off');
  assert.equal(toLlmEffortLevel('low'), 'low');
  assert.equal(toLlmEffortLevel('high'), 'high');
  assert.equal(toLlmEffortLevel('max'), 'max');
  assert.equal(toLlmEffortLevel('medium'), 'low');
  assert.equal(toLlmEffortLevel('minimal'), 'off');
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
