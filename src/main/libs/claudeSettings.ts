import { join } from 'path';
import { existsSync } from 'fs';
import { app } from 'electron';
import type { SqliteStore } from '../sqliteStore';
import type { CoworkPermissionMode } from '../coworkStore';
import type { CoworkApiConfig } from './coworkConfigStore';
import {
  configureCoworkOpenAICompatProxy,
  type OpenAICompatProxyTarget,
  getCoworkOpenAICompatProxyBaseURL,
  getCoworkOpenAICompatProxyStatus,
} from './coworkOpenAICompatProxy';
import { normalizeProviderApiFormat, type AnthropicApiFormat } from './coworkFormatTransform';
import { resolveCoworkModelLimits, type CoworkModelLimits } from './coworkModelLimits';

type ProviderModel = {
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /**
   * Per-model options mirroring the renderer's ModelOptions. Present in the
   * app_config blob but previously stripped by this typed reader, so the cowork
   * SDK path never saw effort/thinking settings.
   */
  options?: {
    reasoningEffort?: string;
    thinking?: { type: string };
  };
};

type ProviderConfig = {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  apiFormat?: 'anthropic' | 'openai' | 'native';
  models?: ProviderModel[];
};

type AppConfig = {
  model?: {
    defaultModel?: string;
    /** Optional SDK fallback model id for automatic model refusal fallback. */
    fallbackModel?: string;
    availableModels?: ProviderModel[];
  };
  providers?: Record<string, ProviderConfig>;
};

export type ApiConfigResolution = {
  config: CoworkApiConfig | null;
  error?: string;
};

// Store getter function injected from main.ts
let storeGetter: (() => SqliteStore | null) | null = null;

export function setStoreGetter(getter: () => SqliteStore | null): void {
  storeGetter = getter;
}

const getStore = (): SqliteStore | null => {
  if (!storeGetter) {
    return null;
  }
  return storeGetter();
};

export function getClaudeCodePath(): string {
  const candidates = resolveClaudeCodeBinaryCandidates();
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  // Fall back to the first candidate so callers still get a deterministic path
  // even before the platform package is installed.
  return candidates[0];
}

/**
 * The 0.3.x Claude Agent SDK no longer ships a Node `cli.js`. It resolves a
 * compiled native binary from a platform-specific optional dependency such as
 * `@anthropic-ai/claude-agent-sdk-darwin-arm64`. We build the same candidate
 * list the SDK uses internally and anchor it to our node_modules root so the
 * packaged app (asar.unpacked) and dev checkouts both resolve.
 */
function resolveClaudeCodeBinaryCandidates(): string[] {
  const nodeModulesRoot = app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
    : // In development, try to find node_modules in the project root.
      // app.getAppPath() might point to dist-electron or other build output directories.
      join(resolveProjectRootDir(), 'node_modules');

  const platform = process.platform;
  const arch = process.arch;
  const binaryName = platform === 'win32' ? 'claude.exe' : 'claude';
  const scope = '@anthropic-ai';

  const packageNames: string[] = [];
  if (platform === 'linux') {
    // Prefer the musl build when the current process reports no glibc, matching SDK behavior.
    if (isMuslRuntime()) {
      packageNames.push(`claude-agent-sdk-linux-${arch}-musl`);
      packageNames.push(`claude-agent-sdk-linux-${arch}`);
    } else {
      packageNames.push(`claude-agent-sdk-linux-${arch}`);
      packageNames.push(`claude-agent-sdk-linux-${arch}-musl`);
    }
  } else {
    packageNames.push(`claude-agent-sdk-${platform}-${arch}`);
  }

  return packageNames.map((name) => join(nodeModulesRoot, scope, name, binaryName));
}

function resolveProjectRootDir(): string {
  const appPath = app.getAppPath();
  return appPath.endsWith('dist-electron') ? join(appPath, '..') : appPath;
}

function isMuslRuntime(): boolean {
  try {
    const report = (process as unknown as { report?: { getReport?: () => { header?: { glibcVersionRuntime?: string } } } }).report;
    const header = report?.getReport?.()?.header;
    return header !== undefined && header.glibcVersionRuntime === undefined;
  } catch {
    return false;
  }
}

type MatchedProvider = {
  providerName: string;
  providerConfig: ProviderConfig;
  modelId: string;
  apiFormat: AnthropicApiFormat;
};

function getEffectiveProviderApiFormat(providerName: string, apiFormat: unknown): AnthropicApiFormat {
  if (providerName === 'openai' || providerName === 'gemini') {
    return 'openai';
  }
  if (providerName === 'anthropic') {
    return 'anthropic';
  }
  return normalizeProviderApiFormat(apiFormat);
}

function providerRequiresApiKey(providerName: string): boolean {
  return providerName !== 'ollama';
}

const DEEPSEEK_PROVIDER_KEY = 'deepseek';
const DEEPSEEK_AUTOMATION_MODEL_ID = 'deepseek-v4-flash';

export function resolveAutomationModelOverride(modelId?: string | null): string | null {
  const normalized = modelId?.trim();
  if (!normalized) return null;
  if (normalized.toLowerCase() === DEEPSEEK_PROVIDER_KEY) {
    return DEEPSEEK_AUTOMATION_MODEL_ID;
  }
  return normalized;
}

/**
 * Resolve which provider and model to use. When overrideModelId is provided (e.g. MetaBot's llm_id),
 * find the enabled provider that offers that model; otherwise use app default or first available.
 */
function resolveMatchedProvider(
  appConfig: AppConfig,
  overrideModelId?: string | null
): { matched: MatchedProvider | null; error?: string } {
  const providers = appConfig.providers ?? {};
  const requestedOverride = overrideModelId?.trim() || null;
  const isDeepSeekAutomationProviderKey = requestedOverride?.toLowerCase() === DEEPSEEK_PROVIDER_KEY;

  const resolveFallbackModel = (): string | undefined => {
    for (const provider of Object.values(providers)) {
      if (!provider?.enabled || !provider.models || provider.models.length === 0) {
        continue;
      }
      return provider.models[0].id;
    }
    return undefined;
  };

  const modelId =
    resolveAutomationModelOverride(requestedOverride) || appConfig.model?.defaultModel || resolveFallbackModel();
  if (!modelId) {
    return { matched: null, error: 'No available model configured in enabled providers.' };
  }

  let providerEntry: [string, ProviderConfig] | undefined = Object.entries(providers).find(
    ([, provider]) => {
      if (!provider?.enabled || !provider.models) return false;
      return provider.models.some((model) => model.id === modelId);
    }
  ) as [string, ProviderConfig] | undefined;

  let resolvedModelId: string = modelId;

  // When overrideModelId is given (e.g. MetaBot llm_id "deepseek"), exact model id may not match.
  // Fallback 1: treat as provider key (e.g. "deepseek" -> provider "deepseek", use its first or default model).
  if (!providerEntry && requestedOverride && !isDeepSeekAutomationProviderKey) {
    const key = requestedOverride.toLowerCase();
    const byProviderKey = Object.entries(providers).find(
      ([name, provider]) =>
        name.toLowerCase() === key && provider?.enabled && provider?.models?.length
    ) as [string, ProviderConfig] | undefined;
    if (byProviderKey) {
      const [providerName, providerConfig] = byProviderKey;
      const defaultInApp = appConfig.model?.defaultModel;
      const useModel =
        providerConfig.models?.some((m) => m.id === defaultInApp)
          ? defaultInApp
          : providerConfig.models?.[0]?.id;
      if (useModel) {
        providerEntry = [providerName, providerConfig];
        resolvedModelId = useModel;
      }
    }
  }

  // Fallback 2: match by model id prefix (e.g. "deepseek" -> "deepseek-chat").
  if (!providerEntry && requestedOverride && !isDeepSeekAutomationProviderKey) {
    const prefix = requestedOverride.toLowerCase();
    for (const [providerName, provider] of Object.entries(providers)) {
      if (!provider?.enabled || !provider.models) continue;
      const firstMatch = provider.models.find((m) => m.id.toLowerCase().startsWith(prefix));
      if (firstMatch) {
        providerEntry = [providerName, provider];
        resolvedModelId = firstMatch.id;
        break;
      }
    }
  }

  if (!providerEntry) {
    return { matched: null, error: `No enabled provider found for model: ${modelId}` };
  }

  const [providerName, providerConfig] = providerEntry;
  const apiFormat = getEffectiveProviderApiFormat(providerName, providerConfig.apiFormat);
  const baseURL = providerConfig.baseUrl?.trim();

  if (!baseURL) {
    return { matched: null, error: `Provider ${providerName} is missing base URL.` };
  }

  if (apiFormat === 'anthropic' && providerRequiresApiKey(providerName) && !providerConfig.apiKey?.trim()) {
    return { matched: null, error: `Provider ${providerName} requires API key for Anthropic-compatible mode.` };
  }

  return {
    matched: {
      providerName,
      providerConfig,
      modelId: resolvedModelId,
      apiFormat,
    },
  };
}

/**
 * Resolves the fallback model id from app config. The SDK's `fallbackModel`
 * option is only meaningful when the fallback model is served by the same
 * provider as the primary (same base URL / API key), because the SDK retries
 * in-process without re-resolving provider env. So we validate that the
 * configured fallbackModel exists in an enabled provider's model list.
 * Returns undefined when no usable fallback is configured.
 */
function resolveFallbackModelId(
  appConfig: AppConfig,
  primaryProviderName: string | null
): string | undefined {
  const fallbackId = appConfig.model?.fallbackModel?.trim();
  if (!fallbackId) return undefined;

  const providers = appConfig.providers ?? {};
  for (const [providerName, provider] of Object.entries(providers)) {
    if (!provider?.enabled || !provider.models) continue;
    if (provider.models.some((m) => m.id === fallbackId)) {
      // Only use fallback from the same provider — the SDK retries with the
      // same base URL/key, so a cross-provider fallback would hit the wrong API.
      if (primaryProviderName && providerName !== primaryProviderName) continue;
      return fallbackId;
    }
  }
  return undefined;
}

/**
 * Resolve API config for a given model id (e.g. MetaBot's llm_id). When modelId is provided and
 * non-empty, finds the enabled provider that offers that model; otherwise uses app default.
 * Use this for per-MetaBot LLM (orchestrator chat completion).
 */
export function resolveApiConfigForModel(
  modelId?: string | null,
  target: OpenAICompatProxyTarget = 'local'
): ApiConfigResolution {
  const sqliteStore = getStore();
  if (!sqliteStore) {
    return { config: null, error: 'Store is not initialized.' };
  }
  const appConfig = sqliteStore.get<AppConfig>('app_config');
  if (!appConfig) {
    return { config: null, error: 'Application config not found.' };
  }
  const { matched, error } = resolveMatchedProvider(appConfig, modelId ?? undefined);
  if (!matched) {
    return { config: null, error };
  }
  const resolution = buildApiConfigFromMatched(matched, target);
  if (resolution.config) {
    const fallbackModel = resolveFallbackModelId(appConfig, matched.providerName);
    if (fallbackModel) {
      resolution.config.fallbackModel = fallbackModel;
    }
  }
  return resolution;
}

function buildApiConfigFromMatched(
  matched: MatchedProvider,
  target: OpenAICompatProxyTarget
): ApiConfigResolution {
  const resolvedBaseURL = matched.providerConfig.baseUrl.trim();
  const resolvedApiKey = matched.providerConfig.apiKey?.trim() || '';
  const effectiveApiKey =
    matched.providerName === 'ollama' && matched.apiFormat === 'anthropic' && !resolvedApiKey
      ? 'sk-ollama-local'
      : resolvedApiKey;

  if (matched.apiFormat === 'anthropic') {
    return {
      config: {
        apiKey: effectiveApiKey,
        baseURL: resolvedBaseURL,
        model: matched.modelId,
        apiType: 'anthropic',
        provider: matched.providerName,
        upstreamBaseURL: resolvedBaseURL,
      },
    };
  }

  const proxyStatus = getCoworkOpenAICompatProxyStatus();
  if (!proxyStatus.running) {
    return { config: null, error: 'OpenAI compatibility proxy is not running.' };
  }

  configureCoworkOpenAICompatProxy({
    baseURL: resolvedBaseURL,
    apiKey: resolvedApiKey || undefined,
    model: matched.modelId,
    provider: matched.providerName,
  });

  const proxyBaseURL = getCoworkOpenAICompatProxyBaseURL(target);
  if (!proxyBaseURL) {
    return { config: null, error: 'OpenAI compatibility proxy base URL is unavailable.' };
  }

  return {
    config: {
      apiKey: resolvedApiKey || 'idbots-openai-compat',
      baseURL: proxyBaseURL,
      model: matched.modelId,
      apiType: 'anthropic', // proxy speaks Anthropic /v1/messages format
      provider: matched.providerName,
      upstreamBaseURL: resolvedBaseURL,
    },
  };
}

export function resolveCurrentApiConfig(target: OpenAICompatProxyTarget = 'local'): ApiConfigResolution {
  const sqliteStore = getStore();
  if (!sqliteStore) {
    return {
      config: null,
      error: 'Store is not initialized.',
    };
  }

  const appConfig = sqliteStore.get<AppConfig>('app_config');
  if (!appConfig) {
    return {
      config: null,
      error: 'Application config not found.',
    };
  }

  const { matched, error } = resolveMatchedProvider(appConfig);
  if (!matched) {
    return {
      config: null,
      error,
    };
  }

  const resolution = buildApiConfigFromMatched(matched, target);
  if (resolution.config) {
    const fallbackModel = resolveFallbackModelId(appConfig, matched.providerName);
    if (fallbackModel) {
      resolution.config.fallbackModel = fallbackModel;
    }
  }
  return resolution;
}

export function getCurrentApiConfig(target: OpenAICompatProxyTarget = 'local'): CoworkApiConfig | null {
  return resolveCurrentApiConfig(target).config;
}

/**
 * Returns the persisted auto-approve tool rules from app_config. These are the
 * defaults new cowork sessions start with; the user's latest changes are saved
 * through the renderer configService (same app_config row).
 */
export function getPersistedAutoApproveTools(): string[] {
  const sqliteStore = getStore();
  const appConfig = sqliteStore?.get<{ autoApproveTools?: string[] }>('app_config');
  const tools = appConfig?.autoApproveTools;
  if (!Array.isArray(tools)) return [];
  return tools
    .map((name) => (typeof name === 'string' ? name.trim().toLowerCase() : ''))
    .filter(Boolean);
}

/**
 * Global default permission mode for cowork sessions, persisted in app_config.
 * The user's latest selection is inherited by every new session/Bot.
 */
export function getPersistedCoworkPermissionMode(): CoworkPermissionMode {
  const sqliteStore = getStore();
  const appConfig = sqliteStore?.get<{ coworkPermissionMode?: unknown }>('app_config');
  const mode = appConfig?.coworkPermissionMode;
  return (mode === 'default' || mode === 'plan' || mode === 'acceptEdits' || mode === 'bypassPermissions')
    ? mode
    : 'default';
}

/**
 * Global default effort level for cowork sessions ('low'|'medium'|'high'|
 * 'max'), or null for auto. Persisted in app_config like permission mode.
 */
export function getPersistedCoworkEffortLevel(): string | null {
  const sqliteStore = getStore();
  const appConfig = sqliteStore?.get<{ coworkEffortLevel?: unknown }>('app_config');
  const level = appConfig?.coworkEffortLevel;
  return (typeof level === 'string' && level) ? level : null;
}

/**
 * Persists a global cowork preference (permission mode / effort level) to
 * app_config. The renderer also writes these via configService.updateConfig,
 * but the main process persists them here on mid-session switches so the
 * choice is global regardless of which UI path changed it.
 */
export function setPersistedCoworkPreference(updates: {
  permissionMode?: CoworkPermissionMode;
  effortLevel?: string | null;
}): void {
  const sqliteStore = getStore();
  if (!sqliteStore) return;
  const appConfig = sqliteStore.get<Record<string, unknown>>('app_config') ?? {};
  if (updates.permissionMode !== undefined) {
    appConfig.coworkPermissionMode = updates.permissionMode;
  }
  if (updates.effortLevel !== undefined) {
    appConfig.coworkEffortLevel = updates.effortLevel;
  }
  sqliteStore.set('app_config', appConfig);
}

export function resolveCurrentModelLimits(modelId?: string | null): CoworkModelLimits {
  const sqliteStore = getStore();
  const appConfig = sqliteStore?.get<AppConfig>('app_config') ?? {};
  return resolveCoworkModelLimits(appConfig, modelId);
}

/**
 * Resolves per-model options (effort/thinking) from app_config for the given
 * model id. Returns null when no options are configured. Used by the cowork
 * SDK path to pass effort/thinking into the SDK options — previously these
 * settings only reached the OpenAI-compat proxy for the renderer's direct
 * API calls, never the cowork session.
 */
export function resolveModelOptions(modelId?: string | null): {
  reasoningEffort?: string;
  thinking?: { type: string };
} | null {
  if (!modelId) return null;
  const sqliteStore = getStore();
  const appConfig = sqliteStore?.get<AppConfig>('app_config');
  if (!appConfig?.providers) return null;

  for (const provider of Object.values(appConfig.providers)) {
    if (!provider?.models) continue;
    const model = provider.models.find((m) => m.id === modelId);
    if (model?.options) {
      return model.options;
    }
  }
  return null;
}

export function buildEnvForConfig(config: CoworkApiConfig): Record<string, string> {
  const baseEnv = { ...process.env } as Record<string, string>;

  baseEnv.ANTHROPIC_AUTH_TOKEN = config.apiKey;
  baseEnv.ANTHROPIC_API_KEY = config.apiKey;
  baseEnv.ANTHROPIC_BASE_URL = config.baseURL;
  baseEnv.ANTHROPIC_MODEL = config.model;
  baseEnv.ANTHROPIC_SMALL_FAST_MODEL = config.model;

  return baseEnv;
}
