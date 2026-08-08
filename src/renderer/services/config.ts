import { AppConfig, CONFIG_KEYS, defaultConfig, normalizeDeepSeekAppConfig } from '../config';
import { localStore } from './store';

const getFixedProviderApiFormat = (providerKey: string): 'anthropic' | 'openai' | null => {
  if (providerKey === 'openai' || providerKey === 'gemini') {
    return 'openai';
  }
  if (providerKey === 'anthropic') {
    return 'anthropic';
  }
  return null;
};

const normalizeProviderBaseUrl = (providerKey: string, baseUrl: unknown): string => {
  if (typeof baseUrl !== 'string') {
    return '';
  }

  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (providerKey !== 'gemini') {
    return normalized;
  }

  if (!normalized || !normalized.includes('generativelanguage.googleapis.com')) {
    return normalized;
  }

  if (normalized.endsWith('/v1beta/openai') || normalized.endsWith('/v1/openai')) {
    return normalized;
  }
  if (normalized.endsWith('/v1beta')) {
    return `${normalized}/openai`;
  }
  if (normalized.endsWith('/v1')) {
    return `${normalized.slice(0, -3)}v1beta/openai`;
  }

  return 'https://generativelanguage.googleapis.com/v1beta/openai';
};

const normalizeProviderApiFormat = (providerKey: string, apiFormat: unknown): 'anthropic' | 'openai' | 'responses' => {
  const fixed = getFixedProviderApiFormat(providerKey);
  if (fixed) {
    return fixed;
  }
  if (apiFormat === 'responses') {
    return 'responses';
  }
  if (apiFormat === 'openai') {
    return 'openai';
  }
  return 'anthropic';
};

const cloneProviderModels = (
  models: NonNullable<NonNullable<AppConfig['providers']>[string]['models']> | undefined,
) => models?.map((model) => ({
  ...model,
  supportsImage: model.supportsImage ?? false,
  options: model.options
    ? {
        ...model.options,
        thinking: model.options.thinking ? { ...model.options.thinking } : undefined,
      }
    : undefined,
}));

const buildProviderSignature = (
  models: NonNullable<NonNullable<AppConfig['providers']>[string]['models']> | undefined,
): string => JSON.stringify(
  (models ?? []).map((model) => ({
    id: model.id,
    name: model.name,
    supportsImage: model.supportsImage ?? false,
    options: model.options
      ? {
          reasoningEffort: model.options.reasoningEffort,
          thinking: model.options.thinking ? { ...model.options.thinking } : undefined,
        }
      : undefined,
  })),
);

const normalizeSingleProviderConfig = (
  providerKey: string,
  providerConfig: NonNullable<AppConfig['providers']>[string],
): NonNullable<AppConfig['providers']>[string] => ({
  ...providerConfig,
  baseUrl: normalizeProviderBaseUrl(providerKey, providerConfig.baseUrl),
  apiFormat: normalizeProviderApiFormat(providerKey, providerConfig.apiFormat),
  models: cloneProviderModels(providerConfig.models),
});

const getDefaultProvidersConfig = (): NonNullable<AppConfig['providers']> => (
  Object.fromEntries(
    Object.entries(defaultConfig.providers ?? {}).map(([providerKey, providerConfig]) => [
      providerKey,
      normalizeSingleProviderConfig(providerKey, providerConfig),
    ]),
  ) as NonNullable<AppConfig['providers']>
);

const shouldPreserveExistingProviderConfig = (
  providerKey: string,
  currentProvider: NonNullable<AppConfig['providers']>[string] | undefined,
  incomingProvider: NonNullable<AppConfig['providers']>[string] | undefined,
): boolean => {
  if (!currentProvider || !incomingProvider) {
    return false;
  }

  if (!String(currentProvider.apiKey ?? '').trim() || String(incomingProvider.apiKey ?? '').trim()) {
    return false;
  }

  const defaultProvider = getDefaultProvidersConfig()[providerKey];
  if (!defaultProvider) {
    return false;
  }

  return incomingProvider.enabled === defaultProvider.enabled
    && incomingProvider.baseUrl === defaultProvider.baseUrl
    && incomingProvider.apiFormat === defaultProvider.apiFormat
    && buildProviderSignature(incomingProvider.models) === buildProviderSignature(defaultProvider.models);
};

export const mergeProvidersConfig = (
  currentProviders?: AppConfig['providers'],
  incomingProviders?: AppConfig['providers'],
): AppConfig['providers'] => {
  const defaultProviders = getDefaultProvidersConfig();
  const keys = new Set([
    ...Object.keys(defaultProviders),
    ...Object.keys(currentProviders ?? {}),
    ...Object.keys(incomingProviders ?? {}),
  ]);

  return Object.fromEntries(
    Array.from(keys).map((providerKey) => {
      const defaultProvider = defaultProviders[providerKey];
      const currentProvider = currentProviders?.[providerKey]
        ? normalizeSingleProviderConfig(providerKey, currentProviders[providerKey])
        : defaultProvider;
      const incomingProvider = incomingProviders?.[providerKey]
        ? normalizeSingleProviderConfig(providerKey, {
            ...defaultProvider,
            ...incomingProviders[providerKey],
          })
        : undefined;

      if (shouldPreserveExistingProviderConfig(providerKey, currentProvider, incomingProvider)) {
        return [
          providerKey,
          {
            ...currentProvider,
            models: currentProvider?.models ?? incomingProvider?.models,
          },
        ];
      }

      return [
        providerKey,
        incomingProvider
          ? {
              ...currentProvider,
              ...incomingProvider,
              models: incomingProvider.models ?? currentProvider?.models,
            }
          : currentProvider,
      ];
    }),
  ) as AppConfig['providers'];
};

// ---------------------------------------------------------------------------
// 版本化 Provider 预设模型迁移
//
// 背景：stored config 的 providers.models 优先于 defaultConfig，直接改默认值
// 不会让老用户拿到新模型。这里参照 LobsterAI 的做法做版本化迁移：
// - removed：只移除"我们曾作为预设下发、现已淘汰"的模型 ID，用户自定义模型不受影响
// - added：只注入用户列表中尚不存在的新预设模型（置前，保持旗舰模型在首位）
// - defaultModelRemap：用户当前默认模型若被淘汰，则映射到对应的新模型
// 重要：deepseek 不参与迁移，已配置 DeepSeek 的老用户升级后保持完全不变。
// ---------------------------------------------------------------------------

export const PROVIDER_MODEL_MIGRATION_VERSION = 1;

type ProviderModelEntry = NonNullable<NonNullable<AppConfig['providers']>[string]['models']>[number];

type ProviderModelMigration = {
  removed: Record<string, string[]>;
  added: Record<string, ProviderModelEntry[]>;
  defaultModelRemap: Record<string, string>;
};

const PROVIDER_MODEL_MIGRATIONS: Record<number, ProviderModelMigration> = {
  // v1：向 LobsterAI 最新模型列表对齐（2026-07）
  1: {
    removed: {
      openai: ['gpt-5.2-2025-12-11', 'gpt-5.2-codex'],
      gemini: ['gemini-3-pro-preview'],
      anthropic: ['claude-sonnet-4-5-20250929'],
      minimax: ['MiniMax-M2.1'],
      qwen: ['qwen3-coder-plus'],
      xiaomi: ['mimo-v2-flash'],
      openrouter: [
        'anthropic/claude-sonnet-4.5',
        'anthropic/claude-opus-4.6',
        'openai/gpt-5.2-codex',
        'google/gemini-3-pro-preview',
      ],
    },
    added: {
      openai: [
        { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', supportsImage: true, contextWindow: 1_050_000 },
        { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', supportsImage: true, contextWindow: 1_050_000 },
        { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', supportsImage: true, contextWindow: 1_050_000 },
        { id: 'gpt-5.5', name: 'GPT-5.5', supportsImage: true, contextWindow: 1_050_000 },
        { id: 'gpt-5.4', name: 'GPT-5.4', supportsImage: true, contextWindow: 1_050_000 },
      ],
      gemini: [
        { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', supportsImage: true, contextWindow: 2_000_000 },
      ],
      anthropic: [
        { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', supportsImage: true, contextWindow: 1_048_576 },
      ],
      moonshot: [
        { id: 'kimi-k2.6', name: 'Kimi K2.6', supportsImage: true, contextWindow: 262_144 },
      ],
      zhipu: [
        { id: 'glm-5.1', name: 'GLM 5.1', supportsImage: false, contextWindow: 202_800 },
      ],
      minimax: [
        { id: 'MiniMax-M3', name: 'MiniMax M3', supportsImage: true, contextWindow: 1_000_000 },
        { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', supportsImage: false, contextWindow: 204_800 },
      ],
      qwen: [
        { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus', supportsImage: true, contextWindow: 1_000_000 },
      ],
      xiaomi: [
        { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro', supportsImage: false, contextWindow: 1_000_000 },
        { id: 'mimo-v2.5', name: 'MiMo V2.5', supportsImage: true, contextWindow: 1_000_000 },
      ],
      openrouter: [
        { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', supportsImage: true, contextWindow: 1_048_576 },
        { id: 'anthropic/claude-opus-4.7', name: 'Claude Opus 4.7', supportsImage: true, contextWindow: 1_048_576 },
        { id: 'openai/gpt-5.5', name: 'GPT 5.5', supportsImage: true, contextWindow: 1_050_000 },
        { id: 'google/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', supportsImage: true, contextWindow: 2_000_000 },
      ],
    },
    defaultModelRemap: {
      'gpt-5.2-2025-12-11': 'gpt-5.6-sol',
      'gpt-5.2-codex': 'gpt-5.6-sol',
      'gemini-3-pro-preview': 'gemini-3.1-pro-preview',
      'claude-sonnet-4-5-20250929': 'claude-sonnet-4-6',
      'MiniMax-M2.1': 'MiniMax-M2.5',
      'qwen3-coder-plus': 'qwen3.5-plus',
      'mimo-v2-flash': 'mimo-v2.5',
      'anthropic/claude-sonnet-4.5': 'anthropic/claude-sonnet-4.6',
      'anthropic/claude-opus-4.6': 'anthropic/claude-opus-4.7',
      'openai/gpt-5.2-codex': 'openai/gpt-5.5',
      'google/gemini-3-pro-preview': 'google/gemini-3.1-pro-preview',
    },
  },
};

export const applyProviderModelMigrations = (config: AppConfig): AppConfig => {
  const currentVersion = config.providerModelMigrationVersion ?? 0;
  if (currentVersion >= PROVIDER_MODEL_MIGRATION_VERSION) {
    return config;
  }

  let nextProviders = config.providers;
  let nextDefaultModel = config.model.defaultModel;

  for (let version = currentVersion + 1; version <= PROVIDER_MODEL_MIGRATION_VERSION; version += 1) {
    const migration = PROVIDER_MODEL_MIGRATIONS[version];
    if (!migration) {
      continue;
    }

    const providers = { ...(nextProviders ?? {}) } as NonNullable<AppConfig['providers']>;
    for (const [providerKey, providerConfig] of Object.entries(providers)) {
      if (providerKey === 'deepseek') {
        continue;
      }
      const removedIds = new Set(migration.removed[providerKey] ?? []);
      const addedModels = migration.added[providerKey] ?? [];
      if (removedIds.size === 0 && addedModels.length === 0) {
        continue;
      }
      const existingModels = providerConfig.models ?? [];
      const keptModels = existingModels.filter((model) => !removedIds.has(model.id));
      const keptIds = new Set(keptModels.map((model) => model.id));
      const modelsToAdd = addedModels.filter((model) => !keptIds.has(model.id));
      if (keptModels.length === existingModels.length && modelsToAdd.length === 0) {
        continue;
      }
      providers[providerKey] = {
        ...providerConfig,
        models: [...modelsToAdd, ...keptModels],
      };
    }
    nextProviders = providers;

    const remappedDefault = migration.defaultModelRemap[nextDefaultModel];
    if (remappedDefault) {
      nextDefaultModel = remappedDefault;
    }
  }

  return {
    ...config,
    model: {
      ...config.model,
      defaultModel: nextDefaultModel,
    },
    providers: nextProviders,
    providerModelMigrationVersion: PROVIDER_MODEL_MIGRATION_VERSION,
  };
};

// ---------------------------------------------------------------------------
// 版本化 Provider API 格式语义迁移
//
// 背景：当出厂默认 apiFormat 的含义/取值发生变化时（例如 opencode 从 chat
// completions 切换到 Responses），stored config 会用旧默认值覆盖 defaultConfig，
// 导致老用户拿不到新默认。这里做幂等的版本化迁移，只纠正仍处于出厂默认状态
// （apiKey 为空）的 provider，已自定义配置（填了 key 或改过格式）的用户保持不动。
// ---------------------------------------------------------------------------

export const PROVIDER_API_FORMAT_MIGRATION_VERSION = 1;

type ProviderApiFormatValue = 'anthropic' | 'openai' | 'responses';

/**
 * v1：opencode 默认 apiFormat 由 'openai'（chat completions）升级为 'responses'。
 *
 * OpenCode Go 网关三个端点共用同一 Base URL，DeepSeek Flash 在 Responses 格式下
 * 可携带 reasoning，故 Responses 成为更合适的默认。对所有仍停留在旧默认 'openai'
 * 的 opencode 用户（含已配置 apiKey 正在使用的）一律升级；用户若手动选过 'responses'
 * 或 'anthropic'，则尊重其选择保持不变。
 */
const migrateOpencodeApiFormatToResponses = (
  providers: NonNullable<AppConfig['providers']>,
): NonNullable<AppConfig['providers']> => {
  const opencode = providers.opencode;
  if (!opencode) {
    return providers;
  }
  // Only migrate providers still on the legacy 'openai' (chat completions) default.
  // A user who explicitly picked 'responses' or 'anthropic' is left untouched.
  if ((opencode.apiFormat as ProviderApiFormatValue | undefined) !== 'openai') {
    return providers;
  }
  return {
    ...providers,
    opencode: { ...opencode, apiFormat: 'responses' },
  };
};

export const applyProviderApiFormatMigrations = (config: AppConfig): AppConfig => {
  const currentVersion = config.providerApiFormatMigrationVersion ?? 0;
  if (currentVersion >= PROVIDER_API_FORMAT_MIGRATION_VERSION) {
    return config;
  }

  let nextProviders = config.providers;

  for (let version = currentVersion + 1; version <= PROVIDER_API_FORMAT_MIGRATION_VERSION; version += 1) {
    if (version === 1) {
      nextProviders = nextProviders
        ? migrateOpencodeApiFormatToResponses(nextProviders as NonNullable<AppConfig['providers']>)
        : nextProviders;
    }
  }

  return {
    ...config,
    providers: nextProviders,
    providerApiFormatMigrationVersion: PROVIDER_API_FORMAT_MIGRATION_VERSION,
  };
};

class ConfigService {
  private config: AppConfig = defaultConfig;

  async init() {
    try {
      const storedConfig = await localStore.getItem<AppConfig>(CONFIG_KEYS.APP_CONFIG);
      if (storedConfig) {
        const mergedProviders = mergeProvidersConfig(undefined, storedConfig.providers);

        const mergedConfig: AppConfig = {
          ...defaultConfig,
          ...storedConfig,
          api: {
            ...defaultConfig.api,
            ...storedConfig.api,
          },
          model: {
            ...defaultConfig.model,
            ...storedConfig.model,
          },
          app: {
            ...defaultConfig.app,
            ...storedConfig.app,
          },
          shortcuts: {
            ...defaultConfig.shortcuts!,
            ...(storedConfig.shortcuts ?? {}),
          } as AppConfig['shortcuts'],
          providers: mergedProviders as AppConfig['providers'],
        };

        const normalizedConfig = normalizeDeepSeekAppConfig(
          applyProviderModelMigrations(applyProviderApiFormatMigrations(mergedConfig)),
        );
        this.config = normalizedConfig;

        if (JSON.stringify(normalizedConfig) !== JSON.stringify(mergedConfig)) {
          await localStore.setItem(CONFIG_KEYS.APP_CONFIG, normalizedConfig);
        }
      }
    } catch (error) {
      console.error('Failed to load config:', error);
    }
  }

  getConfig(): AppConfig {
    return this.config;
  }

  async updateConfig(newConfig: Partial<AppConfig>) {
    const normalizedProviders = newConfig.providers
      ? mergeProvidersConfig(this.config.providers, newConfig.providers as AppConfig['providers'])
      : undefined;
    this.config = normalizeDeepSeekAppConfig({
      ...this.config,
      ...newConfig,
      ...(normalizedProviders ? { providers: normalizedProviders } : {}),
    });
    await localStore.setItem(CONFIG_KEYS.APP_CONFIG, this.config);
  }

  getApiConfig() {
    return {
      apiKey: this.config.api.key,
      baseUrl: this.config.api.baseUrl,
    };
  }
}

export const configService = new ConfigService(); 
