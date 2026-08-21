// Kernel routing for local cowork: DSH is the only kernel. The Claude Agent
// SDK local path is retired so dual-kernel fallback cannot hide DSH bugs.
//
// OpenAI-compatible providers go to DSH. Anthropic Messages (`apiType:
// 'anthropic'`) is unavailable — DSH does not speak that wire, and there is
// no Claude SDK fallback. A session that already ran on DSH stays on DSH
// (its handle is stored with the `dsh:` prefix in cowork_sessions.claudeSessionId).

export const DSH_SESSION_PREFIX = 'dsh:'

export type CoworkKernelChoice = 'dsh' | 'unavailable'

export interface KernelRoutingInput {
  /** Resolved provider apiType for this turn ('anthropic' | 'openai' | 'responses'). */
  apiType?: string | null;
  /** Stored session handle (claudeSessionId) — `dsh:` prefix pins the kernel. */
  sessionHandle?: string | null;
}

export function isDshSessionHandle(handle: string | null | undefined): boolean {
  return typeof handle === 'string' && handle.startsWith(DSH_SESSION_PREFIX);
}

export function dshSessionIdOf(handle: string | null | undefined): string | null {
  return isDshSessionHandle(handle) ? handle.slice(DSH_SESSION_PREFIX.length) : null;
}

export function makeDshSessionHandle(dshSessionId: string): string {
  return DSH_SESSION_PREFIX + dshSessionId;
}

/**
 * OpenAI-compatible apiTypes are DSH-eligible. Anthropic Messages is not.
 */
export function isDshEligibleApiType(apiType?: string | null): boolean {
  return apiType === 'openai' || apiType === 'responses';
}

/** Anthropic Messages protocol — no DSH adapter, Claude SDK fallback retired. */
export function isAnthropicDirectUnavailable(apiType?: string | null): boolean {
  return apiType === 'anthropic';
}

export function resolveKernelChoice(input: KernelRoutingInput): CoworkKernelChoice {
  // Stickiness first: a session that already ran on DSH keeps its kernel
  // (its handle only makes sense to the DSH runtime).
  if (isDshSessionHandle(input.sessionHandle)) return 'dsh';
  if (isAnthropicDirectUnavailable(input.apiType)) return 'unavailable';
  return 'dsh';
}
