/**
 * Cerebellum (小脑) config accessor for the main process.
 *
 * The cerebellum is an optional fast decision model (first provider:
 * TypeSafe JEV, POST {baseUrl}/v1/systemone) layered next to the generative
 * "brain" LLM. This resolver is the single seam future decision call sites
 * (memory ranking, intent routing, ...) read; it returns null whenever the
 * feature is off or unusable, so callers need no shape checks of their own.
 */

export type CerebellumProvider = 'typesafe-jev';

export interface ResolvedCerebellumConfig {
  provider: CerebellumProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
}

export const CEREBELLUM_DEFAULT_BASE_URL = 'https://api.typesafe.ai';
export const CEREBELLUM_DEFAULT_MODEL = 'jev-latest';

const CEREBELLUM_PROVIDERS: readonly string[] = ['typesafe-jev'];

/**
 * Resolve the stored app_config into a ready-to-use cerebellum config, or
 * null when the feature is disabled, missing, malformed, or has no API key.
 * Never throws: every shape anomaly maps to null.
 */
export function resolveCerebellumConfig(appConfig: unknown): ResolvedCerebellumConfig | null {
  if (!appConfig || typeof appConfig !== 'object') {
    return null;
  }
  const raw = (appConfig as { cerebellum?: unknown }).cerebellum;
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  if (candidate.enabled !== true) {
    return null;
  }
  if (typeof candidate.provider !== 'string' || !CEREBELLUM_PROVIDERS.includes(candidate.provider)) {
    return null;
  }
  const apiKey = typeof candidate.apiKey === 'string' ? candidate.apiKey.trim() : '';
  if (!apiKey) {
    return null;
  }

  const rawBaseUrl = typeof candidate.baseUrl === 'string' ? candidate.baseUrl.trim() : '';
  const baseUrl = (rawBaseUrl || CEREBELLUM_DEFAULT_BASE_URL).replace(/\/+$/, '');
  if (!baseUrl) {
    return null;
  }

  const model = typeof candidate.model === 'string' && candidate.model.trim()
    ? candidate.model.trim()
    : CEREBELLUM_DEFAULT_MODEL;

  return {
    provider: candidate.provider as CerebellumProvider,
    apiKey,
    baseUrl,
    model,
  };
}
