// Reasoning capability declarations for model families the pi-ai installed
// catalog does not describe.
//
// dsh-llm-pi-ai materializes a route model's reasoning capability from
// (1) an explicit `reasoningEfforts` declaration on the model entry, else
// (2) the installed catalog entry with the same model id, else
// (3) `reasoning: false`.
// Custom providers — any gateway pi-ai has no catalog file for (commandcode,
// private relays, …) — always land in case 3, so a reasoning-capable model
// served behind an arbitrary OpenAI-compatible endpoint gets NO thinking
// control at all: the effort selector's "off" sends nothing and the upstream
// default (thinking on) applies. The declaration must therefore ride the
// MODEL's identity — its family's own wire dialect — not the provider that
// happens to serve it.
//
// Scope: chat-completions routes only. The Responses wire has no "disable"
// parameter — reasoning is opt-in by design, so "off" already means "send
// nothing" there regardless of the gateway default. Anthropic-format relays
// speak a different thinking dialect (out of scope here).

/** Wire declarations dsh-llm-pi-ai accepts on a route model entry. */
export interface DshModelReasoningDeclaration {
  /**
   * UI level → wire value. `null` on `off` keeps `off` absent from the
   * materialized thinkingLevelMap, which pi-ai reads as "supported — send
   * nothing"; the deepseek thinkingFormat branch then emits the explicit
   * `thinking: { type: 'disabled' }`. Undeclared levels (minimal / medium /
   * xhigh) materialize as unsupported, mirroring the official profile.
   */
  reasoningEfforts: Record<string, string | null>;
  compat: Record<string, unknown>;
}

// DeepSeek V4 family, bare ids (deepseek-v4-flash) and vendor-prefixed ids
// (deepseek/deepseek-v4-flash) alike. The declaration mirrors the official
// DeepSeek profile shipped in pi-ai's own catalog
// (@earendil-works/pi-ai providers/data/deepseek.json): chat-completions
// `thinking` enable/disable + reasoning_effort low/high/max — the same ladder
// the first-party dsh-llm-deepseek adapter speaks natively.
const DEEPSEEK_V4_PATTERN = /deepseek-v4(?:[.\-_]|$)/i;

const DEEPSEEK_V4_CHAT_COMPLETIONS_DECLARATION: DshModelReasoningDeclaration = {
  reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' },
  compat: {
    thinkingFormat: 'deepseek',
    supportsReasoningEffort: true,
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
    requiresReasoningContentOnAssistantMessages: true,
  },
};

/** Bare model id: drop any vendor prefix ("deepseek/deepseek-v4-flash" → "deepseek-v4-flash"). */
const bareModelIdOf = (modelId: string): string => {
  const trimmed = modelId.trim();
  const segments = trimmed.split('/');
  return segments[segments.length - 1] || trimmed;
};

/**
 * Reasoning declaration for a model on a non-native DSH route, or null when
 * the family is unknown — the model then keeps the provider default, and the
 * turn layer must NOT send effort (an undeclared reasoning:false model would
 * reject any non-off effort outright).
 */
export function dshModelReasoningDeclaration(
  modelId: string,
  apiFormat: 'openai' | 'responses' | 'anthropic',
): DshModelReasoningDeclaration | null {
  if (apiFormat !== 'openai') return null;
  const bare = bareModelIdOf(modelId);
  if (DEEPSEEK_V4_PATTERN.test(bare)) return DEEPSEEK_V4_CHAT_COMPLETIONS_DECLARATION;
  return null;
}
