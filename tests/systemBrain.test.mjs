import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);

function loadFallback() {
  try {
    return require(require.resolve('../dist-electron/main/services/llmFallback.js'));
  } catch {
    return require('../dist-electron/services/llmFallback.js');
  }
}

const { resolveSystemBrainOptions } = loadFallback();

test('system brain resolves the Twin Bot brain pair (primary + fallback + efforts)', () => {
  const brain = resolveSystemBrainOptions([
    { metabot_type: 'worker', llm_id: 'worker-model', llm_provider: 'deepseek' },
    {
      metabot_type: 'twin',
      llm_id: 'glm-5.3-flash',
      llm_provider: 'custom-zai',
      llm_effort: 'low',
      fallback_llm_id: 'deepseek-v4-flash',
      fallback_llm_provider: 'deepseek',
      fallback_llm_effort: 'high',
    },
  ]);
  assert.equal(brain.llmId, 'glm-5.3-flash');
  assert.equal(brain.llmProvider, 'custom-zai');
  assert.equal(brain.effort, 'low');
  assert.equal(brain.fallbackLlmId, 'deepseek-v4-flash');
  assert.equal(brain.fallbackLlmProvider, 'deepseek');
  assert.equal(brain.fallbackEffort, 'high');
});

test('system brain is all-null when no twin exists or the list is empty', () => {
  const noTwin = resolveSystemBrainOptions([
    { metabot_type: 'worker', llm_id: 'worker-model' },
  ]);
  assert.equal(noTwin.llmId, null);
  assert.equal(noTwin.fallbackLlmId, null);
  const empty = resolveSystemBrainOptions([]);
  assert.equal(empty.llmId, null);
  const missing = resolveSystemBrainOptions(null);
  assert.equal(missing.llmId, null);
});

test('system brain with an unconfigured twin yields null llmId (app default keeps serving)', () => {
  const brain = resolveSystemBrainOptions([{ metabot_type: 'twin', llm_id: null }]);
  assert.equal(brain.llmId, null);
});
