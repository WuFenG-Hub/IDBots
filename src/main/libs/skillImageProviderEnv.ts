type ProviderModel = {
  id: string;
};

type ProviderConfig = {
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
  models?: ProviderModel[];
};

type AppConfig = {
  providers?: Record<string, ProviderConfig>;
};

type ImageProviderId =
  | 'openai'
  | 'google'
  | 'openrouter'
  | 'dashscope'
  | 'replicate'
  | 'jimeng'
  | 'seedream';

type ProviderSpec = {
  imageProvider: ImageProviderId;
  appProviderKey?: string;
  credentialEnvNames: string[];
  modelEnvName: string;
  defaultModel: string;
  baseUrlEnvName?: string;
  requiresAllCredentials?: boolean;
};

const BAOYU_IMAGE_SKILL_ID = 'baoyu-image-studio';
/** Settings > Models provider whose apiKey doubles as the bundled
 *  seedance/seedream skills' ARK_API_KEY. */
const ARK_APP_PROVIDER_KEY = 'volcengine';

const PROVIDER_SPECS: Record<ImageProviderId, ProviderSpec> = {
  openai: {
    imageProvider: 'openai',
    appProviderKey: 'openai',
    credentialEnvNames: ['OPENAI_API_KEY'],
    modelEnvName: 'OPENAI_IMAGE_MODEL',
    defaultModel: 'gpt-image-1.5',
    baseUrlEnvName: 'OPENAI_BASE_URL',
  },
  google: {
    imageProvider: 'google',
    appProviderKey: 'gemini',
    credentialEnvNames: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
    modelEnvName: 'GOOGLE_IMAGE_MODEL',
    defaultModel: 'gemini-3-pro-image-preview',
    baseUrlEnvName: 'GOOGLE_BASE_URL',
  },
  openrouter: {
    imageProvider: 'openrouter',
    appProviderKey: 'openrouter',
    credentialEnvNames: ['OPENROUTER_API_KEY'],
    modelEnvName: 'OPENROUTER_IMAGE_MODEL',
    defaultModel: 'google/gemini-3.1-flash-image-preview',
    baseUrlEnvName: 'OPENROUTER_BASE_URL',
  },
  dashscope: {
    imageProvider: 'dashscope',
    appProviderKey: 'qwen',
    credentialEnvNames: ['DASHSCOPE_API_KEY'],
    modelEnvName: 'DASHSCOPE_IMAGE_MODEL',
    defaultModel: 'qwen-image-2.0-pro',
    baseUrlEnvName: 'DASHSCOPE_BASE_URL',
  },
  replicate: {
    imageProvider: 'replicate',
    credentialEnvNames: ['REPLICATE_API_TOKEN'],
    modelEnvName: 'REPLICATE_IMAGE_MODEL',
    defaultModel: 'google/nano-banana-pro',
    baseUrlEnvName: 'REPLICATE_BASE_URL',
  },
  jimeng: {
    imageProvider: 'jimeng',
    credentialEnvNames: ['JIMENG_ACCESS_KEY_ID', 'JIMENG_SECRET_ACCESS_KEY'],
    modelEnvName: 'JIMENG_IMAGE_MODEL',
    defaultModel: 'jimeng_t2i_v40',
    baseUrlEnvName: 'JIMENG_BASE_URL',
    requiresAllCredentials: true,
  },
  seedream: {
    imageProvider: 'seedream',
    credentialEnvNames: ['ARK_API_KEY'],
    modelEnvName: 'SEEDREAM_IMAGE_MODEL',
    defaultModel: 'doubao-seedream-5-0-260128',
    baseUrlEnvName: 'SEEDREAM_BASE_URL',
  },
};

const BRIDGE_PROVIDER_ORDER: ImageProviderId[] = ['openai', 'google', 'openrouter', 'dashscope'];
const ENV_ONLY_PROVIDER_ORDER: ImageProviderId[] = ['replicate', 'jimeng', 'seedream'];
const METABOT_PROVIDER_MAPPING: Record<string, ImageProviderId> = {
  openai: 'openai',
  gemini: 'google',
  openrouter: 'openrouter',
  qwen: 'dashscope',
};

const normalizeString = (value: unknown): string => {
  return typeof value === 'string' ? value.trim() : '';
};

const normalizeSkillIds = (skillIds?: string[]): Set<string> => {
  return new Set(
    (skillIds ?? [])
      .map((id) => normalizeString(id).toLowerCase())
      .filter(Boolean)
      .flatMap((id) => [id, id.replace(/_/g, '-'), id.replace(/-/g, '_')])
  );
};

const shouldInjectForSkillIds = (skillIds?: string[]): boolean => {
  if (!Array.isArray(skillIds) || skillIds.length === 0) {
    return true;
  }

  const normalized = normalizeSkillIds(skillIds);
  return normalized.has(BAOYU_IMAGE_SKILL_ID) || normalized.has(BAOYU_IMAGE_SKILL_ID.replace(/-/g, '_'));
};

/**
 * ARK_API_KEY for the bundled seedance/seedream skills. Priority: the
 * Settings > Models "volcengine" provider key, then the process env. Unlike
 * the baoyu chain there is no provider selection — both skills always talk
 * to Volcengine Ark. Injected unconditionally when resolvable (host-level
 * credential, like IDBOTS_RPC_TOKEN): a session with an unrelated pinned
 * skill can still free-route to seedream, and a skill-id gate would fail
 * there silently.
 */
const resolveArkEnvOverrides = (
  appConfig: AppConfig | null | undefined,
  processEnv: NodeJS.ProcessEnv
): Record<string, string> | null => {
  const appApiKey = getAppProviderApiKey(appConfig, ARK_APP_PROVIDER_KEY);
  if (appApiKey) {
    return { ARK_API_KEY: appApiKey };
  }
  const envApiKey = normalizeString(processEnv.ARK_API_KEY);
  return envApiKey ? { ARK_API_KEY: envApiKey } : null;
};

const getAppProviderApiKey = (
  appConfig: AppConfig | null | undefined,
  appProviderKey: string | undefined
): string => {
  if (!appProviderKey) {
    return '';
  }

  const provider = appConfig?.providers?.[appProviderKey];
  if (!provider?.enabled) {
    return '';
  }

  return normalizeString(provider.apiKey);
};

const getEnvCredentialValues = (
  spec: ProviderSpec,
  processEnv: NodeJS.ProcessEnv
): Record<string, string> | null => {
  const resolved: Record<string, string> = {};

  if (spec.requiresAllCredentials) {
    for (const envName of spec.credentialEnvNames) {
      const value = normalizeString(processEnv[envName]);
      if (!value) {
        return null;
      }
      resolved[envName] = value;
    }
    return resolved;
  }

  const firstValue = spec.credentialEnvNames
    .map((envName) => normalizeString(processEnv[envName]))
    .find(Boolean);
  if (!firstValue) {
    return null;
  }

  for (const envName of spec.credentialEnvNames) {
    resolved[envName] = firstValue;
  }
  return resolved;
};

const buildProviderEnv = (
  spec: ProviderSpec,
  credentialValues: Record<string, string>,
  processEnv: NodeJS.ProcessEnv
): Record<string, string> => {
  const env: Record<string, string> = {
    BAOYU_IMAGE_PROVIDER: spec.imageProvider,
    [spec.modelEnvName]: normalizeString(processEnv[spec.modelEnvName]) || spec.defaultModel,
  };

  Object.assign(env, credentialValues);

  if (spec.baseUrlEnvName) {
    const baseUrl = normalizeString(processEnv[spec.baseUrlEnvName]);
    if (baseUrl) {
      env[spec.baseUrlEnvName] = baseUrl;
    }
  }

  return env;
};

const resolveProviderFromAppOrEnv = (
  providerId: ImageProviderId,
  appConfig: AppConfig | null | undefined,
  processEnv: NodeJS.ProcessEnv
): Record<string, string> | null => {
  const spec = PROVIDER_SPECS[providerId];
  const appApiKey = getAppProviderApiKey(appConfig, spec.appProviderKey);

  if (appApiKey) {
    const credentialValues = Object.fromEntries(
      spec.credentialEnvNames.map((envName) => [envName, appApiKey])
    );
    return buildProviderEnv(spec, credentialValues, processEnv);
  }

  const envCredentialValues = getEnvCredentialValues(spec, processEnv);
  if (!envCredentialValues) {
    return null;
  }

  return buildProviderEnv(spec, envCredentialValues, processEnv);
};

export function buildImageSkillEnvOverrides(input: {
  activeSkillIds?: string[];
  metabotLlmId?: string | null;
  /** Provider key the bot's brain model was picked from. Brains are
   *  model-level since 2026-08 (llm_id holds a MODEL id), so the image
   *  provider mapping keys on the provider — llm_id remains only as the
   *  legacy fallback for rows that still store a provider key. */
  metabotLlmProvider?: string | null;
  appConfig?: AppConfig | null;
  processEnv?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const processEnv = input.processEnv ?? process.env;
  const appConfig = input.appConfig ?? null;
  const overrides: Record<string, string> = {};

  // Seedance/Seedream always talk to Volcengine Ark: mirror the volcengine
  // provider key (Settings > Models) into ARK_API_KEY so the bundled skills
  // work out of the box instead of demanding a manual per-skill .env.
  const arkEnv = resolveArkEnvOverrides(appConfig, processEnv);
  if (arkEnv) {
    Object.assign(overrides, arkEnv);
  }

  if (!shouldInjectForSkillIds(input.activeSkillIds)) {
    return overrides;
  }

  const brainProviderKey = normalizeString(input.metabotLlmProvider || input.metabotLlmId).toLowerCase();
  const mappedProvider = METABOT_PROVIDER_MAPPING[brainProviderKey];
  const orderedProviders: ImageProviderId[] = [];

  if (mappedProvider) {
    orderedProviders.push(mappedProvider);
  }

  for (const providerId of BRIDGE_PROVIDER_ORDER) {
    if (!orderedProviders.includes(providerId)) {
      orderedProviders.push(providerId);
    }
  }

  for (const providerId of ENV_ONLY_PROVIDER_ORDER) {
    if (!orderedProviders.includes(providerId)) {
      orderedProviders.push(providerId);
    }
  }

  for (const providerId of orderedProviders) {
    const resolved = resolveProviderFromAppOrEnv(providerId, appConfig, processEnv);
    if (resolved) {
      // The ARK key from the configured provider wins over any value the
      // fallback chain might have mirrored from the environment.
      Object.assign(overrides, resolved, overrides.ARK_API_KEY ? { ARK_API_KEY: overrides.ARK_API_KEY } : {});
      return overrides;
    }
  }

  return overrides;
}
