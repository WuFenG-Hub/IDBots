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

test('resolveFallbackLlmId keeps a same-id fallback that names a different provider', () => {
  // 2026-09-20 dream 502s: AI_Sunny runs glm-5.3-flash @ zhipu primary with
  // glm-5.3-flash @ volcengine fallback — same model id, different gateway.
  // Id-only comparison discarded the backup, so a zhipu gateway flap failed
  // the run with no safety net even though the user configured a working one.
  assert.equal(resolveFallbackLlmId('glm-5.3-flash', 'glm-5.3-flash', 'zhipu', 'custom-provider'), 'glm-5.3-flash');
  // Primary provider unknown: the fallback hint still re-routes resolution.
  assert.equal(resolveFallbackLlmId('glm-5.3-flash', 'glm-5.3-flash', null, 'custom-provider'), 'glm-5.3-flash');
  // Same provider on both sides is the same brain — no fallback.
  assert.equal(resolveFallbackLlmId('glm-5.3-flash', 'glm-5.3-flash', 'zhipu', ' zhipu '), null);
  // Fallback provider unknown → legacy id-only rule (same id, no fallback).
  assert.equal(resolveFallbackLlmId('glm-5.3-flash', 'glm-5.3-flash', 'zhipu', null), null);
  assert.equal(resolveFallbackLlmId('glm-5.3-flash', 'glm-5.3-flash', null, null), null);
  // Different ids keep the fallback regardless of providers.
  assert.equal(resolveFallbackLlmId('glm-5.3', 'glm-5.3-flash', 'zhipu', 'zhipu'), 'glm-5.3-flash');
});

test('runWithLlmFallback retries the same model id on the fallback provider', async () => {
  const calls = [];
  const result = await runWithLlmFallback(
    {
      llmId: 'glm-5.3-flash',
      llmProvider: 'zhipu',
      fallbackLlmId: 'glm-5.3-flash',
      fallbackLlmProvider: 'custom-provider',
    },
    async (options) => {
      calls.push({ llmId: options.llmId, llmProvider: options.llmProvider ?? null });
      if (options.llmProvider === 'zhipu') {
        throw new Error('LLM request failed: 502 {"type":"error","error":{"type":"api_error","message":"net::ERR_CONNECTION_CLOSED"}}');
      }
      return 'ok';
    },
    noopLog,
  );
  assert.equal(result, 'ok');
  assert.deepEqual(calls, [
    { llmId: 'glm-5.3-flash', llmProvider: 'zhipu' },
    { llmId: 'glm-5.3-flash', llmProvider: 'custom-provider' },
  ]);
});

test('runWithLlmFallback names the fallback provider in the combined error', async () => {
  await assert.rejects(
    runWithLlmFallback(
      {
        llmId: 'glm-5.3-flash',
        llmProvider: 'zhipu',
        fallbackLlmId: 'glm-5.3-flash',
        fallbackLlmProvider: 'custom-provider',
      },
      async () => {
        throw new Error('down');
      },
      noopLog,
    ),
    (err) =>
      err instanceof Error &&
      err.message.includes("(fallback 'glm-5.3-flash@custom-provider' also failed: down)"),
  );
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

test('runWithLlmFallback throws a combined error naming both failures when the fallback also fails', async () => {
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
    // Since fa79c4b5 the wrapper surfaces a combined error naming both brains
    // instead of rethrowing the primary error object.
    (err) =>
      err instanceof Error &&
      err.message === "primary exploded (fallback 'fallback' also failed: fallback exploded)",
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
