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
    // Provider metadata did not declare supportsVision, so the known-model
    // capability (DeepSeek V4 family has no vision) applies.
    supportsVision: false,
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
    // Fail-safe default: models we have not catalogued are treated as
    // text-only. The Read-image guard then denies with an explicit pointer
    // to describe_image instead of silently dropping pixels on a model that
    // cannot read them (2026-09-04 glm-5.3-flash regression).
    supportsVision: false,
    source: 'fallback',
  });
  assert.equal(DEFAULT_COWORK_CONTEXT_WINDOW, 128_000);
  assert.equal(DEFAULT_COWORK_MAX_OUTPUT_TOKENS, 32_768);
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
    maxOutputTokens: 32_768,
    supportsVision: false,
    source: 'known-model',
  });
});

test('deepseek-v4-flash declares a 32K output ceiling instead of a smaller fallback', async () => {
  const { resolveCoworkModelLimits } = await import('../dist-electron/main/libs/coworkModelLimits.js');

  const limits = resolveCoworkModelLimits({
    model: { defaultModel: 'deepseek-v4-flash', availableModels: [] },
    providers: {},
  });

  assert.equal(limits.source, 'known-model');
  assert.equal(limits.contextWindow, 1_000_000);
  assert.equal(limits.maxOutputTokens, 32_768);
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
  // DeepSeek (default engine) — deepseek-flash drives cowork/A2A automation
  'deepseek-flash',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp',
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
  // Zhipu GLM-5.3 family presets + legacy presets still resolvable in
  // stored configs (migration v2 retires but keeps them catalogued).
  'glm-5.3-flash',
  'glm-5.3',
  'glm-5.2',
  'glm-5.2-fast',
  'glm-5.1',
  'glm-5',
  'glm-4.7',
  'glm-4.7-flash',
  'z-ai/glm-5.3-flash',
  'zai-org/GLM-5.3',
  'zai-org/GLM-5.2',
  'zai-org/GLM-5.2-Fast',
  'zai-org/GLM-5.1',
  'zai-org/GLM-5',
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
  'deepseek-flash': 1_000_000,
  'deepseek-v4-pro': 1_000_000,
  'deepseek-v4-flash': 1_000_000,
  'deepseek-v4-flash-vision-exp': 1_000_000,
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
  // GLM-5.3 family (Zhipu direct): 1048576 per the live catalog
  // GET /api/v1/models, 2026-09-18. Gateway ids keep the /v1-era 1M roundings.
  'glm-5.3-flash': 1_048_576,
  'glm-5.3-flashx': 1_048_576,
  'glm-5.3': 1_048_576,
  'glm-5.2': 1_000_000,
  'glm-5.2-fast': 1_000_000,
  'glm-5.1': 202_800,
  'glm-5': 202_800,
  'glm-4.7': 204_800,
  'glm-4.7-flash': 204_800,
  'z-ai/glm-5.3-flash': 1_048_576,
  'zai-org/GLM-5.3': 1_000_000,
  'zai-org/GLM-5.2': 1_000_000,
  'zai-org/GLM-5.2-Fast': 1_000_000,
  'zai-org/GLM-5.1': 202_800,
  'zai-org/GLM-5': 202_800,
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

// ---------------------------------------------------------------------------
// GT#12 N1: supportsVision capability — DeepSeek V4 Flash / Pro and the GLM
// text-only ids have no vision; catalogued vision presets do. Unknown models
// default to FALSE (fail-safe): the Read-image guard then denies loudly and
// points at describe_image instead of silently dropping image pixels on a
// model that cannot read them (2026-09-04 glm-5.3-flash regression).
// glm-5.3-flash (Zhipu direct) flipped to vision-capable on 2026-09-19: the
// GLM-5.3 launch made Flash natively multimodal — image input verified live
// through BOTH the Responses (/api/v1/responses) and Anthropic
// (/api/anthropic/v1/messages) endpoints. Gateway ids (z-ai/…) stay
// fail-safe false until their image passthrough is verified.
// ---------------------------------------------------------------------------

const NON_VISION_MODELS = [
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  // GLM text-only ids — the flagship glm-5.3, the 2026-09-04 incident's
  // gateway spelling, and the legacy text families.
  'glm-5.3',
  'glm-5.2',
  'glm-5.2-fast',
  'glm-5.1',
  'glm-5',
  'glm-4.7',
  'glm-4.7-flash',
  'z-ai/glm-5.3-flash',
  'zai-org/GLM-5.3',
  'zai-org/GLM-5.2',
  'zai-org/GLM-5.2-Fast',
  'zai-org/GLM-5.1',
  'zai-org/GLM-5',
];

test('non-vision models resolve supportsVision=false via known-model limits', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  for (const modelId of NON_VISION_MODELS) {
    const limits = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, modelId);
    assert.equal(limits.supportsVision, false, `${modelId} must be marked non-vision`);
    assert.equal(limits.source, 'known-model', `${modelId} must resolve via KNOWN_MODEL_LIMITS`);
  }
});

test('glm-5.3-flash — multimodal since the GLM-5.3 launch — resolves vision=true even with a flagless catalog entry', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  // The incident shape: a bot brain pointing at glm-5.3-flash while the
  // provider catalog entry (relay-provisioned or a stale preset) carries no
  // capability flags — resolution must fall through to KNOWN_MODEL_LIMITS,
  // never to the fallback default. Since 2026-09-19 that catalog entry is
  // vision=true (live-verified on both protocol endpoints), so read_image
  // serves pixels instead of denying.
  const limits = resolveCoworkModelLimits({
    model: { defaultModel: 'glm-5.3-flash', availableModels: [] },
    providers: {
      'metaid-free': {
        enabled: true,
        models: [{ id: 'glm-5.3-flash', contextWindow: 1_048_576 }],
      },
    },
  });
  assert.equal(limits.supportsVision, true);
  assert.notEqual(limits.source, 'fallback');

  // The 2026-09-04 incident spelling — the commandcode gateway id — keeps the
  // fail-safe non-vision answer until gateway image passthrough is verified.
  const gateway = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, 'z-ai/glm-5.3-flash');
  assert.equal(gateway.supportsVision, false);
  assert.equal(gateway.source, 'known-model');

  // glm-5.3-flashx shares the multimodal flash spec (not in coding plans, but
  // catalogued for pay-as-you-go users).
  const flashx = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, 'glm-5.3-flashx');
  assert.equal(flashx.supportsVision, true);
  assert.equal(flashx.contextWindow, 1_048_576);
  assert.equal(flashx.source, 'known-model');
});

// 2026-09-14 silent-stall: glm-5.3-flash (commandcode catalog entries carry
// contextWindow but no maxOutputTokens) inherited the old DEFAULT 8192.
// Thinking at effort-max burned that ceiling. Catalog + family fallback now
// pin 32K, which matches the raised default so unknown models get the same.
test('glm-5.3-flash thinking models get the 32K output ceiling', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  for (const modelId of ['glm-5.3-flash', 'glm-5.3-flashx', 'z-ai/glm-5.3-flash', 'glm-5.3', 'zai-org/GLM-5.3']) {
    const limits = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, modelId);
    assert.equal(limits.maxOutputTokens, 32_768, `${modelId} must resolve to the 32K output ceiling`);
  }

  // Commandcode-shaped catalog: contextWindow only, no maxOutputTokens.
  const gatewayLimits = resolveCoworkModelLimits({
    model: { defaultModel: 'z-ai/glm-5.3-flash', availableModels: [] },
    providers: {
      commandcode: {
        enabled: true,
        models: [{ id: 'z-ai/glm-5.3-flash', contextWindow: 1_048_576 }],
      },
    },
  });
  assert.equal(gatewayLimits.maxOutputTokens, 32_768);
  assert.equal(gatewayLimits.contextWindow, 1_048_576);
});

test('uncatalogued glm-5.x gateway ids inherit the 32K output ceiling via family fallback', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  const limits = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, 'acme/glm-5.4-flash');
  assert.equal(limits.maxOutputTokens, 32_768);
  assert.equal(limits.source, 'family-model');
});

test('every catalogued vision-capable preset resolves supportsVision=true', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  const nonVision = new Set(NON_VISION_MODELS);
  const regressions = [];
  for (const modelId of PRESET_MODEL_IDS) {
    if (nonVision.has(modelId)) {
      continue;
    }
    const limits = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, modelId);
    if (limits.supportsVision !== true) {
      regressions.push({ modelId, supportsVision: limits.supportsVision });
    }
  }
  assert.deepEqual(
    regressions,
    [],
    `Vision-capable presets must resolve supportsVision=true: ${JSON.stringify(regressions)}`,
  );
});

test('unknown models default to supportsVision=false (fail-safe, explicit denial over silent pixel loss)', async () => {
  const { resolveCoworkModelLimits, modelSupportsVision } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  const limits = resolveCoworkModelLimits({
    model: { defaultModel: 'totally-unknown-model', availableModels: [] },
    providers: {},
  });
  assert.equal(limits.supportsVision, false);
  assert.equal(limits.source, 'fallback');

  // Direct query API used by the proxy scheme-B fallback.
  assert.equal(modelSupportsVision('totally-unknown-model'), false);
  assert.equal(modelSupportsVision(''), false);
  assert.equal(modelSupportsVision(null), false);
  assert.equal(modelSupportsVision(undefined), false);
  // Catalogued vision models still answer true.
  assert.equal(modelSupportsVision('kimi-k2.6'), true);
});

test('provider metadata can explicitly override supportsVision', async () => {
  const { resolveCoworkModelLimits, modelSupportsVision } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  // A gateway serving deepseek-v4-pro through a vision-capable front model:
  // explicit provider metadata wins over the known-model table.
  const limits = resolveCoworkModelLimits({
    model: { defaultModel: 'deepseek-v4-pro', availableModels: [] },
    providers: {
      custom: {
        enabled: true,
        models: [
          { id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxOutputTokens: 32_768, supportsVision: true },
        ],
      },
    },
  });
  assert.equal(limits.supportsVision, true);
  assert.equal(limits.source, 'provider-model');

  // modelSupportsVision stays authoritative for the proxy (request model id).
  assert.equal(modelSupportsVision('deepseek-v4-pro'), false);
});

test('deepseek-v4-flash-vision-exp resolves supportsVision=true', async () => {
  const { resolveCoworkModelLimits, modelSupportsVision } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  const limits = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, 'deepseek-v4-flash-vision-exp');
  assert.equal(limits.supportsVision, true);
  assert.equal(limits.contextWindow, 1_000_000);
  assert.equal(limits.maxOutputTokens, 32_768);
  assert.equal(limits.source, 'known-model');
  assert.equal(modelSupportsVision('deepseek-v4-flash-vision-exp'), true);
});

test('catalog supportsImage maps onto supportsVision', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  const limits = resolveCoworkModelLimits({
    model: {
      defaultModel: 'custom-vision',
      availableModels: [{ id: 'custom-vision', supportsImage: true, contextWindow: 128_000 }],
    },
    providers: {},
  }, 'custom-vision');
  assert.equal(limits.supportsVision, true);
  assert.equal(limits.source, 'available-model');
});

// ---------------------------------------------------------------------------
// DeepSeek V4 family fallback (2026-09-09 cw-86812c4f stall): ephemeral SKU
// suffixes (deepseek-v4.1-flash-expires-on-0910) escape the exact catalog and
// fell to the old DEFAULT_COWORK_MAX_OUTPUT_TOKENS (8192); with reasoning effort
// 'max' the thinking alone burned that ceiling and the turn ended as a
// hollow-completed reasoning-only truncation. Any id whose last path segment
// starts with 'deepseek-v4' now inherits the family limits.
// ---------------------------------------------------------------------------

test('uncatalogued v4.1 promo SKU with partial provider metadata inherits the family output ceiling (cw-86812c4f regression)', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  // The exact production config of the stalled session: provider entry with
  // contextWindow but NO maxOutputTokens, and no catalog entry for the id.
  const limits = resolveCoworkModelLimits({
    model: { defaultModel: 'deepseek-v4.1-flash-expires-on-0910', availableModels: [] },
    providers: {
      deepseek: {
        enabled: true,
        models: [
          { id: 'deepseek-v4.1-flash-expires-on-0910', supportsImage: false, contextWindow: 1_000_000 },
        ],
      },
    },
  });

  assert.equal(limits.contextWindow, 1_000_000);
  assert.equal(limits.maxOutputTokens, 32_768);
  assert.equal(limits.supportsVision, false);
  assert.equal(limits.source, 'provider-model');
});

test('uncatalogued v4 family id without any provider metadata resolves family-model limits', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  const limits = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, 'deepseek-v4.2-ultra');
  assert.equal(limits.contextWindow, 1_000_000);
  assert.equal(limits.maxOutputTokens, 32_768);
  assert.equal(limits.supportsVision, false);
  assert.equal(limits.source, 'family-model');
});

test('gateway-prefixed v4.1 ids match on the last path segment', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  const limits = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, 'deepseek/deepseek-v4.1-flash');
  assert.equal(limits.maxOutputTokens, 32_768);
  assert.equal(limits.source, 'family-model');
});

test('gateway-prefixed deepseek-flash ids inherit the multimodal V4.1 family limits', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  // The renamed V4.1 line (deepseek-v4-flash → deepseek-flash, 2026-09-10) is
  // natively multimodal, so its family fallback marks vision true — unlike
  // the legacy v4-* line, which stays fail-safe false unless the SKU says so.
  const limits = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, 'deepseek/deepseek-flash');
  assert.equal(limits.contextWindow, 1_000_000);
  assert.equal(limits.maxOutputTokens, 32_768);
  assert.equal(limits.supportsVision, true);
  assert.equal(limits.source, 'family-model');
});

test('family fallback marks vision SKUs and never overrides explicit provider values', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  const vision = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, 'deepseek-v4.1-flash-vision');
  assert.equal(vision.supportsVision, true);
  assert.equal(vision.maxOutputTokens, 32_768);

  const explicit = resolveCoworkModelLimits({
    model: { defaultModel: 'deepseek-v4.1-pro', availableModels: [] },
    providers: {
      deepseek: {
        enabled: true,
        models: [{ id: 'deepseek-v4.1-pro', maxOutputTokens: 16_000 }],
      },
    },
  });
  assert.equal(explicit.maxOutputTokens, 16_000);
  assert.equal(explicit.source, 'provider-model');
});

test('unknown models inherit the 32K default output ceiling', async () => {
  const { resolveCoworkModelLimits, DEFAULT_COWORK_MAX_OUTPUT_TOKENS } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  const limits = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, 'some-gw/deepseek-chat');
  assert.equal(DEFAULT_COWORK_MAX_OUTPUT_TOKENS, 32_768);
  assert.equal(limits.maxOutputTokens, DEFAULT_COWORK_MAX_OUTPUT_TOKENS);
  assert.equal(limits.source, 'fallback');
});

test('catalogued models without an explicit output ceiling inherit the 32K default', async () => {
  const { resolveCoworkModelLimits } =
    await import('../dist-electron/main/libs/coworkModelLimits.js');

  for (const modelId of ['claude-sonnet-4-6', 'gpt-5.6-sol', 'kimi-k2.6', 'MiniMax-M3', 'qwen3.6-plus']) {
    const limits = resolveCoworkModelLimits(APP_CONFIG_WITHOUT_PROVIDER_META, modelId);
    assert.equal(limits.maxOutputTokens, 32_768, `${modelId} must inherit the 32K default`);
    assert.equal(limits.source, 'known-model', modelId);
  }
});
