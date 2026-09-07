// dshModelReasoningDeclaration: reasoning capability declarations ride the
// MODEL family, not the provider. A catalog-unknown gateway serving
// deepseek-v4 must get the official chat-completions declaration so the
// effort selector's "off" actually disables thinking upstream (see the
// module header for the reasoning:false failure mode this prevents).

import assert from 'node:assert/strict'
import test from 'node:test'
import { dshModelReasoningDeclaration } from '../dist-electron/main/libs/dshModelReasoning.js'

test('deepseek-v4 family declares the official chat-completions dialect, vendor prefix or not', () => {
  for (const id of [
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'deepseek-v4-flash-vision-exp',
    'deepseek/deepseek-v4-flash',
  ]) {
    const declaration = dshModelReasoningDeclaration(id, 'openai');
    assert.ok(declaration, id);
    assert.equal(declaration.compat.thinkingFormat, 'deepseek');
    assert.equal(declaration.compat.supportsReasoningEffort, true);
    // `off: null` keeps off absent from the materialized thinkingLevelMap —
    // the deepseek branch then sends the explicit thinking-disable.
    assert.equal(declaration.reasoningEfforts.off, null);
    assert.equal(declaration.reasoningEfforts.low, 'low');
    assert.equal(declaration.reasoningEfforts.high, 'high');
    assert.equal(declaration.reasoningEfforts.max, 'max');
    // Undeclared levels materialize unsupported, mirroring the official profile.
    assert.equal('medium' in declaration.reasoningEfforts, false);
    assert.equal('minimal' in declaration.reasoningEfforts, false);
  }
})

test('deepseek stays chat-completions-only; anthropic stays undeclared for every family', () => {
  assert.equal(dshModelReasoningDeclaration('deepseek-v4-flash', 'responses'), null);
  assert.equal(dshModelReasoningDeclaration('deepseek-v4-flash', 'anthropic'), null);
  assert.equal(dshModelReasoningDeclaration('glm-5.3-flash', 'anthropic'), null);
})

test('other families stay undeclared — no capability guessing', () => {
  assert.equal(dshModelReasoningDeclaration('gpt-5.6-sol', 'openai'), null);
  assert.equal(dshModelReasoningDeclaration('deepseek-v3.2', 'openai'), null);
  assert.equal(dshModelReasoningDeclaration('moonshotai/Kimi-K3', 'openai'), null);
  assert.equal(dshModelReasoningDeclaration('', 'openai'), null);
})

test('GLM models use the Z.AI thinking wire without reasoning_effort', () => {
  const declaration = dshModelReasoningDeclaration('z-ai/glm-5.3-flash', 'openai');
  assert.ok(declaration);
  assert.equal(declaration.compat.thinkingFormat, 'zai');
  assert.equal(declaration.compat.supportsReasoningEffort, false);
  assert.deepEqual(declaration.reasoningEfforts, {
    off: null,
    low: 'enabled',
    high: 'enabled',
    max: 'enabled',
  });
});

test('GLM on the Responses wire opts into reasoning explicitly (2026-09-03 z.ai default flip)', () => {
  for (const id of ['glm-5.3-flash', 'z-ai/glm-5.3-flash', 'glm-4.6-air']) {
    const declaration = dshModelReasoningDeclaration(id, 'responses');
    assert.ok(declaration, id);
    // Enabled rungs ride reasoning.effort; off keeps the send-nothing shape
    // (Responses has no disable parameter — off falls back to the provider
    // default instead of pretending to disable).
    assert.equal(declaration.reasoningEfforts.off, null);
    assert.equal(declaration.reasoningEfforts.low, 'low');
    assert.equal(declaration.reasoningEfforts.high, 'high');
    assert.equal(declaration.reasoningEfforts.max, 'high');
    assert.equal('minimal' in declaration.reasoningEfforts, false);
    // Only RESPONSES_COMPAT_GATE fields — supportsStore and the chat-completions
    // dialect knobs are completions-only and fail dsh-llm-pi-ai plugin load on
    // this wire (the 2026-09-07 boot regression).
    assert.deepEqual(declaration.compat, { supportsDeveloperRole: false });
    assert.equal('supportsStore' in declaration.compat, false);
    assert.equal('thinkingFormat' in declaration.compat, false);
  }
});

test('undeclared-reasoning route warning fires once per route identity', async () => {
  const { undeclaredReasoningRouteWarning } = await import('../dist-electron/main/libs/dshModelReasoning.js')
  const input = {
    provider: 'warn-probe-gw',
    model: 'some-k5-ultra',
    apiFormat: 'responses',
    effort: 'max',
  }
  const first = undeclaredReasoningRouteWarning(input)
  assert.ok(first, 'first sighting reports the warning')
  assert.match(first, /Reasoning effort "max" is configured but cannot ride model "some-k5-ultra"/)
  assert.match(first, /no thinking declaration/)
  assert.match(first, /provider server default decides/)
  assert.equal(undeclaredReasoningRouteWarning(input), null, 'same identity is silent afterwards')
  const changedEffort = undeclaredReasoningRouteWarning({ ...input, effort: 'off' })
  assert.ok(changedEffort, 'a different effort is a new identity')
  assert.match(changedEffort, /"off"/)
})
