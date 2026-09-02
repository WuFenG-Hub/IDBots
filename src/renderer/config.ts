import type { CoworkPermissionMode } from './types/cowork';

export type ModelOptions = {
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max';
  thinking?: {
    type: 'enabled' | 'disabled';
  };
};

type ConfiguredModel = {
  id: string;
  name: string;
  supportsImage?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  options?: ModelOptions;
};

// 配置类型定义
export interface AppConfig {
  // API 配置
  api: {
    key: string;
    baseUrl: string;
  };
  // 模型配置
  model: {
    availableModels: ConfiguredModel[];
    defaultModel: string;
    /**
     * Provider key ('deepseek', 'opencode', ...) recorded when the user
     * picks a model in the UI, so identical model ids offered by multiple
     * enabled providers resolve to the user's chosen provider instead of the
     * first one in config order.
     */
    defaultProvider?: string;
  };
  // 多模型提供商配置
  providers?: {
    openai: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      // API 协议格式：anthropic 为 Anthropic 兼容，openai 为 OpenAI 兼容
      apiFormat?: 'anthropic' | 'openai' | 'responses';
      models?: ConfiguredModel[];
    };
    deepseek: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'responses';
      models?: ConfiguredModel[];
    };
    moonshot: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'responses';
      models?: ConfiguredModel[];
    };
    zhipu: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'responses';
      models?: ConfiguredModel[];
    };
    minimax: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'responses';
      models?: ConfiguredModel[];
    };
    qwen: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'responses';
      models?: ConfiguredModel[];
    };
    openrouter: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'responses';
      models?: ConfiguredModel[];
    };
    gemini: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'responses';
      models?: ConfiguredModel[];
    };
    anthropic: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'responses';
      models?: ConfiguredModel[];
    };
    xiaomi: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'responses';
      models?: ConfiguredModel[];
    };
    // 火山引擎方舟（Volcengine Ark）：豆包聊天模型走 OpenAI 兼容端点；
    // 同一 apiKey 也是内置 seedance/seedream 技能的 ARK_API_KEY 来源
    // （见 skillImageProviderEnv.ts），配置一次即可同时驱动聊天与生成。
    volcengine: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'responses';
      models?: ConfiguredModel[];
    };
    ollama: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai' | 'responses';
      models?: ConfiguredModel[];
    };
    [key: string]: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      // API 协议格式：anthropic 为 Anthropic Messages，openai 为 Chat Completions，responses 为 OpenAI Responses
      apiFormat?: 'anthropic' | 'openai' | 'responses';
      models?: ConfiguredModel[];
      // 自定义供应商显示名称（内置供应商无此字段，label 来自 providerMeta）
      name?: string;
    };
  };
  // 主题配置
  theme: 'light' | 'dark' | 'system';
  // 语言配置
  language: 'zh' | 'en';
  // 语言初始化标记 (用于判断是否是首次启动)
  language_initialized?: boolean;
  // Provider 预设模型迁移版本号 (升级后自动注入新模型/移除已淘汰模型，详见 services/config.ts)
  providerModelMigrationVersion?: number;
  // Provider API 格式语义迁移版本号 (升级后自动纠正出厂默认 apiFormat，详见 services/config.ts)
  providerApiFormatMigrationVersion?: number;
  // 应用配置
  app: {
    port: number;
    isDevelopment: boolean;
  };
  // 快捷键配置
  shortcuts?: {
    newChat: string;
    search: string;
    settings: string;
    [key: string]: string | undefined;
  };
  // 费率配置 (用户选定的各网络费率)
  feeRates?: {
    btc?: number;
    mvc?: number;
    doge?: number;
  };
  /**
   * Persisted auto-approve tool rules. New cowork sessions start with this list
   * as the default; the user's latest changes are saved here.
   */
  autoApproveTools?: string[];
  /**
   * Global default permission mode for cowork sessions. The user's latest
   * selection is persisted here and inherited by every new session (and Bot).
   */
  coworkPermissionMode?: CoworkPermissionMode;
  coworkEffortLevel?: string | null;
  /**
   * Phase 1 M5 rollout flag: run cowork sessions on the DSH kernel when the
   * resolved provider route is OpenAI-compatible. Opt-in; sessions that have
   * already run on DSH stay pinned to it via the `dsh:` session-handle prefix.
   */
  dshKernelEnabled?: boolean;
}

type ModelDefinition = AppConfig['model']['availableModels'][number];
type ProviderDefinition = NonNullable<AppConfig['providers']>[string];
type ProviderModelDefinition = NonNullable<ProviderDefinition['models']>[number];
type ModelLike = {
  id: string;
  name: string;
  supportsImage?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  options?: ModelOptions;
};

export const DEEPSEEK_DEFAULT_MODEL_ID = 'deepseek-v4-flash';
export const DEEPSEEK_V4_PRO_CONTEXT_WINDOW = 1_000_000;
// The DeepSeek API allows up to 384K output tokens for the whole V4 family;
// the app declares a 32K ceiling (aligned with the MetaApp bridge limit).
// Keep in sync with src/main/libs/coworkModelLimits.ts.
export const DEEPSEEK_V4_PRO_MAX_OUTPUT_TOKENS = 32_768;
// Same family, same 1M context window. The flash variant drives cowork/A2A
// automation sessions, so it must carry a real context window or the context
// usage ring falls back to the 128K default.
export const DEEPSEEK_V4_FLASH_CONTEXT_WINDOW = 1_000_000;
export const DEEPSEEK_V4_FLASH_MAX_OUTPUT_TOKENS = 32_768;
export const DEEPSEEK_V4_FLASH_VISION_MODEL_ID = 'deepseek-v4-flash-vision-exp';

const DEEPSEEK_DEFAULT_MODELS: ReadonlyArray<ModelLike> = Object.freeze([
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    supportsImage: false,
    contextWindow: DEEPSEEK_V4_FLASH_CONTEXT_WINDOW,
    maxOutputTokens: DEEPSEEK_V4_FLASH_MAX_OUTPUT_TOKENS,
    // DeepSeek-first policy (reconsidered 2026-08-18 — a one-day 快速 default
    // was dropped: work sessions produce the actual deliverables, they should
    // not run with thinking silently off): flash is the default for all
    // automation paths, thinking ON at max effort so orchestrator /
    // private-chat / group-task / browser-bridge calls get full reasoning.
    // Known exceptions opt out explicitly (e.g. dream needs the output budget
    // for JSON). The effort selector still downgrades per session.
    options: {
      reasoningEffort: 'max',
      thinking: { type: 'enabled' },
    },
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    supportsImage: false,
    contextWindow: DEEPSEEK_V4_PRO_CONTEXT_WINDOW,
    maxOutputTokens: DEEPSEEK_V4_PRO_MAX_OUTPUT_TOKENS,
    options: {
      reasoningEffort: 'max',
      thinking: { type: 'enabled' },
    },
  },
  {
    id: DEEPSEEK_V4_FLASH_VISION_MODEL_ID,
    name: 'DeepSeek V4 Flash Vision Exp',
    supportsImage: true,
    contextWindow: DEEPSEEK_V4_FLASH_CONTEXT_WINDOW,
    maxOutputTokens: DEEPSEEK_V4_FLASH_MAX_OUTPUT_TOKENS,
    options: {
      reasoningEffort: 'max',
      thinking: { type: 'enabled' },
    },
  },
]);

const DEEPSEEK_DEFAULT_MODEL_ORDER = DEEPSEEK_DEFAULT_MODELS.map((model) => model.id);

const DEEPSEEK_LEGACY_MODEL_MIGRATION_MAP: Readonly<Record<string, ModelLike>> = Object.freeze({
  'deepseek-chat': DEEPSEEK_DEFAULT_MODELS[0],
  'deepseek-reasoner': DEEPSEEK_DEFAULT_MODELS[1],
});

export function getDefaultDeepSeekModels(): ModelDefinition[] {
  return DEEPSEEK_DEFAULT_MODELS.map((model) => ({
    ...model,
    options: model.options
      ? {
          ...model.options,
          thinking: model.options.thinking ? { ...model.options.thinking } : undefined,
        }
      : undefined,
  }));
}

function normalizeDeepSeekModel(model: ModelLike): ModelLike {
  const migrated = DEEPSEEK_LEGACY_MODEL_MIGRATION_MAP[model.id];
  const canonical = DEEPSEEK_DEFAULT_MODELS.find((entry) => entry.id === (migrated?.id ?? model.id));
  if (!migrated) {
    if (!canonical) {
      return { ...model };
    }
    return {
      ...model,
      supportsImage: canonical.supportsImage ?? model.supportsImage,
      contextWindow: model.contextWindow ?? canonical.contextWindow,
      maxOutputTokens: model.maxOutputTokens ?? canonical.maxOutputTokens,
      options: model.options ?? canonical.options,
    };
  }
  return {
    ...model,
    id: migrated.id,
    name: migrated.name,
    supportsImage: migrated.supportsImage,
    contextWindow: migrated.contextWindow,
    maxOutputTokens: migrated.maxOutputTokens,
    options: migrated.options,
  };
}

function dedupeModels<T extends ModelLike>(models: T[]): T[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.id)) {
      return false;
    }
    seen.add(model.id);
    return true;
  });
}

function maybeCanonicalizeDeepSeekDefaults<T extends ModelLike>(models: T[]): T[] {
  if (
    models.length !== DEEPSEEK_DEFAULT_MODEL_ORDER.length
    || models.some((model) => !DEEPSEEK_DEFAULT_MODEL_ORDER.includes(model.id))
  ) {
    return models;
  }
  return [...models].sort(
    (left, right) => DEEPSEEK_DEFAULT_MODEL_ORDER.indexOf(left.id) - DEEPSEEK_DEFAULT_MODEL_ORDER.indexOf(right.id),
  );
}

/** Stored catalogs that are exactly Flash+Pro (the 0.1.0 default pair) pick up
 *  the 0.1.1 vision model. Custom lists are left alone. */
const PREVIOUS_DEEPSEEK_DEFAULT_IDS = Object.freeze(['deepseek-v4-flash', 'deepseek-v4-pro']);

function cloneDefaultModel<T extends ModelLike>(model: ModelLike): T {
  return {
    ...model,
    options: model.options
      ? {
          ...model.options,
          thinking: model.options.thinking ? { ...model.options.thinking } : undefined,
        }
      : undefined,
  } as T;
}

function ensureCanonicalDeepSeekCatalog<T extends ModelLike>(models: T[]): T[] {
  const ids = new Set(models.map((model) => model.id));
  const isPreviousDefaultPair = models.length === PREVIOUS_DEEPSEEK_DEFAULT_IDS.length
    && PREVIOUS_DEEPSEEK_DEFAULT_IDS.every((id) => ids.has(id));
  if (isPreviousDefaultPair) {
    const vision = DEEPSEEK_DEFAULT_MODELS.find((entry) => entry.id === DEEPSEEK_V4_FLASH_VISION_MODEL_ID);
    if (vision) {
      return maybeCanonicalizeDeepSeekDefaults([...models, cloneDefaultModel<T>(vision)]);
    }
  }
  return maybeCanonicalizeDeepSeekDefaults(models);
}

function normalizeDeepSeekModelList<T extends ModelLike>(models?: T[] | null): T[] | undefined {
  if (!models) {
    return undefined;
  }
  return ensureCanonicalDeepSeekCatalog(dedupeModels(models.map((model) => normalizeDeepSeekModel(model) as T)));
}

function normalizeDeepSeekDefaultModel(defaultModel: string, availableModels: ModelLike[]): string {
  const migratedDefault = DEEPSEEK_LEGACY_MODEL_MIGRATION_MAP[defaultModel]?.id ?? defaultModel;
  if (availableModels.some((model) => model.id === migratedDefault)) {
    return migratedDefault;
  }
  if (availableModels.some((model) => model.id === DEEPSEEK_DEFAULT_MODEL_ID)) {
    return DEEPSEEK_DEFAULT_MODEL_ID;
  }
  return availableModels[0]?.id ?? DEEPSEEK_DEFAULT_MODEL_ID;
}

function hasConfiguredProviderApiKey(providers?: AppConfig['providers']): boolean {
  if (!providers) {
    return false;
  }
  return Object.values(providers).some(
    (provider) => provider?.enabled && typeof provider.apiKey === 'string' && provider.apiKey.trim() !== '',
  );
}

function detectLegacyProviderFromApiBaseUrl(baseUrl: string): keyof NonNullable<AppConfig['providers']> | null {
  const normalizedBaseUrl = baseUrl.trim().toLowerCase();
  if (!normalizedBaseUrl) {
    return null;
  }
  if (normalizedBaseUrl.includes('openai')) return 'openai';
  if (normalizedBaseUrl.includes('deepseek')) return 'deepseek';
  if (normalizedBaseUrl.includes('moonshot.ai') || normalizedBaseUrl.includes('moonshot.cn')) return 'moonshot';
  if (normalizedBaseUrl.includes('bigmodel.cn')) return 'zhipu';
  if (normalizedBaseUrl.includes('minimax')) return 'minimax';
  if (normalizedBaseUrl.includes('dashscope')) return 'qwen';
  if (normalizedBaseUrl.includes('volces.com')) return 'volcengine';
  if (normalizedBaseUrl.includes('openrouter.ai')) return 'openrouter';
  if (normalizedBaseUrl.includes('googleapis')) return 'gemini';
  if (normalizedBaseUrl.includes('anthropic')) return 'anthropic';
  if (normalizedBaseUrl.includes('ollama') || normalizedBaseUrl.includes('11434')) return 'ollama';
  return null;
}

function inferLegacyApiFormat(
  providerKey: keyof NonNullable<AppConfig['providers']>,
  baseUrl: string,
): 'anthropic' | 'openai' {
  if (providerKey === 'openai' || providerKey === 'gemini') {
    return 'openai';
  }
  if (providerKey === 'anthropic') {
    return 'anthropic';
  }
  return baseUrl.toLowerCase().includes('/anthropic') ? 'anthropic' : 'openai';
}

function normalizeLegacyApiBackfill(providers: AppConfig['providers'], api: AppConfig['api']): AppConfig['providers'] {
  const legacyApiKey = typeof api.key === 'string' ? api.key.trim() : '';
  const legacyBaseUrl = typeof api.baseUrl === 'string' ? api.baseUrl.trim().replace(/\/+$/, '') : '';
  if (!legacyApiKey || !legacyBaseUrl || hasConfiguredProviderApiKey(providers)) {
    return providers;
  }

  const providerKey = detectLegacyProviderFromApiBaseUrl(legacyBaseUrl);
  if (!providerKey) {
    return providers;
  }

  const nextProviders = { ...((providers ?? defaultConfig.providers) as NonNullable<AppConfig['providers']>) };
  const existingProvider = nextProviders[providerKey];
  nextProviders[providerKey] = {
    ...existingProvider,
    enabled: true,
    apiKey: legacyApiKey,
    baseUrl: legacyBaseUrl,
    apiFormat: inferLegacyApiFormat(providerKey, legacyBaseUrl),
    models: existingProvider?.models,
  };
  return nextProviders;
}

export function normalizeDeepSeekAppConfig(config: AppConfig): AppConfig {
  const normalizedAvailableModels = normalizeDeepSeekModelList(config.model.availableModels)
    ?? getDefaultDeepSeekModels();
  const normalizedProviders = config.providers
    ? Object.fromEntries(
        Object.entries(config.providers).map(([providerKey, providerConfig]) => [
          providerKey,
          providerKey === 'deepseek'
            ? {
                ...providerConfig,
                models: normalizeDeepSeekModelList(providerConfig.models as ProviderModelDefinition[] | undefined)
                  ?? getDefaultDeepSeekModels(),
              }
            : providerConfig,
        ]),
      ) as AppConfig['providers']
    : config.providers;
  const normalizedProvidersWithLegacyApi = normalizeLegacyApiBackfill(normalizedProviders, config.api);

  // The default model must resolve against the configured default provider's
  // catalog, not only the legacy app-level availableModels list. Otherwise a
  // provider whose models are absent from that list (e.g. the built-in
  // metaid-free relay serving deepseek-chat) gets its default rewritten to
  // the deepseek default on every config write, producing a defaultModel /
  // defaultProvider pair that can never resolve.
  const defaultProviderKey = config.model.defaultProvider?.trim().toLowerCase();
  const defaultProvider = defaultProviderKey
    ? Object.entries(normalizedProvidersWithLegacyApi ?? {}).find(
        ([providerKey]) => providerKey.toLowerCase() === defaultProviderKey,
      )?.[1]
    : undefined;
  const defaultProviderModels = defaultProvider?.enabled ? (defaultProvider.models ?? []) : [];
  const defaultModelUniverse = [
    ...(defaultProviderModels as Array<{ id: string; name: string }>),
    ...normalizedAvailableModels,
  ];
  let nextDefaultModel = normalizeDeepSeekDefaultModel(config.model.defaultModel, defaultModelUniverse);
  if (defaultProviderModels.length > 0 && !defaultProviderModels.some((model) => model.id === nextDefaultModel)) {
    nextDefaultModel = defaultProviderModels[0].id;
  }

  return {
    ...config,
    model: {
      ...config.model,
      availableModels: normalizedAvailableModels,
      defaultModel: nextDefaultModel,
    },
    providers: normalizedProvidersWithLegacyApi,
  };
}

// 默认配置
export const defaultConfig: AppConfig = {
  api: {
    key: '',
    baseUrl: 'https://api.deepseek.com/anthropic',
  },
  model: {
    availableModels: getDefaultDeepSeekModels(),
    defaultModel: DEEPSEEK_DEFAULT_MODEL_ID,
  },
  providers: {
    // Built-in free-quota relay provider (assist-base-service llm relay).
    // Stays inert until the first-run bootstrap provisions baseUrl+apiKey+models.
    'metaid-free': {
      enabled: false,
      apiKey: '',
      baseUrl: '',
      apiFormat: 'openai',
      models: [],
      name: 'IDBots-Free',
    },
    deepseek: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.deepseek.com',
      apiFormat: 'openai',
      models: getDefaultDeepSeekModels()
    },
    opencode: {
      enabled: false,
      apiKey: '',
      // OpenCode Go 网关（https://opencode.ai/docs/zh-cn/go），统一走 /v1 前缀，
      // Messages / Chat Completions / Responses 三个端点都挂在同一 Base URL 下。
      // Default to the Responses endpoint: DeepSeek Flash carries reasoning there and
      // the gateway serves pro/flash alike on /v1/responses.
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiFormat: 'responses',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsImage: false, contextWindow: 1_000_000 }
      ]
    },
    commandcode: {
      enabled: false,
      apiKey: '',
      // Command Code gateway (https://commandcode.ai/docs/provider): one Bearer
      // key, Chat Completions / Messages / Models all mounted under /provider/v1.
      // We pin the OpenAI Chat Completions format; the model catalog mirrors the
      // GET /provider/v1/models snapshot (2026-08-27) with endpoint-reported
      // context windows.
      baseUrl: 'https://api.commandcode.ai/provider/v1',
      apiFormat: 'openai',
      models: [
        { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', supportsImage: true, contextWindow: 1_000_000 },
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', supportsImage: true, contextWindow: 1_000_000 },
        { id: 'claude-fable-5', name: 'Claude Fable 5', supportsImage: true, contextWindow: 1_000_000 },
        { id: 'claude-opus-5', name: 'Claude Opus 5', supportsImage: true, contextWindow: 1_000_000 },
        { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', supportsImage: true, contextWindow: 1_000_000 },
        { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', supportsImage: true, contextWindow: 1_000_000 },
        { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', supportsImage: true, contextWindow: 200_000 },
        { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', supportsImage: true, contextWindow: 1_050_000 },
        { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', supportsImage: true, contextWindow: 1_050_000 },
        { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', supportsImage: true, contextWindow: 1_050_000 },
        { id: 'gpt-5.5', name: 'GPT-5.5', supportsImage: true, contextWindow: 400_000 },
        { id: 'gpt-5.4', name: 'GPT-5.4', supportsImage: true, contextWindow: 400_000 },
        { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', supportsImage: true, contextWindow: 400_000 },
        { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', supportsImage: true, contextWindow: 400_000 },
        { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', supportsImage: false, contextWindow: 1_000_000 },
        { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsImage: false, contextWindow: 1_000_000 },
        { id: 'deepseek/deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision (exp)', supportsImage: true, contextWindow: 1_000_000 },
        { id: 'moonshotai/Kimi-K3', name: 'Kimi K3', supportsImage: true, contextWindow: 1_000_000 },
        { id: 'moonshotai/Kimi-K2.7-Code', name: 'Kimi K2.7 Code', supportsImage: true, contextWindow: 256_000 },
        { id: 'moonshotai/Kimi-K2.7-Code-Highspeed', name: 'Kimi K2.7 Code HighSpeed', supportsImage: true, contextWindow: 262_000 },
        { id: 'moonshotai/Kimi-K2.6', name: 'Kimi K2.6', supportsImage: true, contextWindow: 256_000 },
        { id: 'moonshotai/Kimi-K2.5', name: 'Kimi K2.5', supportsImage: true, contextWindow: 256_000 },
        { id: 'z-ai/glm-5.3-flash', name: 'GLM-5.3 Flash', supportsImage: false, contextWindow: 1_048_576 },
        { id: 'zai-org/GLM-5.3', name: 'GLM-5.3', supportsImage: false, contextWindow: 1_000_000 },
        { id: 'zai-org/GLM-5.2', name: 'GLM-5.2', supportsImage: false, contextWindow: 1_000_000 },
        { id: 'zai-org/GLM-5.2-Fast', name: 'GLM-5.2 Fast', supportsImage: false, contextWindow: 1_000_000 },
        { id: 'zai-org/GLM-5.1', name: 'GLM-5.1', supportsImage: false, contextWindow: 200_000 },
        { id: 'zai-org/GLM-5', name: 'GLM-5', supportsImage: false, contextWindow: 200_000 },
        { id: 'MiniMaxAI/MiniMax-M3', name: 'MiniMax M3', supportsImage: true, contextWindow: 1_000_000 },
        { id: 'MiniMaxAI/MiniMax-M2.7', name: 'MiniMax M2.7', supportsImage: false, contextWindow: 200_000 },
        { id: 'minimax/minimax-m3-free', name: 'MiniMax M3 (Free)', supportsImage: true, contextWindow: 1_000_000 },
        { id: 'minimax/minimax-m2.7-free', name: 'MiniMax M2.7 (Free)', supportsImage: false, contextWindow: 197_000 },
        { id: 'MiniMaxAI/MiniMax-M2.5', name: 'MiniMax M2.5', supportsImage: false, contextWindow: 200_000 },
        { id: 'xiaomi/mimo-v2.5-pro', name: 'MiMo V2.5 Pro', supportsImage: false, contextWindow: 1_000_000 },
        { id: 'xiaomi/mimo-v2.5', name: 'MiMo V2.5', supportsImage: true, contextWindow: 1_000_000 },
        { id: 'Qwen/Qwen3.8-Max', name: 'Qwen 3.8 Max', supportsImage: false, contextWindow: 1_000_000 },
        { id: 'Qwen/Qwen3.8-27B', name: 'Qwen 3.8 27B', supportsImage: true, contextWindow: 262_144 },
        { id: 'Qwen/Qwen3.8-Flash', name: 'Qwen 3.8 Flash', supportsImage: false, contextWindow: 1_000_000 },
        { id: 'Qwen/Qwen3.7-Max', name: 'Qwen 3.7 Max', supportsImage: false, contextWindow: 1_000_000 },
        { id: 'Qwen/Qwen3.7-Plus', name: 'Qwen 3.7 Plus', supportsImage: false, contextWindow: 1_000_000 },
        { id: 'Qwen/Qwen3.7-Flash', name: 'Qwen 3.7 Flash', supportsImage: false, contextWindow: 1_000_000 },
        { id: 'Qwen/Qwen3.6-Max-Preview', name: 'Qwen 3.6 Max Preview', supportsImage: false, contextWindow: 200_000 },
        { id: 'Qwen/Qwen3.6-Plus', name: 'Qwen 3.6 Plus', supportsImage: true, contextWindow: 200_000 },
        { id: 'stepfun/Step-3.7-Flash', name: 'Step 3.7 Flash', supportsImage: true, contextWindow: 256_000 },
        { id: 'stepfun/Step-3.5-Flash', name: 'Step 3.5 Flash', supportsImage: false, contextWindow: 1_000_000 },
        { id: 'tencent/hy3-paid', name: 'Tencent Hy3', supportsImage: false, contextWindow: 262_144 },
        { id: 'google/gemini-3.7-flash', name: 'Gemini 3.7 Flash', supportsImage: true, contextWindow: 1_048_576 },
        { id: 'google/gemini-3.6-flash', name: 'Gemini 3.6 Flash', supportsImage: true, contextWindow: 1_000_000 },
        { id: 'google/gemini-3.5-flash', name: 'Gemini 3.5 Flash', supportsImage: true, contextWindow: 1_000_000 },
        { id: 'google/gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', supportsImage: true, contextWindow: 1_000_000 },
        { id: 'google/gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', supportsImage: true, contextWindow: 1_000_000 },
        { id: 'sakana/fugu-ultra', name: 'Fugu Ultra', supportsImage: false, contextWindow: 1_000_000 },
        { id: 'nvidia/nemotron-3-ultra-550b-a55b', name: 'Nemotron 3 Ultra', supportsImage: false, contextWindow: 1_000_000 },
        { id: 'thinkingmachines/inkling', name: 'Inkling', supportsImage: true, contextWindow: 256_000 },
        { id: 'thinkingmachines/inkling-small', name: 'Inkling Small', supportsImage: true, contextWindow: 1_000_000 },
        { id: 'poolside/laguna-s-2.1-free', name: 'Laguna S 2.1 (Free)', supportsImage: false, contextWindow: 256_000 },
        { id: 'meta/muse-spark-1.1', name: 'Muse Spark 1.1', supportsImage: false, contextWindow: 1_048_576 },
        { id: 'meta/muse-spark-1.2', name: 'Muse Spark 1.2', supportsImage: false, contextWindow: 1_048_576 },
        { id: 'meta/muse-spark-1.2-contributor', name: 'Muse Spark 1.2 Contributor', supportsImage: false, contextWindow: 1_048_576 },
        { id: 'xai/grok-4.5', name: 'Grok 4.5', supportsImage: true, contextWindow: 500_000 },
        { id: 'xai/grok-4.6', name: 'Grok 4.6', supportsImage: true, contextWindow: 500_000 }
      ]
    },
    openai: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.openai.com',
      apiFormat: 'openai',
      models: [
        { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', supportsImage: true, contextWindow: 1_050_000 },
        { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', supportsImage: true, contextWindow: 1_050_000 },
        { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', supportsImage: true, contextWindow: 1_050_000 },
        { id: 'gpt-5.5', name: 'GPT-5.5', supportsImage: true, contextWindow: 1_050_000 },
        { id: 'gpt-5.4', name: 'GPT-5.4', supportsImage: true, contextWindow: 1_050_000 }
      ]
    },
    gemini: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiFormat: 'openai',
      models: [
        { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', supportsImage: true, contextWindow: 2_000_000 },
        { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash', supportsImage: true, contextWindow: 2_000_000 },
        { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', supportsImage: true, contextWindow: 2_000_000 }
      ]
    },
    anthropic: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.anthropic.com',
      apiFormat: 'anthropic',
      models: [
        { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', supportsImage: true, contextWindow: 1_048_576 },
        { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', supportsImage: true, contextWindow: 1_048_576 },
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', supportsImage: true, contextWindow: 1_048_576 }
      ]
    },
    moonshot: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.moonshot.cn/anthropic',
      apiFormat: 'anthropic',
      models: [
        { id: 'kimi-k2.6', name: 'Kimi K2.6', supportsImage: true, contextWindow: 262_144 },
        { id: 'kimi-k2.5', name: 'Kimi K2.5', supportsImage: true, contextWindow: 262_144 }
      ]
    },
    zhipu: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      apiFormat: 'anthropic',
      models: [
        { id: 'glm-5.1', name: 'GLM 5.1', supportsImage: false, contextWindow: 202_800 },
        { id: 'glm-5', name: 'GLM 5', supportsImage: false, contextWindow: 202_800 },
        { id: 'glm-4.7', name: 'GLM 4.7', supportsImage: false, contextWindow: 204_800 }
      ]
    },
    minimax: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      apiFormat: 'anthropic',
      models: [
        { id: 'MiniMax-M3', name: 'MiniMax M3', supportsImage: true, contextWindow: 1_000_000 },
        { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', supportsImage: false, contextWindow: 204_800 },
        { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', supportsImage: false, contextWindow: 204_800 }
      ]
    },
    qwen: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
      apiFormat: 'anthropic',
      models: [
        { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus', supportsImage: true, contextWindow: 1_000_000 },
        { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', supportsImage: true, contextWindow: 1_000_000 }
      ]
    },
    xiaomi: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.xiaomimimo.com/anthropic',
      apiFormat: 'anthropic',
      models: [
        { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro', supportsImage: false, contextWindow: 1_000_000 },
        { id: 'mimo-v2.5', name: 'MiMo V2.5', supportsImage: true, contextWindow: 1_000_000 }
      ]
    },
    // 火山引擎方舟（Ark）：OpenAI 兼容端点 /api/v3；apiKey 同时作为内置
    // seedance/seedream 技能的 ARK_API_KEY 自动注入（skillImageProviderEnv.ts）。
    volcengine: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiFormat: 'openai',
      models: [
        { id: 'doubao-seed-1-6-250615', name: 'Doubao Seed 1.6', supportsImage: false, contextWindow: 256_000 },
        { id: 'doubao-seed-1-6-flash-250717', name: 'Doubao Seed 1.6 Flash', supportsImage: false, contextWindow: 256_000 }
      ]
    },
    openrouter: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://openrouter.ai/api',
      apiFormat: 'anthropic',
      models: [
        { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', supportsImage: true, contextWindow: 1_048_576 },
        { id: 'anthropic/claude-opus-4.7', name: 'Claude Opus 4.7', supportsImage: true, contextWindow: 1_048_576 },
        { id: 'openai/gpt-5.5', name: 'GPT 5.5', supportsImage: true, contextWindow: 1_050_000 },
        { id: 'google/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', supportsImage: true, contextWindow: 2_000_000 }
      ]
    },
    ollama: {
      enabled: false,
      apiKey: '',
      baseUrl: 'http://localhost:11434',
      apiFormat: 'anthropic',
      models: [
        { id: 'qwen3-coder-next', name: 'Qwen3-Coder-Next', supportsImage: false, contextWindow: 1_000_000 },
        { id: 'glm-4.7-flash', name: 'GLM 4.7 Flash', supportsImage: false, contextWindow: 204_800 }
      ]
    }
  },
  theme: 'system',
  language: 'zh',
  app: {
    port: 3000,
    isDevelopment: process.env.NODE_ENV === 'development',
  },
  shortcuts: {
    newChat: 'Ctrl+N',
    search: 'Ctrl+F',
    settings: 'Ctrl+,',
  },
  feeRates: {
    btc: 2,
    mvc: 1,
    doge: 7500000,
  },
};

// 配置存储键
export const CONFIG_KEYS = {
  APP_CONFIG: 'app_config',
  AUTH: 'auth_state',
  CONVERSATIONS: 'conversations',
  PROVIDERS_EXPORT_KEY: 'providers_export_key',
  SKILLS: 'skills',
};

// Model provider classification (kept for compatibility)
export const CHINA_PROVIDERS = ['deepseek', 'moonshot', 'qwen', 'zhipu', 'minimax', 'xiaomi', 'ollama'] as const;
export const GLOBAL_PROVIDERS = ['openai', 'gemini', 'anthropic', 'openrouter'] as const;
export const EN_PRIORITY_PROVIDERS = ['openai', 'anthropic', 'gemini'] as const;

/** All supported LLM provider keys for the Model settings page. No language filtering. */
export const ALL_PROVIDER_KEYS = [
  'metaid-free', 'deepseek', 'opencode', 'commandcode', 'openai', 'gemini', 'anthropic', 'moonshot', 'zhipu', 'minimax', 'qwen', 'xiaomi', 'openrouter', 'ollama',
] as const;

/**
 * Returns all supported LLM provider keys for the Model settings page.
 * No language-based filtering; all providers are shown uniformly.
 */
export const getVisibleProviders = (_language: 'zh' | 'en'): readonly string[] => {
  return ALL_PROVIDER_KEYS;
};
