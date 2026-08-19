import assert from 'node:assert/strict';
import test from 'node:test';

const llmFallbackModule = await import('../dist-electron/main/services/llmFallback.js');
const {
  normalizeMetabotLlmId,
  resolveFallbackLlmId,
  runWithLlmFallback,
} = llmFallbackModule;
const loadModule = () => llmFallbackModule;

const { buildMetabotInfoPayloads } = await import('../dist-electron/main/services/metabotInfoPayload.js');

const noopLog = () => {};

test('normalizeMetabotLlmId trims and nulls unusable values', () => {
  assert.equal(normalizeMetabotLlmId(' openai '), 'openai');
  assert.equal(normalizeMetabotLlmId(''), null);
  assert.equal(normalizeMetabotLlmId('   '), null);
  assert.equal(normalizeMetabotLlmId(null), null);
  assert.equal(normalizeMetabotLlmId(undefined), null);
  assert.equal(normalizeMetabotLlmId(42), null);
});

test('resolveFallbackLlmId returns fallback only when set and different from primary', () => {
  assert.equal(resolveFallbackLlmId('openai', ' ollama '), 'ollama');
  assert.equal(resolveFallbackLlmId('openai', 'openai'), null);
  assert.equal(resolveFallbackLlmId(' openai ', 'openai'), null);
  assert.equal(resolveFallbackLlmId('openai', ''), null);
  assert.equal(resolveFallbackLlmId('openai', null), null);
  assert.equal(resolveFallbackLlmId(null, 'ollama'), 'ollama');
});

test('/info/llm payload maps fallback_llm_id to fallbackProvider', () => {
  const step = buildMetabotInfoPayloads({ llm_id: 'openai', fallback_llm_id: 'ollama' })[2];
  assert.deepEqual(JSON.parse(step.payload), { primaryProvider: 'openai', primaryModel: 'openai', fallbackProvider: 'ollama', fallbackModel: 'ollama' });

  const empty = buildMetabotInfoPayloads({ llm_id: 'openai', fallback_llm_id: '  ' })[2];
  assert.deepEqual(JSON.parse(empty.payload), { primaryProvider: 'openai', primaryModel: 'openai', fallbackProvider: null, fallbackModel: null });

  const missing = buildMetabotInfoPayloads({ llm_id: 'openai' })[2];
  assert.deepEqual(JSON.parse(missing.payload), { primaryProvider: 'openai', primaryModel: 'openai', fallbackProvider: null, fallbackModel: null });
});

test('runWithLlmFallback retries with fallback when primary config resolution fails', async () => {
  const calls = [];
  const result = await runWithLlmFallback(
    { llmId: 'broken-primary', fallbackLlmId: 'fallback-llm' },
    async (options) => {
      calls.push({ llmId: options.llmId, fallbackLlmId: options.fallbackLlmId });
      if (options.llmId === 'broken-primary') {
        throw new Error('LLM config not available');
      }
      return { content: 'fallback reply' };
    },
    noopLog,
  );

  assert.deepEqual(result, { content: 'fallback reply' });
  assert.deepEqual(calls, [
    { llmId: 'broken-primary', fallbackLlmId: 'fallback-llm' },
    { llmId: 'fallback-llm', fallbackLlmId: null },
  ]);
});

test('runWithLlmFallback retries with fallback when the primary API call throws', async () => {
  const calls = [];
  const result = await runWithLlmFallback(
    { llmId: 'primary', fallbackLlmId: ' fallback ' },
    async (options) => {
      calls.push(options.llmId);
      if (options.llmId === 'primary') {
        throw new Error('LLM request failed: 500 Internal Server Error');
      }
      return 'ok';
    },
    noopLog,
  );

  assert.equal(result, 'ok');
  assert.deepEqual(calls, ['primary', 'fallback']);
});

test('runWithLlmFallback rethrows the primary error when the fallback also fails', async () => {
  const calls = [];
  const primaryError = new Error('primary exploded');
  await assert.rejects(
    runWithLlmFallback(
      { llmId: 'primary', fallbackLlmId: 'fallback' },
      async (options) => {
        calls.push(options.llmId);
        throw options.llmId === 'primary' ? primaryError : new Error('fallback exploded');
      },
      noopLog,
    ),
    (err) => err === primaryError,
  );
  assert.deepEqual(calls, ['primary', 'fallback']);
});

test('runWithLlmFallback does not retry when fallback equals the primary id', async () => {
  const calls = [];
  await assert.rejects(
    runWithLlmFallback(
      { llmId: ' openai ', fallbackLlmId: 'openai' },
      async (options) => {
        calls.push(options.llmId);
        throw new Error('boom');
      },
      noopLog,
    ),
    /boom/,
  );
  assert.deepEqual(calls, [' openai ']);
});

test('runWithLlmFallback does not retry when no fallback is configured', async () => {
  const calls = [];
  await assert.rejects(
    runWithLlmFallback(
      { llmId: 'primary' },
      async (options) => {
        calls.push(options.llmId);
        throw new Error('boom');
      },
      noopLog,
    ),
    /boom/,
  );
  assert.deepEqual(calls, ['primary']);
});

test('runWithLlmFallback returns the primary result without touching the fallback', async () => {
  const calls = [];
  const result = await runWithLlmFallback(
    { llmId: 'primary', fallbackLlmId: 'fallback' },
    async (options) => {
      calls.push(options.llmId);
      return 'primary ok';
    },
    noopLog,
  );
  assert.equal(result, 'primary ok');
  assert.deepEqual(calls, ['primary']);
});

test('metabotBrainOptions extracts the model+effort brain pair', () => {
  const { metabotBrainOptions } = loadModule();
  const brain = metabotBrainOptions({
    llm_id: 'deepseek-v4-pro',
    llm_provider: 'deepseek',
    llm_effort: 'high',
    fallback_llm_id: 'qwen3.5-plus',
    fallback_llm_provider: 'qwen',
    fallback_llm_effort: 'medium', // legacy five-step value
  });
  assert.deepEqual(brain, {
    llmId: 'deepseek-v4-pro',
    llmProvider: 'deepseek',
    effort: 'high',
    fallbackLlmId: 'qwen3.5-plus',
    fallbackLlmProvider: 'qwen',
    fallbackEffort: 'low',
  });

  // Legacy provider-key brains and empty fields normalize cleanly.
  assert.deepEqual(metabotBrainOptions({ llm_id: ' deepseek ' }), {
    llmId: 'deepseek',
    llmProvider: null,
    effort: null,
    fallbackLlmId: null,
    fallbackLlmProvider: null,
    fallbackEffort: null,
  });
  assert.deepEqual(metabotBrainOptions(null).llmId, null);
});

test('runWithLlmFallback swaps model, provider hint, and effort to the fallback brain', async () => {
  const { runWithLlmFallback } = loadModule();
  const calls = [];
  await runWithLlmFallback(
    {
      llmId: 'broken-primary',
      llmProvider: 'gone-provider',
      fallbackLlmId: 'fallback-model',
      fallbackLlmProvider: 'fallback-provider',
      effort: 'max',
      fallbackEffort: 'low',
    },
    async (options) => {
      calls.push({
        llmId: options.llmId,
        llmProvider: options.llmProvider ?? null,
        fallbackLlmId: options.fallbackLlmId ?? null,
        effort: options.effort ?? null,
      });
      if (options.llmId === 'broken-primary') {
        throw new Error('LLM config not available');
      }
      return { content: 'ok' };
    },
    noopLog,
  );
  assert.deepEqual(calls, [
    { llmId: 'broken-primary', llmProvider: 'gone-provider', fallbackLlmId: 'fallback-model', effort: 'max' },
    { llmId: 'fallback-model', llmProvider: 'fallback-provider', fallbackLlmId: null, effort: 'low' },
  ]);
});
