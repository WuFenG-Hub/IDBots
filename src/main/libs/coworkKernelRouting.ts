// Kernel routing for the DSH cutover (Phase 1 M5): decides, per turn, whether
// a cowork session runs on the Claude kernel (today's path, untouched) or the
// DSH kernel (dsh-runtime subprocess via DshKernel).
//
// Rollout shape (per the Phase 1 plan): opt-in flag + OpenAI-compatible
// providers first; anthropic-direct stays on the Claude kernel; a session that
// has already run on DSH stays on DSH (its session handle is stored with the
// `dsh:` prefix in cowork_sessions.claudeSessionId — no schema migration, the
// prefix is the kernel marker and the rest is the DSH session id).

export const DSH_SESSION_PREFIX = 'dsh:'

export type CoworkKernelChoice = 'claude' | 'dsh'

export interface KernelRoutingInput {
  /** Feature flag from app config (dshKernelEnabled). */
  enabled: boolean;
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
 * OpenAI-compatible apiTypes are DSH-eligible; 'anthropic' (direct Anthropic
 * protocol) stays on the Claude kernel during rollout.
 */
export function isDshEligibleApiType(apiType?: string | null): boolean {
  return apiType === 'openai' || apiType === 'responses';
}

export function resolveKernelChoice(input: KernelRoutingInput): CoworkKernelChoice {
  // Stickiness first: a session that already ran on DSH keeps its kernel even
  // if the flag is later disabled mid-conversation (its handle only makes
  // sense to the DSH runtime).
  if (isDshSessionHandle(input.sessionHandle)) return 'dsh';
  if (!input.enabled) return 'claude';
  return isDshEligibleApiType(input.apiType) ? 'dsh' : 'claude';
}
