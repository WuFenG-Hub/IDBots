export const DEFAULT_COWORK_CONTEXT_WINDOW = 128_000;
export const DEFAULT_COWORK_MAX_OUTPUT_TOKENS = 8_192;
// The whole DeepSeek V4 family shares the same 1M context window. The flash
// variant powers cowork/A2A automation sessions (via resolveAutomationModelOverride),
// so it must carry the same window as v4-pro or the context ring wrongly falls back
// to DEFAULT_COWORK_CONTEXT_WINDOW (128K) for every automation-driven conversation.
export const DEEPSEEK_V4_PRO_CONTEXT_WINDOW = 1_000_000;
export const DEEPSEEK_V4_PRO_MAX_OUTPUT_TOKENS = 16_000;
export const DEEPSEEK_V4_FLASH_CONTEXT_WINDOW = 1_000_000;

export type CoworkModelLimitSource = 'provider-model' | 'available-model' | 'known-model' | 'fallback';

export interface CoworkModelLimits {
  modelId: string;
  contextWindow: number;
  maxOutputTokens: number;
  source: CoworkModelLimitSource;
}

type ModelLike = {
  id?: unknown;
  contextWindow?: unknown;
  maxOutputTokens?: unknown;
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

const KNOWN_MODEL_LIMITS: Record<string, Partial<Pick<CoworkModelLimits, 'contextWindow' | 'maxOutputTokens'>>> = {
  'deepseek-v4-pro': {
    contextWindow: DEEPSEEK_V4_PRO_CONTEXT_WINDOW,
    maxOutputTokens: DEEPSEEK_V4_PRO_MAX_OUTPUT_TOKENS,
  },
  'deepseek-v4-flash': {
    contextWindow: DEEPSEEK_V4_FLASH_CONTEXT_WINDOW,
  },
  // 与 src/renderer/config.ts 预设模型保持一致的大上下文模型（2026-07 向 LobsterAI 对齐）
  'gpt-5.6-sol': { contextWindow: 1_050_000 },
  'gpt-5.6-terra': { contextWindow: 1_050_000 },
  'gpt-5.6-luna': { contextWindow: 1_050_000 },
  // Older GPT-5.x presets still offered by the renderer; inherit the same family window.
  'gpt-5.5': { contextWindow: 1_050_000 },
  'gpt-5.4': { contextWindow: 1_050_000 },
  'claude-opus-4-7': { contextWindow: 1_048_576 },
  'claude-opus-4-6': { contextWindow: 1_048_576 },
  'claude-sonnet-4-6': { contextWindow: 1_048_576 },
  // OpenRouter aliases route to the same upstream models.
  'anthropic/claude-sonnet-4.6': { contextWindow: 1_048_576 },
  'anthropic/claude-opus-4.7': { contextWindow: 1_048_576 },
  'openai/gpt-5.5': { contextWindow: 1_050_000 },
  'google/gemini-3.1-pro-preview': { contextWindow: 2_000_000 },
  // Gemini 3.x family — 2M context per Google's Gemini 3 spec.
  'gemini-3.1-pro-preview': { contextWindow: 2_000_000 },
  'gemini-3-flash-preview': { contextWindow: 2_000_000 },
  'gemini-3.1-flash-lite': { contextWindow: 2_000_000 },
  'kimi-k2.6': { contextWindow: 262_144 },
  'kimi-k2.5': { contextWindow: 262_144 },
  'glm-5.1': { contextWindow: 202_800 },
  'glm-5': { contextWindow: 202_800 },
  'glm-4.7': { contextWindow: 204_800 },
  'glm-4.7-flash': { contextWindow: 204_800 },
  'MiniMax-M3': { contextWindow: 1_000_000 },
  'MiniMax-M2.7': { contextWindow: 204_800 },
  'MiniMax-M2.5': { contextWindow: 204_800 },
  'qwen3.6-plus': { contextWindow: 1_000_000 },
  'qwen3.5-plus': { contextWindow: 1_000_000 },
  // Qwen3 coder / ollama-local preset; Qwen3 family supports up to 1M.
  'qwen3-coder-next': { contextWindow: 1_000_000 },
  'mimo-v2.5-pro': { contextWindow: 1_000_000 },
  'mimo-v2.5': { contextWindow: 1_000_000 },
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

function getModelLimits(model: ModelLike): Partial<Pick<CoworkModelLimits, 'contextWindow' | 'maxOutputTokens'>> {
  return {
    contextWindow: toPositiveInteger(model.contextWindow),
    maxOutputTokens: toPositiveInteger(model.maxOutputTokens),
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
  explicit?: Partial<Pick<CoworkModelLimits, 'contextWindow' | 'maxOutputTokens'>>,
): CoworkModelLimits {
  const known = KNOWN_MODEL_LIMITS[modelId];
  return {
    modelId,
    contextWindow: explicit?.contextWindow ?? known?.contextWindow ?? DEFAULT_COWORK_CONTEXT_WINDOW,
    maxOutputTokens: explicit?.maxOutputTokens ?? known?.maxOutputTokens ?? DEFAULT_COWORK_MAX_OUTPUT_TOKENS,
    source,
  };
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
    if (explicit.contextWindow || explicit.maxOutputTokens) {
      return buildLimits(modelId, 'provider-model', explicit);
    }
  }

  const availableModel = findModelById(appConfig.model?.availableModels, modelId);
  if (availableModel) {
    const explicit = getModelLimits(availableModel);
    if (explicit.contextWindow || explicit.maxOutputTokens) {
      return buildLimits(modelId, 'available-model', explicit);
    }
  }

  if (KNOWN_MODEL_LIMITS[modelId]) {
    return buildLimits(modelId, 'known-model');
  }

  return buildLimits(modelId, 'fallback');
}
