/**
 * OpenCode Go ("Console Go") gateway headers — main-process side.
 *
 * The OpenCode Go gateway (https://opencode.ai/zen/go/v1, a $10/mo coding-model
 * subscription by Anomaly) requires coding-agent clients to send a stable
 * per-conversation session id in the `x-opencode-session` header so it can
 * route requests and reuse prompt caches. Requests without the header are
 * refused by the gateway:
 *
 *   "Error from provider (Console Go): Request is missing x-opencode-session
 *    and cannot be routed efficiently."
 *
 * See https://opencode.ai/docs/go/#where-can-i-use-it
 *
 * Every outbound LLM request builder in this repo that can target the gateway
 * merges these headers via buildOpenCodeGoHeaders(). Other providers get an
 * empty object and are completely untouched.
 */
import { randomUUID } from 'crypto';

const OPENCODE_GO_HOST = 'opencode.ai';

/** True when the given base URL / full request URL points at the OpenCode Go gateway. */
export function isOpenCodeGoBaseUrl(baseUrl?: string | null): boolean {
  if (!baseUrl) return false;
  const lower = baseUrl.toLowerCase();
  if (!lower.includes(OPENCODE_GO_HOST)) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === OPENCODE_GO_HOST || host.endsWith(`.${OPENCODE_GO_HOST}`);
  } catch {
    // Not a parseable absolute URL: fall back to a prefix/authority-style match.
    return lower.startsWith(`${OPENCODE_GO_HOST}`) || lower.startsWith(`://${OPENCODE_GO_HOST}`);
  }
}

/**
 * Build the OpenCode Go gateway headers for one outbound LLM request.
 *
 * `sessionId` should be a stable identifier for the ongoing conversation
 * (cowork session key, chat thread id, ...) so the gateway can apply prompt
 * caching across turns. When the caller has no conversation scope (one-shot
 * calls like a connectivity test), a fresh uuid is used — the gateway requires
 * the header to be present at all; stability only unlocks caching.
 */
export function buildOpenCodeGoHeaders(
  baseUrl?: string | null,
  sessionId?: string | null
): Record<string, string> {
  if (!isOpenCodeGoBaseUrl(baseUrl)) return {};
  const session = (sessionId && sessionId.trim()) || randomUUID();
  return { 'x-opencode-session': session };
}
