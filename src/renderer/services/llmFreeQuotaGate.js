/**
 * Free-quota first-run provisioning gates (pure logic, node-test friendly).
 *
 * The built-in `metaid-free` provider is provisioned silently on fresh
 * installs so new users can chat with the welcome bot without configuring an
 * LLM API key. Existing installs (already have MetaBots) are never touched.
 */

export const LLM_FREE_PROVIDER_KEY = 'metaid-free';
/** kvStore key holding the provisioned welcome bot's id (deletion-respecting). */
export const LLM_RELAY_WELCOME_BOT_ID_KEY = 'llmRelay.welcomeBotId';

/**
 * A provider entry counts as provisioned only when bootstrap has filled in
 * connection credentials AND at least one model.
 */
export function isFreeProviderConfigured(provider) {
  return !!(
    provider &&
    provider.enabled &&
    typeof provider.apiKey === 'string' && provider.apiKey.trim() !== '' &&
    typeof provider.baseUrl === 'string' && provider.baseUrl.trim() !== '' &&
    Array.isArray(provider.models) && provider.models.length > 0
  );
}

/**
 * Decide the first-run provisioning action.
 *
 * - 'none':                    already provisioned (welcomeBotId persisted) or
 *                              an existing install (has MetaBots). A deleted
 *                              welcome bot is never recreated: the persisted
 *                              id stays authoritative.
 * - 'create-bot-only':         a previous run provisioned the provider but
 *                              died before creating the welcome bot.
 * - 'bootstrap-and-create-bot': fresh install, nothing provisioned yet.
 */
export function planFreeQuotaProvisioning(input) {
  const metabotCount = Number.isFinite(input?.metabotCount) ? Math.floor(input.metabotCount) : 0;
  const welcomeBotId = Number.isFinite(input?.welcomeBotId) ? Math.floor(input.welcomeBotId) : null;
  if (welcomeBotId != null && welcomeBotId > 0) return 'none';
  if (metabotCount > 0) return 'none';
  return input?.providerConfigured ? 'create-bot-only' : 'bootstrap-and-create-bot';
}
