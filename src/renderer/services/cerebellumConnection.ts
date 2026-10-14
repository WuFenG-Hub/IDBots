/**
 * Cerebellum (小脑) connection test. Probes the provider's model catalog
 * (GET {baseUrl}/v1/models, Bearer auth) — a decision call like
 * POST /v1/systemone would consume quota and fabricate an input, so the
 * settings panel validates credentials against the read-only listing instead.
 * Network goes through the same window.electron.api.fetch bridge as
 * llmConnection.testProviderConnection.
 */

export interface CerebellumConnectionConfig {
  baseUrl: string;
  apiKey: string;
}

/**
 * Normalize a user-entered base URL into the model-listing endpoint. A base
 * already ending in /v1 keeps it; anything else gains the /v1 prefix.
 */
export function buildCerebellumModelsUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) {
    return '/v1/models';
  }
  if (normalized.endsWith('/v1')) {
    return `${normalized}/models`;
  }
  return `${normalized}/v1/models`;
}

const MODEL_LIST_DISPLAY_LIMIT = 5;

/**
 * Extract displayable model ids from a catalog payload. TypeSafe's native
 * shape is {"models":[{"name":"jev-latest",...}]} (the free JEV relay
 * replays it verbatim); OpenAI-style {data:[{id}]} and bare arrays also
 * stay supported for custom gateways.
 */
function extractModelIds(data: unknown): string[] {
  let entries: unknown[] = [];
  if (Array.isArray(data)) {
    entries = data;
  } else if (data && typeof data === 'object') {
    const record = data as { data?: unknown; models?: unknown };
    if (Array.isArray(record.models)) {
      entries = record.models;
    } else if (Array.isArray(record.data)) {
      entries = record.data;
    }
  }
  return entries
    .map((entry) => {
      if (typeof entry === 'string') {
        return entry;
      }
      if (entry && typeof entry === 'object') {
        const record = entry as { id?: unknown; name?: unknown };
        if (typeof record.id === 'string') {
          return record.id;
        }
        if (typeof record.name === 'string') {
          return record.name;
        }
      }
      return '';
    })
    .filter((id) => id.trim() !== '');
}

export async function testCerebellumConnection(
  config: CerebellumConnectionConfig,
  i18n: { t: (key: string) => string },
): Promise<{ success: boolean; message: string }> {
  if (!config.apiKey.trim()) {
    return { success: false, message: i18n.t('apiKeyRequired') };
  }

  try {
    const response = await window.electron.api.fetch({
      url: buildCerebellumModelsUrl(config.baseUrl),
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
    });

    if (response.ok) {
      const modelIds = extractModelIds(response.data);
      if (modelIds.length === 0) {
        return { success: true, message: i18n.t('connectionSuccess') };
      }
      const listed = modelIds.slice(0, MODEL_LIST_DISPLAY_LIMIT).join(', ');
      const suffix = modelIds.length > MODEL_LIST_DISPLAY_LIMIT ? `${listed}, …` : listed;
      return {
        success: true,
        message: i18n.t('cerebellumConnectionSuccess')
          .replace('{count}', String(modelIds.length))
          .replace('{models}', suffix),
      };
    }
    if (response.status === 401) {
      return { success: false, message: i18n.t('cerebellumInvalidApiKey') };
    }
    return { success: false, message: `${i18n.t('connectionFailed')}: ${response.status}` };
  } catch (err) {
    return {
      success: false,
      message: `${i18n.t('cerebellumConnectionUnreachable')}${err instanceof Error && err.message ? ` (${err.message})` : ''}`,
    };
  }
}
