/**
 * Official model-list sync for built-in providers that expose an
 * OpenAI-compatible GET /models endpoint (deepseek, opencode, commandcode).
 *
 * Settings > Models shows a "Fetch Models" button for these providers: one
 * click pulls the provider's live catalog and replaces the stored list, so
 * users pick up renamed/added/retired official models without waiting for an
 * app release. Per-model local settings (thinking options, vision flag,
 * limits) survive the replace for ids that exist in both lists, and
 * DeepSeek's canonical preset re-supplies names/limits for the ids it knows.
 *
 * The pure pieces (URL building, payload parsing, merge) are exported
 * separately so node:test can cover them without the Electron bridge.
 */

import type { ModelOptions } from '../config';
import { getDefaultDeepSeekModels } from '../config';
import { buildOpenCodeGoSessionHeaders } from './opencodeGatewayHeaders';

/** One entry of a provider's model catalog after an official-list sync. */
export interface SyncedProviderModel {
  id: string;
  name: string;
  supportsImage?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  options?: ModelOptions;
}

export interface ExistingProviderModel {
  id: string;
  name?: string;
  supportsImage?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  options?: ModelOptions;
}

/** Raw entry of the OpenAI-style `data` array the gateways return. */
export interface FetchedProviderModel {
  id: string;
  name?: string;
  contextWindow?: number;
}

const MODEL_LIST_SYNC_PROVIDERS = ['deepseek', 'opencode', 'commandcode'] as const;

/** True when the provider exposes a known GET /models endpoint to sync from. */
export function providerSupportsModelListSync(providerKey: string): boolean {
  return (MODEL_LIST_SYNC_PROVIDERS as readonly string[]).includes(providerKey.trim().toLowerCase());
}

/**
 * Models-endpoint URL for a provider base URL. DeepSeek mounts /models at the
 * host root (https://api-docs.deepseek.com/zh-cn/api/list-models) — older
 * configs may carry the /anthropic or /v1 suffix from the Messages /
 * OpenAI-SDK base URL forms, so both are stripped. OpenAI-compatible
 * gateways (opencode, commandcode) mount /models next to /chat/completions.
 */
export function buildProviderModelsUrl(baseUrl: string, providerKey: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) return '/v1/models';
  if (normalized.endsWith('/models')) return normalized;
  const isDeepSeekHost = providerKey.trim().toLowerCase() === 'deepseek'
    || normalized.toLowerCase().includes('api.deepseek.com');
  if (isDeepSeekHost) {
    const hostRoot = normalized.replace(/\/anthropic$/i, '').replace(/\/v1$/i, '');
    return hostRoot ? `${hostRoot}/models` : '/models';
  }
  if (normalized.endsWith('/v1')) return `${normalized}/models`;
  return `${normalized}/v1/models`;
}

/**
 * Parse the OpenAI-style list payload (`{object: 'list', data: [...]}`).
 * commandcode also reports a display `name` and `context_length` per model;
 * deepseek and opencode return bare ids. Unknown shapes yield an empty list
 * (the caller treats that as a failed sync, never an empty replace).
 */
export function parseProviderModelListPayload(payload: unknown): FetchedProviderModel[] {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const models: FetchedProviderModel[] = [];
  for (const entry of data) {
    const id = typeof (entry as { id?: unknown })?.id === 'string'
      ? ((entry as { id: string }).id).trim()
      : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const rawName = (entry as { name?: unknown }).name;
    const rawContext = (entry as { context_length?: unknown }).context_length;
    models.push({
      id,
      name: typeof rawName === 'string' && rawName.trim() ? rawName.trim() : undefined,
      contextWindow: typeof rawContext === 'number' && Number.isFinite(rawContext) && rawContext > 0
        ? Math.floor(rawContext)
        : undefined,
    });
  }
  return models;
}

/**
 * Replace semantics with per-model preservation: the synced list IS the
 * official list (ids the provider dropped disappear, new ids appear in
 * official order), while ids present in the user's current catalog keep
 * their local `options` (thinking/effort picks) and — when neither the
 * endpoint nor the DeepSeek preset says otherwise — their vision flag,
 * limits and display name.
 */
export function mergeSyncedProviderModels(
  providerKey: string,
  fetched: FetchedProviderModel[],
  existing: ExistingProviderModel[],
): SyncedProviderModel[] {
  type CanonicalModel = ReturnType<typeof getDefaultDeepSeekModels>[number];
  const canonicalById = new Map<string, CanonicalModel>(
    providerKey.trim().toLowerCase() === 'deepseek'
      ? getDefaultDeepSeekModels().map((model) => [model.id, model])
      : [],
  );
  const existingById = new Map(existing.map((model) => [model.id, model]));
  return fetched.map((entry) => {
    const canonical = canonicalById.get(entry.id);
    const current = existingById.get(entry.id);
    return {
      id: entry.id,
      name: entry.name ?? canonical?.name ?? current?.name ?? entry.id,
      supportsImage: canonical?.supportsImage ?? current?.supportsImage ?? false,
      contextWindow: entry.contextWindow ?? canonical?.contextWindow ?? current?.contextWindow,
      maxOutputTokens: canonical?.maxOutputTokens ?? current?.maxOutputTokens,
      options: current?.options ?? canonical?.options,
    };
  });
}

/**
 * Fetch the provider's official model list through the main-process bridge
 * (same path as the connection test, so CORS never applies) and merge it
 * with the provider's current catalog. Throws with the upstream error
 * message on failure.
 */
export async function fetchProviderModelList(input: {
  providerKey: string;
  apiKey?: string;
  baseUrl?: string;
  existingModels?: ExistingProviderModel[];
}): Promise<SyncedProviderModel[]> {
  const baseUrl = (input.baseUrl ?? '').trim().replace(/\/+$/, '');
  const url = buildProviderModelsUrl(baseUrl, input.providerKey);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const apiKey = (input.apiKey ?? '').trim();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  Object.assign(headers, buildOpenCodeGoSessionHeaders(input.providerKey, baseUrl));

  const response = await window.electron.api.fetch({ url, method: 'GET', headers });
  if (!response.ok) {
    const data = (response.data ?? {}) as { error?: { message?: string }; message?: string };
    const message = data.error?.message || data.message || `HTTP ${response.status}`;
    throw new Error(message);
  }
  const fetched = parseProviderModelListPayload(response.data);
  if (fetched.length === 0) {
    throw new Error('The provider returned an empty model list');
  }
  return mergeSyncedProviderModels(input.providerKey, fetched, input.existingModels ?? []);
}
