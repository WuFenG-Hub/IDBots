/**
 * Recommended-option resolution for AskUserQuestion prompts that go
 * unanswered (the per-question timeout path). The tool schema tells the model
 * to put the recommended choice first and append "(Recommended)" to its
 * label, so an explicit marker wins and the first labeled option is the
 * fallback default. Returns null when the question carries no usable option —
 * the caller must treat that question as unanswered.
 *
 * Lives in main/shared so both the main-process timeout backstop and the
 * renderer question wizard resolve the exact same fallback.
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
