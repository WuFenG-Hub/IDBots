import test from 'node:test';
import assert from 'node:assert/strict';

test('resolveCoworkModelLimits reads explicit provider model limits', async () => {
  const {
    resolveCoworkModelLimits,
  } = await import('../dist-electron/main/libs/coworkModelLimits.js');

  const limits = resolveCoworkModelLimits({
    model: {
      defaultModel: 'deepseek-v4-pro',
      availableModels: [],
    },
    providers: {
      deepseek: {
        enabled: true,
        models: [
          {
            id: 'deepseek-v4-pro',
            contextWindow: 1_000_000,
            maxOutputTokens: 16_000,
          },
        ],
      },
    },
  });

  assert.deepEqual(limits, {
    modelId: 'deepseek-v4-pro',
    contextWindow: 1_000_000,
    maxOutputTokens: 16_000,
    source: 'provider-model',
  });
});

test('resolveCoworkModelLimits falls back conservatively for unknown models', async () => {
  const {
    DEFAULT_COWORK_CONTEXT_WINDOW,
    DEFAULT_COWORK_MAX_OUTPUT_TOKENS,
    resolveCoworkModelLimits,
  } = await import('../dist-electron/main/libs/coworkModelLimits.js');

  const limits = resolveCoworkModelLimits({
    model: {
      defaultModel: 'custom-model',
      availableModels: [{ id: 'custom-model' }],
    },
    providers: {},
  });

  assert.deepEqual(limits, {
    modelId: 'custom-model',
    contextWindow: DEFAULT_COWORK_CONTEXT_WINDOW,
    maxOutputTokens: DEFAULT_COWORK_MAX_OUTPUT_TOKENS,
    source: 'fallback',
  });
  assert.equal(DEFAULT_COWORK_CONTEXT_WINDOW, 128_000);
  assert.equal(DEFAULT_COWORK_MAX_OUTPUT_TOKENS, 8_192);
});

test('resolveCoworkModelLimits can use built-in DeepSeek V4 Pro defaults by model id', async () => {
  const {
    resolveCoworkModelLimits,
  } = await import('../dist-electron/main/libs/coworkModelLimits.js');

  const limits = resolveCoworkModelLimits({
    model: {
      defaultModel: 'deepseek-v4-pro',
      availableModels: [],
    },
    providers: {},
  });

  assert.deepEqual(limits, {
    modelId: 'deepseek-v4-pro',
    contextWindow: 1_000_000,
    maxOutputTokens: 16_000,
    source: 'known-model',
  });
});

// ---------------------------------------------------------------------------
// Regression: context usage ring must reflect each model's real context window,
// not the flat 128K fallback. Every model id that ships as a preset must resolve
// to a real context window via KNOWN_MODEL_LIMITS even when the enabled provider
// or available-model metadata is absent (which is what cowork/A2A automation
// sessions hit, since they are driven by deepseek-v4-flash).
// ---------------------------------------------------------------------------

/**
 * The complete set of model ids that ship as presets in src/renderer/config.ts
 * (defaultConfig.providers + DeepSeek defaults) and src/renderer/services/config.ts
 * (provider model migration v1).
 */
const PRESET_MODEL_IDS = [
  // DeepSeek (default engine) — deepseek-v4-flash drives cowork/A2A automation
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  // OpenAI
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  // Gemini
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  // Anthropic
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  // Moonshot
  'kimi-k2.6',
  'kimi-k2.5',
  // Zhipu
  'glm-5.1',
  'glm-5',
  'glm-4.7',
  'glm-4.7-flash',
  // MiniMax
  'MiniMax-M3',
  'MiniMax-M2.7',
  'MiniMax-M2.5',
  // Qwen
  'qwen3.6-plus',
  'qwen3.5-plus',
  'qwen3-coder-next',
  // Xiaomi MiMo
  'mimo-v2.5-pro',
  'mimo-v2.5',
  // OpenRouter aliases
  'anthropic/claude-sonnet-4.6',
  'anthropic/claude-opus-4.7',
  'openai/gpt-5.5',
  'google/gemini-3.1-pro-preview',
];

/** Expected context window per model family (mirrors KNOWN_MODEL_LIMITS). */
const EXPECTED_CONTEXT_WINDOWS = {
  'deepseek-v4-pro': 1_000_000,
  'deepseek-v4-flash': 1_000_000,
  'gpt-5.6-sol': 1_050_000,
  'gpt-5.6-terra': 1_050_000,
  'gpt-5.6-luna': 1_050_000,
  'gpt-5.5': 1_050_000,
  'gpt-5.4': 1_050_000,
  'gemini-3.1-pro-preview': 2_000_000,
  'gemini-3-flash-preview': 2_000_000,
  'gemini-3.1-flash-lite': 2_000_000,
  'claude-opus-4-7': 1_048_576,
  'claude-opus-4-6': 1_048_576,
  'claude-sonnet-4-6': 1_048_576,
  'kimi-k2.6': 262_144,
  'kimi-k2.5': 262_144,
  'glm-5.1': 202_800,
  'glm-5': 202_800,
  'glm-4.7': 204_800,
  'glm-4.7-flash': 204_800,
  'MiniMax-M3': 1_000_000,
  'MiniMax-M2.7': 204_800,
  'MiniMax-M2.5': 204_800,
  'qwen3.6-plus': 1_000_000,
  'qwen3.5-plus': 1_000_000,
  'qwen3-coder-next': 1_000_000,
  'mimo-v2.5-pro': 1_000_000,
  'mimo-v2.5': 1_000_000,
  'anthropic/claude-sonnet-4.6': 1_048_576,
  'anthropic/claude-opus-4.7': 1_048_576,
  'openai/gpt-5.5': 1_050_000,
  'google/gemini-3.1-pro-preview': 2_000_000,
};

// No provider metadata and no available-model metadata, so resolution must rely
// entirely on KNOWN_MODEL_LIMITS — the same path automation sessions hit.
const APP_CONFIG_WITHOUT_PROVIDER_META = {
  model: { defaultModel: '', availableModels: [] },
  providers: {},
};

test('no preset model resolves to the 128K fallback — context window is dynamic per model', async () => {
  const { resolveCoworkModelLimits, DEFAULT_COWORK_CONTEXT_WINDOW } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  const regressions = [];
  for (const modelId of PRESET_MODEL_IDS) {
    const limits = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, modelId);
    if (limits.source === 'fallback' || limits.contextWindow === DEFAULT_COWORK_CONTEXT_WINDOW) {
      regressions.push({ modelId, source: limits.source, contextWindow: limits.contextWindow });
    }
  }
  assert.deepEqual(
    regressions,
    [],
    `These preset models fell back to the hardcoded 128K context window (add them to KNOWN_MODEL_LIMITS in src/main/libs/coworkModelLimits.ts): ${JSON.stringify(regressions, null, 2)}`,
  );
});

test('each preset model resolves to its expected real context window', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  for (const modelId of PRESET_MODEL_IDS) {
    const limits = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, modelId);
    const expected = EXPECTED_CONTEXT_WINDOWS[modelId];
    assert.equal(
      limits.contextWindow,
      expected,
      `${modelId}: expected context window ${expected}, got ${limits.contextWindow} (source=${limits.source})`,
    );
  }
});

test('deepseek-v4-flash — the automation model behind cowork/A2A — resolves to 1M, not 128K', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  const limits = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, 'deepseek-v4-flash');
  assert.equal(limits.contextWindow, 1_000_000);
  assert.notEqual(limits.source, 'fallback');
});
