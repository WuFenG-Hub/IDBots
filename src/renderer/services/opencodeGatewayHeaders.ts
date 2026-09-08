/**
 * OpenCode Go ("Console Go") gateway headers — renderer-side mirror of
 * src/main/libs/opencodeGatewayHeaders.ts (renderer code must not import main).
 *
 * The gateway refuses requests that omit `x-opencode-session`
 * ("Request is missing x-opencode-session and cannot be routed efficiently"),
 * see https://opencode.ai/docs/go/#where-can-i-use-it
 */

const OPENCODE_GO_HOST = 'opencode.ai';

function randomSessionId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  return `oc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** True when the provider key is the built-in 'opencode' entry. */
export function isOpenCodeGoProvider(providerKey?: string | null): boolean {
  return providerKey?.trim().toLowerCase() === 'opencode';
}

/** True when the base URL points at the OpenCode Go gateway. */
export function isOpenCodeGoBaseUrl(baseUrl?: string | null): boolean {
  if (!baseUrl) return false;
  const lower = baseUrl.toLowerCase();
  if (!lower.includes(OPENCODE_GO_HOST)) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === OPENCODE_GO_HOST || host.endsWith(`.${OPENCODE_GO_HOST}`);
  } catch {
    return lower.startsWith(`${OPENCODE_GO_HOST}`) || lower.startsWith(`://${OPENCODE_GO_HOST}`);
  }
}

/**
 * Headers to merge into an outbound LLM request when it targets the OpenCode
 * Go gateway. Returns an empty object for every other provider/base URL.
 */
export function buildOpenCodeGoSessionHeaders(
  providerKey?: string | null,
  baseUrl?: string | null
): Record<string, string> {
  if (!isOpenCodeGoProvider(providerKey) && !isOpenCodeGoBaseUrl(baseUrl)) {
    return {};
  }
  return { 'x-opencode-session': randomSessionId() };
}
