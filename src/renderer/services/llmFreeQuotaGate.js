/**
 * Free-quota first-run provisioning gates (pure logic, node-test friendly).
 *
 * The built-in `metaid-free` provider is provisioned silently on fresh
 * installs so new users can chat with the Twin Bot they create during the
 * welcome flow without configuring an LLM API key. Existing installs (already
 * have MetaBots) are never touched.
 */

export const LLM_FREE_PROVIDER_KEY = 'metaid-free';
/**
 * Canonical user-facing label for the built-in free provider. Every surface
 * (Settings providerMeta, onboarding labels, model picker groups, provisioning
 * writes, config normalization) must derive the label from here so installs
 * provisioned before the rename never show the legacy "MetaID Free" name.
 */
export const FREE_PROVIDER_DISPLAY_NAME = 'IDBots-Free';

/**
 * User-facing display names for free-relay model ids. Relay ids are internal
 * wire names sent to the API; the UI should show these product names instead.
 */
const FREE_PROVIDER_MODEL_DISPLAY_NAMES = {
  'deepseek-chat': 'deepseek-flash',
  // The 2026-10-16 relay catalog rename: `deepseek-chat` became the public
  // `deepseek-4.1-flash` (chat still routes the old alias server-side, but the
  // models list no longer shows it). Same display name as the legacy id — the
  // two never coexist in one catalog, so no ambiguity in the picker.
  'deepseek-4.1-flash': 'deepseek-flash',
};

export function getFreeProviderModelDisplayName(modelId) {
  if (typeof modelId !== 'string') {
    return modelId;
  }
  return FREE_PROVIDER_MODEL_DISPLAY_NAMES[modelId] ?? modelId;
}

/**
 * Canonical client-side limits/options for known free-relay model ids.
 *
 * The relay upstream previously enforced the legacy DeepSeek V3 wire values
 * for `deepseek-chat` (context_window 64000 — server-confirmed 2026-10-04,
 * requests beyond ~64K tokens died with 400 "maximum context length"). The
 * owner confirmed on 2026-10-09 that the upstream has been upgraded past
 * that limit, so the window now mirrors the DeepSeek V4 flash family's 1M
 * (keep in sync with DEEPSEEK_V4_FLASH_CONTEXT_WINDOW in
 * src/main/libs/coworkModelLimits.ts). Auto-compaction re-arms accordingly
 * at min(0.8*1M, 1M-100K-40K) = 800K tokens.
 *
 * max_output_tokens is a DECLARED ceiling of 100K (owner decision
 * 2026-10-09): thinking shares the output budget, and the previously pinned
 * 4096 truncated effort-max turns after a couple of sentences. At the 1M
 * window the resolution-time clamp (clampCoworkMaxOutputTokens: 32% tier)
 * leaves the full 100K effective per turn. Billing is by actual tokens
 * used, so a generous declared ceiling costs nothing for short replies.
 *
 * supportsImage stays false because the relay's image support is unverified.
 * Ids absent from this table keep whatever the relay reported.
 */
const FREE_PROVIDER_MODEL_CANONICAL = {
  'deepseek-chat': {
    contextWindow: 1_000_000,
    maxOutputTokens: 100_000,
    supportsImage: false,
    options: { reasoningEffort: 'max', thinking: { type: 'enabled' } },
  },
  // The 2026-10-16 relay catalog flagship (rename of the deepseek-chat alias):
  // same wire family, so it inherits the exact same client profile — the 1M
  // window, the 100K declared output ceiling, and effort-max thinking.
  'deepseek-4.1-flash': {
    contextWindow: 1_000_000,
    maxOutputTokens: 100_000,
    supportsImage: false,
    options: { reasoningEffort: 'max', thinking: { type: 'enabled' } },
  },
};

/**
 * Machine-written legacy limit values on stored free-relay model rows, keyed
 * by model id. Every value listed here was pinned by an earlier build's
 * provisioning or load-time normalization — the Settings model editor has no
 * output-ceiling field at all, and provisioning always writes canonical or
 * relay-reported numbers — so an EXACT stored match identifies the era that
 * wrote the row rather than a user choice:
 * - maxOutputTokens 32_768: the pre-2026-10-04 canonical that mirrored the
 *   deepseek-flash preset.
 * - maxOutputTokens 4_096: the 2026-10-04 pin (also what the relay payload
 *   reported); raised to the 2026-10-09 100K declared ceiling.
 * - contextWindow 64_000: the 2026-10-04 server-enforced pin; superseded on
 *   2026-10-09 when the owner confirmed the upstream upgrade past 64K, so
 *   those rows bump to the canonical 1M window.
 * Anything else a row stores (user-tuned values included) is kept untouched.
 */
const FREE_PROVIDER_MODEL_LEGACY_STORED_LIMITS = {
  'deepseek-chat': {
    contextWindow: new Set([64_000]),
    maxOutputTokens: new Set([32_768, 4_096]),
  },
};

/**
 * Which of the given stored model row's limit fields hold a machine-pinned
 * legacy value and must be rewritten to the current canonical value at load
 * time. Flags only — the caller resolves the replacement from
 * getFreeProviderModelCanonical so the two tables cannot drift apart.
 */
export function getFreeProviderModelLegacyLimitRewrites(model) {
  const table = model ? FREE_PROVIDER_MODEL_LEGACY_STORED_LIMITS[model.id] : undefined;
  return {
    contextWindow: table ? table.contextWindow.has(model.contextWindow) : false,
    maxOutputTokens: table ? table.maxOutputTokens.has(model.maxOutputTokens) : false,
  };
}

/**
 * Canonical config overrides for a free-relay model id, or null when the id
 * is unknown (callers then keep the relay-provided values). Returns a fresh
 * object per call so stored configs never share references with the table.
 */
export function getFreeProviderModelCanonical(modelId) {
  if (typeof modelId !== 'string') {
    return null;
  }
  const canonical = FREE_PROVIDER_MODEL_CANONICAL[modelId];
  if (!canonical) {
    return null;
  }
  return {
    contextWindow: canonical.contextWindow,
    maxOutputTokens: canonical.maxOutputTokens,
    supportsImage: canonical.supportsImage,
    options: canonical.options
      ? {
          ...canonical.options,
          thinking: canonical.options.thinking ? { ...canonical.options.thinking } : undefined,
        }
      : undefined,
  };
}

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
 * - 'none':      the free provider is already usable, or this is an existing
 *                install (has MetaBots) whose configuration must stay
 *                untouched.
 * - 'bootstrap': fresh install — claim the relay key and write it into the
 *                `metaid-free` provider before the Twin Bot is created, so the
 *                new bot has a brain to run on.
 *
 * No bot is ever created here: the user's Twin Bot comes from the welcome
 * flow's "Enter IDBots" click (see components/onboarding/WelcomeFlow.tsx).
 */
export function planFreeQuotaProvisioning(input) {
  const metabotCount = Number.isFinite(input?.metabotCount) ? Math.floor(input.metabotCount) : 0;
  if (input?.providerConfigured) return 'none';
  if (metabotCount > 0) return 'none';
  return 'bootstrap';
}

/**
 * Plan a catalog sync for an already-provisioned free provider from the relay
 * catalog a quota/bootstrap response reported (2026-10-16: the server grew
 * from the single `deepseek-chat` to a public multi-model directory, but
 * existing installs have provider.models frozen at their bootstrap-era list
 * and planFreeQuotaProvisioning says 'none' for them — only this sync moves
 * them forward, without a new bootstrap that would reissue the relay key).
 *
 * Returns the next `models` array, or null when nothing should be written:
 * - null when the id sets already match, the relay list is empty/unusable
 *   (never an empty replace — same convention as mergeSyncedProviderModels),
 *   or the provider has no stored catalog to compare against.
 * - The relay list IS the directory: ids it dropped disappear, new ids appear
 *   in relay order. Surviving ids keep their stored row untouched (user-tuned
 *   limits/options survive, mirroring mergeSyncedProviderModels); new ids get
 *   the bootstrap merge semantics — relay-reported limits with the canonical
 *   client profile overriding known ids (getFreeProviderModelCanonical).
 */
export function planFreeProviderCatalogSync(provider, relayModels) {
  if (!provider || !Array.isArray(provider.models)) {
    return null;
  }
  if (!Array.isArray(relayModels)) {
    return null;
  }
  const seen = new Set();
  const catalog = [];
  for (const entry of relayModels) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    catalog.push(entry);
  }
  if (catalog.length === 0) {
    return null;
  }
  const currentIds = new Set(
    provider.models
      .map((model) => (typeof model?.id === 'string' ? model.id.trim() : ''))
      .filter(Boolean),
  );
  const changed = catalog.some((entry) => !currentIds.has(entry.id.trim()))
    || [...currentIds].some((id) => !seen.has(id));
  if (!changed) {
    return null;
  }
  const storedById = new Map(provider.models.map((model) => [model.id, model]));
  return catalog.map((entry) => {
    const id = entry.id.trim();
    const stored = storedById.get(id);
    if (stored) {
      return { ...stored };
    }
    return {
      id,
      name: getFreeProviderModelDisplayName(id),
      contextWindow: entry.contextWindow,
      maxOutputTokens: entry.maxOutputTokens,
      ...getFreeProviderModelCanonical(id),
    };
  });
}
