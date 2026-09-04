/**
 * Risk-tiered auto-approval for AskUserQuestion under full-trust mode.
 *
 * In `bypassPermissions` (完全信任) the agent may mark a confirmation
 * question as low-risk by setting its `header` to `LOW_RISK_QUESTION_HEADER`.
 * Such questions are answered automatically with their first option and the
 * interactive modal never opens. Any question without the marker (or with
 * multi-select, which auto-answers could not faithfully represent) keeps
 * routing to the interactive confirmation flow.
 *
 * The tiering only activates under `bypassPermissions`; other permission
 * modes ignore the marker entirely, so the delete-safety confirmation UI
 * stays reachable everywhere else.
 */

export const LOW_RISK_QUESTION_HEADER = 'auto-confirm';

/**
 * Build auto-answers for an AskUserQuestion payload when every question is
 * explicitly marked low-risk and single-select. Returns null when the payload
 * is not eligible, in which case the caller must keep the interactive flow.
 */
export const tryAutoAnswerLowRiskQuestion = (
  resolvedInput: unknown,
): Record<string, string> | null => {
  if (!resolvedInput || typeof resolvedInput !== 'object') {
    return null;
  }
  const rawQuestions = (resolvedInput as Record<string, unknown>).questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    return null;
  }

  const answers: Record<string, string> = {};
  for (const rawQuestion of rawQuestions) {
    if (!rawQuestion || typeof rawQuestion !== 'object') {
      return null;
    }
    const question = rawQuestion as Record<string, unknown>;
    if (question.header !== LOW_RISK_QUESTION_HEADER) {
      return null;
    }
    // Multi-select auto-answers could mismatch the agent's intent; keep the
    // interactive flow for those.
    if (question.multiSelect) {
      return null;
    }
    if (typeof question.question !== 'string' || !question.question.trim()) {
      return null;
    }
    const options = Array.isArray(question.options) ? question.options : [];
    const firstOption = options.find(
      (option): option is Record<string, unknown> =>
        !!option
        && typeof option === 'object'
        && typeof (option as Record<string, unknown>).label === 'string'
        && Boolean((option as Record<string, unknown>).label),
    );
    if (!firstOption) {
      return null;
    }
    answers[question.question] = String(firstOption.label);
  }

  return answers;
};

/**
 * Recommended-option resolution for AskUserQuestion prompts that go
 * unanswered (the 60s timeout path). The tool schema tells the model to put
 * the recommended choice first and append "(Recommended)" to its label, so
 * an explicit marker wins and the first labeled option is the fallback
 * default. Returns null when the question carries no usable option — the
 * caller must treat that question as unanswered.
 */
const RECOMMENDED_OPTION_MARKERS = [
  /[(（]\s*recommended\s*[)）]/i,
  /[(（]\s*推荐\s*[)）]/,
];

export const pickRecommendedOptionLabel = (options: unknown): string | null => {
  if (!Array.isArray(options)) {
    return null;
  }
  const labels = options
    .map((option) => (option && typeof option === 'object'
      ? (option as Record<string, unknown>).label
      : null))
    .filter((label): label is string => typeof label === 'string' && label.trim().length > 0);
  if (labels.length === 0) {
    return null;
  }
  const marked = labels.find((label) => RECOMMENDED_OPTION_MARKERS.some((pattern) => pattern.test(label)));
  return marked ?? labels[0];
};
