/**
 * Two-tier MetaWeb prompt guidance (perf/dsh-agent-speed, design:
 * docs/design/2026-09-27-dsh-prompt-surface-lazy-injection.md — decisions
 * 1A/2A/3A approved 2026-09-27).
 *
 * Tier 0 (always mounted): the compact MetaWeb worldview + chain-id rules —
 * enough for the model to know MetaWeb exists, cite correctly, and route to
 * the mounted tools, whose descriptions are self-explanatory.
 *
 * Tier 1 (deep sections): the learning-loop + Q&A participation prose. In
 * 'tiered' mode (the default) these ride only AFTER the session actually
 * used a MetaWeb tool for the first time; the next turn's session/ensure
 * injects them once per SDK session generation (systemPromptUpdate
 * 'in-history' keeps the one-time injection cache-friendly). Sessions that
 * never touch MetaWeb never pay for the deep prose.
 *
 * 'full' restores the pre-tiering behavior (all sections every turn) and
 * 'compact' never mounts the deep sections — both are escape hatches.
 */

export type MetawebPromptMode = 'tiered' | 'compact' | 'full';
export type MetawebPromptTier = 0 | 1;

/** Host-bridged tools whose call proves the session is actively using
 *  MetaWeb — the Tier-0 → Tier-1 trigger. Memory/knowledge tools are
 *  deliberately NOT triggers: they are bot-local surfaces, not MetaWeb
 *  reads/writes. */
export const METAWEB_DEEP_SECTION_TOOLS: ReadonlySet<string> = new Set([
  // learning / content
  'search_metaweb',
  'read_metaweb_pin',
  'read_metaweb_pins_batch',
  'metaweb_pin_versions',
  'metaprotocol_registry',
  'agentpedia_challenge',
  // publishing
  'post_simplenote',
  'post_simplequestion',
  'post_simpleanswer',
  'post_buzz',
  'like_pin',
  'comment_pin',
  'upload_file',
  // Q&A community
  'search_qa',
  'list_latest_questions',
  'get_question_answers',
  // social
  'search_social_posts',
  'social_post_detail',
  'social_post_comments',
  // raw indexer
  'omni_read',
  'omni_cast',
]);

export function shouldIncludeMetawebDeepSections(
  mode: MetawebPromptMode,
  tier: MetawebPromptTier,
): boolean {
  if (mode === 'full') return true;
  if (mode === 'compact') return false;
  return tier >= 1;
}

/** Monotonic tier transition: once a session reached Tier 1 it stays there
 *  (no flapping on later non-MetaWeb turns). */
export function nextMetawebPromptTier(
  current: MetawebPromptTier,
  calledToolName: string,
): MetawebPromptTier {
  return current === 1 || METAWEB_DEEP_SECTION_TOOLS.has(calledToolName)
    ? 1
    : current;
}
