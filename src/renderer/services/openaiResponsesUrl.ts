/**
 * Shared OpenAI Responses endpoint URL builder for the renderer's three
 * responses-format call paths:
 *
 *   - components/Settings.tsx        — the "Test connection" probe
 *   - services/llmConnection.ts      — testProviderConnection
 *   - services/api.ts                — the direct renderer streaming path
 *
 * The routing rule mirrors the main-process builder
 * (coworkOpenAICompatProxy.buildOpenAIResponsesURL) exactly:
 *
 *   1. DeepSeek's Responses endpoint lives at the host root (`/responses`)
 *      without a version prefix; a trailing /anthropic or /v1 is stripped.
 *   2. Versioned bases (…/v1, …/v4 — e.g. Zhipu's /api/coding/paas/v4) mount
 *      /responses directly. A trailing /chat/completions identifies the chat
 *      endpoint, not the base — strip it before the version check.
 *   3. Everything else takes the conventional /v1/responses suffix.
 *
 * Before 2026-10-25 each of the three call sites carried its own copy that
 * recognized only a literal `/v1` ending and blindly appended `/v1/responses`
 * to everything else — a `/v4` base produced the doubled path
 * `…/v4/v1/responses` (route-construction 404). The main process fixed the
 * same shape in 2026-10-23 (PR #94); this module extends the fix to the
 * renderer and keeps the three paths byte-identical by construction.
 */
export function buildOpenAIResponsesUrl(baseUrl: string, provider?: string): string {
  let normalized = baseUrl.trim().replace(/\/+$/, '');
  // DeepSeek's Responses endpoint lives at the host root without a version
  // prefix, matching https://api-docs.deepseek.com/zh-cn/guides/responses_api.
  // Strip a trailing /anthropic or /v1 so a base URL like
  // https://api.deepseek.com/anthropic resolves to the root responses path.
  const isDeepSeekHost = normalized.toLowerCase().includes('api.deepseek.com')
    || provider?.toLowerCase() === 'deepseek';
  if (isDeepSeekHost) {
    normalized = normalized.replace(/\/anthropic$/, '').replace(/\/v1$/, '');
  }

  const responsesPath = isDeepSeekHost ? '/responses' : '/v1/responses';
  if (!normalized) {
    return responsesPath;
  }
  if (normalized.endsWith('/responses') || normalized.endsWith(responsesPath)) {
    return normalized;
  }
  if (!isDeepSeekHost) {
    // Versioned bases (…/v1, …/v4 — e.g. Zhipu's /api/coding/paas/v4) mount
    // /responses directly, mirroring buildOpenAICompatibleChatCompletionsUrl's
    // versioned-base rule. The old code only recognized …/v1 and blindly
    // appended /v1/responses to everything else, producing doubled paths like
    // …/v4/v1/responses and …/v4/chat/completions/v1/responses for versioned
    // chat bases (route-construction 404s, 2026-10-23). A trailing
    // /chat/completions identifies the chat endpoint, not the base — strip it
    // first, the same way the DeepSeek branch strips /anthropic.
    const versioned = normalized.replace(/\/chat\/completions$/, '');
    if (/\/v\d+$/.test(versioned)) {
      return `${versioned}/responses`;
    }
  }
  return `${normalized}${responsesPath}`;
}
