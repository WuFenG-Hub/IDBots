export interface ResolveContinueSystemPromptInput {
  persistedSystemPrompt?: string | null;
  requestedSystemPrompt?: string;
  activeSkillIds?: string[];
  /**
   * Skill set the persisted prompt was built for (cowork_sessions.active_skill_ids).
   * Absent for callers that predate skill-set tracking; the policy then falls
   * back to comparing only the requested set against emptiness.
   */
  persistedActiveSkillIds?: string[];
}

/** Normalize a skill-id list to a deduplicated, order-free set signature. */
function normalizeSkillIds(input: unknown): string[] {
  const ids = Array.isArray(input)
    ? input.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  return [...new Set(ids)];
}

/** Set equality, order-insensitive — skill ordering must not affect the decision. */
function sameSkillSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id));
}

/**
 * Decide which system prompt a continued turn should use.
 *
 * The persisted prompt leads DeepSeek's cacheable prefix; rewriting it
 * mid-session resets the underlying SDK session and re-caches the whole
 * context. The renderer historically rebuilt the combined prompt on EVERY
 * send from the LIVE MetaApp/Skill catalogs, so any catalog change (e.g. a
 * bot publishing a new MetaApp) silently broke the prefix of every running
 * session. This policy keeps the persisted prompt unless the user made a
 * deliberate skill-set change:
 *
 * - no requested prompt                    -> persisted (caller decides)
 * - no persisted prompt                    -> requested (first real prompt)
 * - requested skill set == persisted set   -> persisted: the only possible
 *   byte difference is live-catalog drift, which must never touch the prefix
 * - requested skill set != persisted set   -> requested: a deliberate change
 *   (the runner labels the resulting miss 'system_prompt_changed')
 */
export function resolveContinueSystemPrompt(
  input: ResolveContinueSystemPromptInput
): string | undefined {
  const requestedSystemPrompt =
    typeof input.requestedSystemPrompt === 'string' && input.requestedSystemPrompt.trim()
      ? input.requestedSystemPrompt
      : undefined;
  if (!requestedSystemPrompt) {
    return undefined;
  }
  if (typeof input.persistedSystemPrompt !== 'string') {
    return requestedSystemPrompt;
  }

  const requestedIds = normalizeSkillIds(input.activeSkillIds);
  const persistedIds = normalizeSkillIds(input.persistedActiveSkillIds);
  return sameSkillSet(requestedIds, persistedIds)
    ? undefined
    : requestedSystemPrompt;
}
