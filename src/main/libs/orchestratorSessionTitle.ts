/**
 * Title generation helpers for orchestrator-delegated worker sessions.
 *
 * Before this module, delegation sessions were titled with a hardcoded
 * "[Orchestrator] skill-turn-<timestamp>" (or "Group-<id>-<timestamp>" for
 * group skill runs), which showed up in the session list as an opaque,
 * unfriendly name. Delegation titles now follow the same summarization logic
 * as regular Co-Worker sessions (generateSessionTitle) and carry a localized
 * prefix instead of the hardcoded English one.
 *
 * The app language is stored in the `app_config` kv entry ('zh' | 'en') and
 * is read via CoworkStore.getAppLanguage() — the same source the renderer
 * i18n service uses. This module stays dependency-free so it can be unit
 * tested with plain `node --test` without pulling in electron.
 */

export type AppLanguage = 'zh' | 'en';

/** Maximum length of the fallback title body when LLM summarization fails. */
export const FALLBACK_TITLE_MAX_LENGTH = 50;

/**
 * Localized prefix for orchestrator-delegated worker session titles.
 * zh → [编排任务], en → [Orchestration Task]. Follows the main-process
 * localization pattern (see trayManager.getLabels) reading the same
 * `app_config.language` value as the renderer i18n service.
 */
export function getOrchestratorTitlePrefix(language: AppLanguage): string {
  return language === 'en' ? '[Orchestration Task]' : '[编排任务]';
}

/**
 * Fallback title body used when LLM-based summarization fails.
 *
 * Delegation prompts are the `<twin_delegation>` XML envelope whose first
 * line is a tag — a naive "first line of the message" fallback would produce
 * garbage like "<twin_delegation>". Instead:
 *  1. extract the <objective> block when present (the delegation contract);
 *  2. otherwise use the first non-empty, non-tag line of the message;
 *  3. as a last resort return a neutral localized label.
 */
export function extractSessionTitleFallback(
  userMessage: string,
  language: AppLanguage,
  maxLen: number = FALLBACK_TITLE_MAX_LENGTH
): string {
  const objective = userMessage.match(/<objective>([\s\S]*?)<\/objective>/);
  // Prefer the <objective> block when it has real content; otherwise scan the
  // whole message so an empty <objective></objective> doesn't shadow it.
  const source =
    objective && (objective[1] ?? '').trim().length > 0 ? objective[1]! : userMessage;
  const candidate = source
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('<'));
  if (!candidate) {
    return language === 'en' ? 'Orchestration Task' : '编排任务';
  }
  if (candidate.length > maxLen) {
    return `${candidate.slice(0, maxLen)}…`;
  }
  return candidate;
}

/**
 * Compose the final orchestrator session title: "localized prefix + body".
 * `summary` is the LLM-generated one-sentence summary (may be null/empty when
 * summarization failed or returned nothing usable); the body then falls back
 * to extractSessionTitleFallback.
 */
export function buildOrchestratorSessionTitle(
  language: AppLanguage,
  summary: string | null | undefined,
  userMessage: string
): string {
  const body = (summary ?? '').trim() || extractSessionTitleFallback(userMessage, language);
  return `${getOrchestratorTitlePrefix(language)} ${body}`;
}
