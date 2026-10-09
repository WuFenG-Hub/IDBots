/**
 * First-run free-quota provisioning orchestration (renderer side).
 *
 * On a fresh install this silently bootstraps the free-quota relay account via
 * the main process (identity-signed; creates the local user identity when
 * missing) and writes the returned relay key/baseUrl/models into the built-in
 * `metaid-free` provider, which then becomes the default model.
 *
 * The whole flow never throws: any failure (offline, relay down, disabled
 * backend) leaves the app without a free provider — the welcome flow then
 * falls back to the user's configured default model or fails into its retry
 * UI. Idempotency comes from the written provider config: once provisioned,
 * later launches do nothing.
 */

import { configService } from './config';
import type { AppConfig } from '../config';
import {
  LLM_FREE_PROVIDER_KEY,
  FREE_PROVIDER_DISPLAY_NAME,
  getFreeProviderModelCanonical,
  getFreeProviderModelDisplayName,
  isFreeProviderConfigured,
  planFreeQuotaProvisioning,
} from './llmFreeQuotaGate.js';

/**
 * Manual opt-in path (Settings card): bootstrap and provision the free
 * provider without touching anything else. Used by existing installs that
 * never went through the first-run flow.
 */
export async function enableFreeQuotaManually(): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await window.electron.llmRelay.bootstrap();
    if (!response?.success || !response.result?.apiKey || !response.result?.baseUrl) {
      return { success: false, error: response?.error ?? 'empty bootstrap result' };
    }
    await provisionProviderConfig(response.result);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

type LlmRelayBootstrapResult = NonNullable<Awaited<ReturnType<typeof window.electron.llmRelay.bootstrap>>['result']>;

async function provisionProviderConfig(result: LlmRelayBootstrapResult): Promise<void> {
  const config = configService.getConfig();
  const models = (result.models ?? []).map((model) => ({
    id: model.id,
    name: getFreeProviderModelDisplayName(model.id),
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    // Known relay ids (deepseek-chat) pin the canonical limits: the 1M
    // context window (upstream upgraded past the old 64K cap, owner-confirmed
    // 2026-10-09) plus the 100K declared output ceiling; unknown ids keep
    // the relay-reported fields untouched.
    ...getFreeProviderModelCanonical(model.id),
  }));
  await configService.updateConfig({
    providers: {
      [LLM_FREE_PROVIDER_KEY]: {
        enabled: true,
        apiKey: result.apiKey,
        baseUrl: result.baseUrl,
        apiFormat: 'openai',
        models,
        name: FREE_PROVIDER_DISPLAY_NAME,
      },
    } as AppConfig['providers'],
    model: {
      ...config.model,
      defaultModel: models[0]?.id ?? config.model.defaultModel,
      defaultProvider: LLM_FREE_PROVIDER_KEY,
    },
  });
}

/**
 * Silently provision the built-in free provider on a fresh install, so the
 * Twin Bot the user creates in the welcome flow starts on a working brain.
 *
 * Skips (and leaves the config untouched) when the provider is already
 * configured or the machine already holds MetaBots — an existing install is
 * never rewritten. A roster read that fails outright also skips: the plan
 * cannot distinguish a fresh install from a veteran one, and silently
 * switching a veteran's default provider is worse than not provisioning.
 */
export async function ensureFreeQuotaProvisioning(): Promise<void> {
  try {
    const provider = configService.getConfig().providers?.[LLM_FREE_PROVIDER_KEY];
    let metabotCount: number | null = null;
    try {
      const metabotResult = await window.electron.metabot.list();
      if (metabotResult?.success && Array.isArray(metabotResult.list)) {
        metabotCount = metabotResult.list.length;
      }
    } catch {
      metabotCount = null;
    }
    if (metabotCount == null) {
      console.warn('[llm-free-quota] metabot roster unavailable; skipping provisioning');
      return;
    }
    const plan = planFreeQuotaProvisioning({
      metabotCount,
      providerConfigured: isFreeProviderConfigured(provider),
    });
    if (plan === 'none') {
      return;
    }
    const response = await window.electron.llmRelay.bootstrap();
    if (!response?.success || !response.result?.apiKey || !response.result?.baseUrl) {
      console.warn('[llm-free-quota] bootstrap failed:', response?.error ?? 'empty result');
      return;
    }
    await provisionProviderConfig(response.result);
  } catch (error) {
    console.warn('[llm-free-quota] provisioning failed:', error);
  }
}
