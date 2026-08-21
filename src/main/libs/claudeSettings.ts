import type { SqliteStore } from '../sqliteStore';
import type { CoworkPermissionMode } from '../coworkStore';
import type { CoworkApiConfig } from './coworkConfigStore';
import {
  configureCoworkOpenAICompatProxy,
  type OpenAICompatProxyTarget,
  getCoworkOpenAICompatProxyBaseURL,
  getCoworkOpenAICompatProxyStatus,
} from './coworkOpenAICompatProxy';
import { normalizeProviderApiFormat, buildOpenAIChatCompletionsURL, type AnthropicApiFormat } from './coworkFormatTransform';
import { buildOpenAIResponsesURL } from './coworkOpenAICompatProxy';
import { resolveCoworkModelLimits, type CoworkModelLimits } from './coworkModelLimits';
import { toLlmEffortLevel } from './llmEffort';

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
  apiFormat?: 'anthropic' | 'openai' | 'responses' | 'native';
  models?: ProviderModel[];
};

type AppConfig = {
  model?: {
    defaultModel?: string;
    /**
     * Explicit default-provider key ('deepseek', 'opencode', ...) recorded
     * when the user picks a model in the UI. Used to disambiguate identical
     * model ids offered by multiple enabled providers (e.g. deepseek and
     * opencode both serve deepseek-v4-flash): without it, the config-order
     * scan below would always pick whichever provider appears first.
     * Absent on legacy configs — behavior stays the config-order scan.
     */
    defaultProvider?: string;
    /** Optional SDK fallback model id for automatic model refusal fallback. */
    fallbackModel?: string;
    availableModels?: ProviderModel[];
  };
  providers?: Record<string, ProviderConfig>;  /**
   * Phase 1 M5 rollout flag: cowork sessions on OpenAI-compatible provider
   * routes may run on the DSH kernel (dsh-runtime subprocess). Default off.
   */
  dshKernelEnabled?: boolean;

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

/**
 * Read the raw DeepSeek provider config (apiKey + baseUrl) from app_config,
 * without routing through the cowork proxy. Used by services that need to call
 * DeepSeek endpoints other than chat completions (e.g. /user/balance).
 * Returns null when the store is unavailable or DeepSeek is not configured.
 */
export function getDeepSeekProviderConfig(): { apiKey: string; baseUrl: string } | null {
  const sqliteStore = getStore();
  if (!sqliteStore) {
    return null;
  }
  const appConfig = sqliteStore.get<AppConfig>('app_config');
  const deepseek = appConfig?.providers?.deepseek;
  if (!deepseek) {
    return null;
  }
  const apiKey = (deepseek.apiKey ?? '').trim();
  const baseUrl = (deepseek.baseUrl ?? '').trim();
  if (!apiKey || !baseUrl) {
    return null;
  }
  return { apiKey, baseUrl };
}

type MatchedProvider = {
  providerName: string;
  providerConfig: ProviderConfig;
  modelId: string;
  apiFormat: AnthropicApiFormat;
};

/** Optional caller context so the default-route fallback warning can name the offending bot. */
export interface LlmResolutionContext {
  botId?: number | string | null;
  botName?: string | null;
}

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

/**
 * Defense-in-depth for pre-migration metabots.llm_id values, which held
 * PROVIDER ids: 'deepseek' maps to the automation-preferred flash model.
 * Any OTHER provider key is handled generically by Fallback 1 in
 * resolveMatchedProvider (provider's first/default model), and the startup
 * migration (services/llmBrainMigration) rewrites legacy values to model ids.
 */
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
 * An optional providerHint (the provider key the model was picked from, stored alongside model-level
 * brains) is preferred when the same model id is offered by multiple enabled providers.
 */
function resolveMatchedProvider(
  appConfig: AppConfig,
  overrideModelId?: string | null,
  providerHint?: string | null,
  context?: LlmResolutionContext
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

  // Explicit default-provider preference (global/default sessions only):
  // resolve the model against the user-chosen provider FIRST. Multiple
  // enabled providers can offer the same model id (e.g. deepseek and
  // opencode both serve deepseek-v4-flash), and the config-order scan below
  // would otherwise always pick whichever provider appears first. A
  // requestedOverride (metabot llm_id) is an explicit provider choice of its
  // own and must NOT be overridden by the global default provider.
  const defaultProviderKey = requestedOverride
    ? null
    : appConfig.model?.defaultProvider?.trim().toLowerCase() || null;
  let providerEntry: [string, ProviderConfig] | undefined;
  // Model-level brain with an explicit provider hint: prefer that provider's
  // exact model match over the config-order scan below (model ids can collide
  // across providers, e.g. a custom relay mirroring an official catalog).
  const providerHintKey = requestedOverride && providerHint?.trim()
    ? providerHint.trim().toLowerCase()
    : null;
  if (providerHintKey) {
    providerEntry = Object.entries(providers).find(
      ([name, provider]) =>
        name.toLowerCase() === providerHintKey
        && provider?.enabled
        && provider.models?.some((model) => model.id === modelId)
    ) as [string, ProviderConfig] | undefined;
  }
  if (defaultProviderKey) {
    providerEntry = Object.entries(providers).find(
      ([name, provider]) =>
        name.toLowerCase() === defaultProviderKey
        && provider?.enabled
        && provider.models?.some((model) => model.id === modelId)
    ) as [string, ProviderConfig] | undefined;
  }
  if (!providerEntry) {
    providerEntry = Object.entries(providers).find(
      ([, provider]) => {
        if (!provider?.enabled || !provider.models) return false;
        return provider.models.some((model) => model.id === modelId);
      }
    ) as [string, ProviderConfig] | undefined;
  }

  let resolvedModelId: string = modelId;

  // Fallback: when the configured default provider is enabled but does not
  // offer the default model (provider catalog changed, or the built-in
  // metaid-free relay serving a single model), use that provider's own first
  // model instead of failing. The default provider is the user's explicit
  // choice and must win over a hard error.
  if (!providerEntry && defaultProviderKey) {
    const byDefaultProvider = Object.entries(providers).find(
      ([name, provider]) =>
        name.toLowerCase() === defaultProviderKey && provider?.enabled && provider.models?.length
    ) as [string, ProviderConfig] | undefined;
    if (byDefaultProvider) {
      const [providerName, providerConfig] = byDefaultProvider;
      const providerModels = providerConfig.models as Array<{ id: string }>;
      providerEntry = [providerName, providerConfig];
      resolvedModelId = providerModels.find((model) => model.id === modelId)?.id ?? providerModels[0].id;
    }
  }

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
    // Last-resort safety net: a legacy/unresolvable override (e.g. a stale
    // provider key or a removed model id left in metabots.llm_id) must never
    // dead-end a bot turn. Re-resolve with NO override — the same default
    // route a session without an llm_id gets (default model -> first enabled
    // provider's first model) — and warn. Only the genuine no-enabled-
    // providers case keeps the hard error below.
    if (requestedOverride) {
      const defaultRoute = resolveMatchedProvider(appConfig);
      if (defaultRoute.matched) {
        const botLabel = context?.botId != null
          ? `bot ${context.botId}${context.botName ? ` (${context.botName})` : ''}: `
          : '';
        console.warn(
          `[llm-brain] ${botLabel}unresolvable llm_id '${requestedOverride}', using default route ` +
          `(model '${defaultRoute.matched.modelId}', provider '${defaultRoute.matched.providerName}')`
        );
        return defaultRoute;
      }
    }
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
  target: OpenAICompatProxyTarget = 'local',
  sessionKey?: string | null,
  providerHint?: string | null,
  context?: LlmResolutionContext
): ApiConfigResolution {
  const sqliteStore = getStore();
  if (!sqliteStore) {
    return { config: null, error: 'Store is not initialized.' };
  }
  const appConfig = sqliteStore.get<AppConfig>('app_config');
  if (!appConfig) {
    return { config: null, error: 'Application config not found.' };
  }
  const { matched, error } = resolveMatchedProvider(appConfig, modelId ?? undefined, providerHint ?? undefined, context);
  if (!matched) {
    return { config: null, error };
  }
  const resolution = buildApiConfigFromMatched(matched, target, sessionKey);
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
  target: OpenAICompatProxyTarget,
  sessionKey?: string | null
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
    apiFormat: matched.apiFormat,
    // Pin this upstream to the cowork session so the proxy's per-session
    // registry isolates it from concurrent sessions on other providers.
    sessionKey: sessionKey ?? undefined,
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
 * Direct-upstream provider route for the DSH kernel (Phase 1 M5): same
 * provider matching as the Claude path, but WITHOUT the OpenAI-compat proxy —
 * the DSH runtime speaks the provider's native protocol directly, so this
 * exposes the raw apiFormat and true upstream baseUrl/key.
 */
export interface DshProviderRouteInfo {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  apiFormat: 'anthropic' | 'openai' | 'responses' | 'native';
}

export function resolveDshProviderRoute(
  modelId?: string | null,
  providerHint?: string | null,
  context?: LlmResolutionContext
): DshProviderRouteInfo | null {
  const sqliteStore = getStore();
  const appConfig = sqliteStore?.get<AppConfig>('app_config');
  if (!appConfig) return null;
  const { matched } = resolveMatchedProvider(appConfig, modelId ?? undefined, providerHint ?? undefined, context);
  if (!matched) return null;
  return {
    provider: matched.providerName,
    baseUrl: dshApiRootOf(matched.providerConfig.baseUrl.trim(), matched.apiFormat, matched.providerName),
    apiKey: matched.providerConfig.apiKey?.trim() || '',
    model: matched.modelId,
    apiFormat: matched.apiFormat,
  };
}

/**
 * pi-ai adapters hand baseURL to the OpenAI SDK, which appends the endpoint
 * path itself — so the DSH route needs the API ROOT, while the stored provider
 * baseUrl may be any compatibility shape. Derive the root with the exact URL
 * knowledge the cowork proxy accumulated (DeepSeek serves /responses at the
 * host root; gateways use /v1/...; chat shape appends /v1/chat/completions).
 */
function dshApiRootOf(baseUrl: string, apiFormat: AnthropicApiFormat, providerName: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (apiFormat === 'responses') {
    const endpoint = buildOpenAIResponsesURL(trimmed, providerName);
    return endpoint.replace(/\/responses$/, '');
  }
  if (apiFormat === 'openai') {
    const endpoint = buildOpenAIChatCompletionsURL(trimmed);
    return endpoint.replace(/\/chat\/completions$/, '');
  }
  return trimmed;
}

/**
 * Local cowork is DSH-only. The Claude Agent SDK kernel and the Settings
 * pill that could switch back to it are retired so dual-kernel fallback
 * cannot hide DSH bugs. Persisted `dshKernelEnabled: false` is ignored.
 */
export function isDshKernelEnabled(): boolean {
  return true;
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
 * Global default effort level for cowork sessions, normalized onto the
 * app-wide off/low/high/max ladder (see llmEffort.ts). Leftover five-step
 * tokens (medium, xhigh) convert at this read boundary; canonical values
 * including `low` pass through. Null means auto / model default. Persisted in
 * app_config like permission mode.
 */
export function getPersistedCoworkEffortLevel(): string | null {
  const sqliteStore = getStore();
  const appConfig = sqliteStore?.get<{ coworkEffortLevel?: unknown }>('app_config');
  const level = appConfig?.coworkEffortLevel;
  return toLlmEffortLevel(level);
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
      // Normalize the stored default onto the app-wide off/low/high/max ladder
      // (leftover five-step tokens such as medium/xhigh convert; canonical
      // off/low/high/max pass through).
      return {
        ...model.options,
        ...(model.options.reasoningEffort !== undefined
          ? { reasoningEffort: toLlmEffortLevel(model.options.reasoningEffort) ?? undefined }
          : {}),
      };
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
