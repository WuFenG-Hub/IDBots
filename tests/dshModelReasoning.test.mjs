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

test('non-openai formats stay undeclared (responses is opt-in, anthropic is another dialect)', () => {
  assert.equal(dshModelReasoningDeclaration('deepseek-v4-flash', 'responses'), null);
  assert.equal(dshModelReasoningDeclaration('deepseek-v4-flash', 'anthropic'), null);
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
