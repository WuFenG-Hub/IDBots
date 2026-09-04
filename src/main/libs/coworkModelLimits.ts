export const DEFAULT_COWORK_CONTEXT_WINDOW = 128_000;
export const DEFAULT_COWORK_MAX_OUTPUT_TOKENS = 8_192;
// The whole DeepSeek V4 family shares the same 1M context window. The flash
// variant powers cowork/A2A automation sessions (via resolveAutomationModelOverride),
// so it must carry the same window as v4-pro or the context ring wrongly falls back
// to DEFAULT_COWORK_CONTEXT_WINDOW (128K) for every automation-driven conversation.
export const DEEPSEEK_V4_PRO_CONTEXT_WINDOW = 1_000_000;
export const DEEPSEEK_V4_FLASH_CONTEXT_WINDOW = 1_000_000;
// The DeepSeek API allows up to 384K output tokens for the whole V4 family
// (https://api-docs.deepseek.com/zh-cn/quick_start/pricing). 32K is the app's
// declared ceiling — aligned with the MetaApp bridge's maxOutputTokens
// validation limit (botBrowserBridgeService) — and only caps generation; it
// costs nothing for short replies since billing is by actual tokens used.
// Thinking-mode reasoning shares this budget, so small ceilings truncate
// thinking-enabled replies (the 2026-08-08 dream-diary failure mode).
export const DEEPSEEK_V4_PRO_MAX_OUTPUT_TOKENS = 32_768;
export const DEEPSEEK_V4_FLASH_MAX_OUTPUT_TOKENS = 32_768;

export type CoworkModelLimitSource = 'provider-model' | 'available-model' | 'known-model' | 'fallback';

export interface CoworkModelLimits {
  modelId: string;
  contextWindow: number;
  maxOutputTokens: number;
  /**
   * Whether the model can consume image content blocks (vision). Unknown /
   * unlisted models default to `false` (fail-safe): the Read-image guard then
   * denies image reads with an explicit pointer to the relay-backed
   * describe_image instead of silently dropping pixels on a model that
   * cannot read them (the 2026-09-04 glm-5.3-flash regression). Only models
   * KNOWN to support vision are marked true.
   */
  supportsVision: boolean;
  source: CoworkModelLimitSource;
}

type ModelLike = {
  id?: unknown;
  contextWindow?: unknown;
  maxOutputTokens?: unknown;
  supportsVision?: unknown;
  supportsImage?: unknown;
};

type ProviderLike = {
  enabled?: unknown;
  models?: unknown;
};

type AppConfigLike = {
  model?: {
    defaultModel?: unknown;
    availableModels?: unknown;
  };
  providers?: Record<string, ProviderLike> | null;
};

const KNOWN_MODEL_LIMITS: Record<string, Partial<Pick<CoworkModelLimits, 'contextWindow' | 'maxOutputTokens' | 'supportsVision'>>> = {
  // DeepSeek V4 Flash / Pro have no vision (2026-08-09 diagnosis:
  // deepseek-v4-pro session ballooned to 60% context from Read image base64
  // the model could never interpret). 0.1.1 adds flash-vision-exp as the
  // official vision SKU. Read/View image guards key off this.
  'deepseek-v4-pro': {
    contextWindow: DEEPSEEK_V4_PRO_CONTEXT_WINDOW,
    maxOutputTokens: DEEPSEEK_V4_PRO_MAX_OUTPUT_TOKENS,
    supportsVision: false,
  },
  'deepseek-v4-flash': {
    contextWindow: DEEPSEEK_V4_FLASH_CONTEXT_WINDOW,
    maxOutputTokens: DEEPSEEK_V4_FLASH_MAX_OUTPUT_TOKENS,
    supportsVision: false,
  },
  'deepseek-v4-flash-vision-exp': {
    contextWindow: DEEPSEEK_V4_FLASH_CONTEXT_WINDOW,
    maxOutputTokens: DEEPSEEK_V4_FLASH_MAX_OUTPUT_TOKENS,
    supportsVision: true,
  },
  // 与 src/renderer/config.ts 预设模型保持一致的大上下文模型（2026-07 向 LobsterAI 对齐）
  'gpt-5.6-sol': { contextWindow: 1_050_000, supportsVision: true },
  'gpt-5.6-terra': { contextWindow: 1_050_000, supportsVision: true },
  'gpt-5.6-luna': { contextWindow: 1_050_000, supportsVision: true },
  // Older GPT-5.x presets still offered by the renderer; inherit the same family window.
  'gpt-5.5': { contextWindow: 1_050_000, supportsVision: true },
  'gpt-5.4': { contextWindow: 1_050_000, supportsVision: true },
  'claude-opus-4-7': { contextWindow: 1_048_576, supportsVision: true },
  'claude-opus-4-6': { contextWindow: 1_048_576, supportsVision: true },
  'claude-sonnet-4-6': { contextWindow: 1_048_576, supportsVision: true },
  // OpenRouter aliases route to the same upstream models.
  'anthropic/claude-sonnet-4.6': { contextWindow: 1_048_576, supportsVision: true },
  'anthropic/claude-opus-4.7': { contextWindow: 1_048_576, supportsVision: true },
  'openai/gpt-5.5': { contextWindow: 1_050_000, supportsVision: true },
  'google/gemini-3.1-pro-preview': { contextWindow: 2_000_000, supportsVision: true },
  // Gemini 3.x family — 2M context per Google's Gemini 3 spec.
  'gemini-3.1-pro-preview': { contextWindow: 2_000_000, supportsVision: true },
  'gemini-3-flash-preview': { contextWindow: 2_000_000, supportsVision: true },
  'gemini-3.1-flash-lite': { contextWindow: 2_000_000, supportsVision: true },
  'kimi-k2.6': { contextWindow: 262_144, supportsVision: true },
  'kimi-k2.5': { contextWindow: 262_144, supportsVision: true },
  // GLM text models have no image input — aligned with the curated renderer
  // presets (src/renderer/config.ts: zhipu glm-5.1/5/4.7 and commandcode
  // z-ai/glm-5.3-flash + zai-org/GLM-5.x all declare supportsImage:false;
  // Zhipu ships vision under separate SKU ids). The glm-5.3 family is what
  // group-task bots were re-routed to on 2026-09-03: uncatalogued at the
  // time, it inherited the old default-true and lost describe_image while
  // read_image silently dropped pixels (2026-09-04 regression).
  'glm-5.3-flash': { contextWindow: 1_048_576, supportsVision: false },
  'glm-5.3': { contextWindow: 1_000_000, supportsVision: false },
  'glm-5.2': { contextWindow: 1_000_000, supportsVision: false },
  'glm-5.2-fast': { contextWindow: 1_000_000, supportsVision: false },
  'z-ai/glm-5.3-flash': { contextWindow: 1_048_576, supportsVision: false },
  'zai-org/GLM-5.3': { contextWindow: 1_000_000, supportsVision: false },
  'zai-org/GLM-5.2': { contextWindow: 1_000_000, supportsVision: false },
  'zai-org/GLM-5.2-Fast': { contextWindow: 1_000_000, supportsVision: false },
  'zai-org/GLM-5.1': { contextWindow: 202_800, supportsVision: false },
  'zai-org/GLM-5': { contextWindow: 202_800, supportsVision: false },
  'glm-5.1': { contextWindow: 202_800, supportsVision: false },
  'glm-5': { contextWindow: 202_800, supportsVision: false },
  'glm-4.7': { contextWindow: 204_800, supportsVision: false },
  'glm-4.7-flash': { contextWindow: 204_800, supportsVision: false },
  'MiniMax-M3': { contextWindow: 1_000_000, supportsVision: true },
  'MiniMax-M2.7': { contextWindow: 204_800, supportsVision: true },
  'MiniMax-M2.5': { contextWindow: 204_800, supportsVision: true },
  'qwen3.6-plus': { contextWindow: 1_000_000, supportsVision: true },
  'qwen3.5-plus': { contextWindow: 1_000_000, supportsVision: true },
  // Qwen3 coder / ollama-local preset; Qwen3 family supports up to 1M.
  'qwen3-coder-next': { contextWindow: 1_000_000, supportsVision: true },
  'mimo-v2.5-pro': { contextWindow: 1_000_000, supportsVision: true },
  'mimo-v2.5': { contextWindow: 1_000_000, supportsVision: true },
};

function normalizeModelId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function isModelLike(value: unknown): value is ModelLike {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function getModelLimits(model: ModelLike): Partial<Pick<CoworkModelLimits, 'contextWindow' | 'maxOutputTokens' | 'supportsVision'>> {
  const supportsVision = typeof model.supportsVision === 'boolean'
    ? model.supportsVision
    : typeof model.supportsImage === 'boolean'
      ? model.supportsImage
      : undefined;
  return {
    contextWindow: toPositiveInteger(model.contextWindow),
    maxOutputTokens: toPositiveInteger(model.maxOutputTokens),
    supportsVision,
  };
}

function findModelById(models: unknown, modelId: string): ModelLike | null {
  if (!Array.isArray(models) || !modelId) {
    return null;
  }
  for (const model of models) {
    if (!isModelLike(model)) {
      continue;
    }
    if (normalizeModelId(model.id) === modelId) {
      return model;
    }
  }
  return null;
}

function findFirstModelId(models: unknown): string {
  if (!Array.isArray(models)) {
    return '';
  }
  for (const model of models) {
    if (!isModelLike(model)) {
      continue;
    }
    const modelId = normalizeModelId(model.id);
    if (modelId) {
      return modelId;
    }
  }
  return '';
}

function resolveTargetModelId(appConfig: AppConfigLike, overrideModelId?: string | null): string {
  const explicit = normalizeModelId(overrideModelId);
  if (explicit) {
    return explicit;
  }

  const defaultModel = normalizeModelId(appConfig.model?.defaultModel);
  if (defaultModel) {
    return defaultModel;
  }

  for (const provider of Object.values(appConfig.providers ?? {})) {
    if (!provider?.enabled) {
      continue;
    }
    const providerModelId = findFirstModelId(provider.models);
    if (providerModelId) {
      return providerModelId;
    }
  }

  return findFirstModelId(appConfig.model?.availableModels);
}

function buildLimits(
  modelId: string,
  source: CoworkModelLimitSource,
  explicit?: Partial<Pick<CoworkModelLimits, 'contextWindow' | 'maxOutputTokens' | 'supportsVision'>>,
): CoworkModelLimits {
  const known = KNOWN_MODEL_LIMITS[modelId];
  return {
    modelId,
    contextWindow: explicit?.contextWindow ?? known?.contextWindow ?? DEFAULT_COWORK_CONTEXT_WINDOW,
    maxOutputTokens: explicit?.maxOutputTokens ?? known?.maxOutputTokens ?? DEFAULT_COWORK_MAX_OUTPUT_TOKENS,
    // Fail-safe default: uncatalogued models are treated as text-only. A
    // wrong "true" silently drops image pixels on a model that cannot read
    // them (and, while describe_image was gated by this flag, removed the
    // relay fallback from the catalog too — 2026-09-04 glm-5.3-flash). A
    // wrong "false" is loud: the Read-image guard denies with an explicit
    // pointer to describe_image, which works on every route.
    supportsVision: explicit?.supportsVision ?? known?.supportsVision ?? false,
    source,
  };
}

/**
 * Query whether a model id can consume image content blocks, without needing
 * a full app config. Mirrors buildLimits' fail-safe default (unknown =>
 * false). Used by the OpenAI-compat proxy to degrade image blocks for
 * non-vision models when replaying history.
 */
export function modelSupportsVision(modelId: string | null | undefined): boolean {
  const normalized = normalizeModelId(modelId);
  if (!normalized) {
    return false;
  }
  return KNOWN_MODEL_LIMITS[normalized]?.supportsVision ?? false;
}

export function resolveCoworkModelLimits(
  appConfig: AppConfigLike,
  overrideModelId?: string | null,
): CoworkModelLimits {
  const modelId = resolveTargetModelId(appConfig, overrideModelId);

  for (const provider of Object.values(appConfig.providers ?? {})) {
    if (!provider?.enabled) {
      continue;
    }
    const model = findModelById(provider.models, modelId);
    if (!model) {
      continue;
    }
    const explicit = getModelLimits(model);
    if (explicit.contextWindow || explicit.maxOutputTokens || explicit.supportsVision !== undefined) {
      return buildLimits(modelId, 'provider-model', explicit);
    }
  }

  const availableModel = findModelById(appConfig.model?.availableModels, modelId);
  if (availableModel) {
    const explicit = getModelLimits(availableModel);
    if (explicit.contextWindow || explicit.maxOutputTokens || explicit.supportsVision !== undefined) {
      return buildLimits(modelId, 'available-model', explicit);
    }
  }

  if (KNOWN_MODEL_LIMITS[modelId]) {
    return buildLimits(modelId, 'known-model');
  }

  return buildLimits(modelId, 'fallback');
}
