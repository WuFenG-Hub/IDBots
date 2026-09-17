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
// Scope: chat-completions and responses routes. Chat-completions carries the
// family's own wire dialect (deepseek thinking, zai thinking). The Responses
// wire has no "disable" parameter — reasoning is opt-in by design — but for
// GLM that opt-in must be EXPLICIT: an undeclared model sends nothing and the
// gateway's server-side default decides whether the model thinks. z.ai
// flipped that default mid-2026-09-03 with no host change (A2A thread
// 0f81a549: turns ≤111 returned separate reasoning items, turns ≥112 none),
// and with no thinking channel GLM narrated its reply-or-skip deliberation
// into the visible text, which the A2A private-chat path then published
// on-chain verbatim (fix/a2a-private-chat-thinking-leak).
//
// Anthropic-Messages relays speak Claude's adaptive-thinking dialect: enabled
// rungs send `thinking: { type: 'adaptive' }` plus `output_config.effort`, and
// `off` sends the explicit `thinking: { type: 'disabled' }`.

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

// DeepSeek V4 family, bare ids (deepseek-flash, deepseek-v4-flash) and
// vendor-prefixed ids (deepseek/deepseek-flash) alike. The declaration
// mirrors the official DeepSeek profile shipped in pi-ai's own catalog
// (@earendil-works/pi-ai providers/data/deepseek.json): chat-completions
// `thinking` enable/disable + reasoning_effort low/high/max — the same ladder
// the first-party dsh-llm-deepseek adapter speaks natively. The V4.1 rename
// (`deepseek-v4-flash` → `deepseek-flash`, 2026-09-10) keeps the same wire
// dialect, so both id shapes match.
const DEEPSEEK_V4_PATTERN = /deepseek-(?:v4|flash)(?:[.\-_]|$)/i;

// `deepseek-chat` is the free-quota relay's (metaid-free) wire id for
// deepseek-v4-flash — the app's own legacy-model migration already treats it
// as the v4-flash alias (DEEPSEEK_LEGACY_MODEL_MIGRATION_MAP), and pi-ai's
// installed catalog only lists the v4 ids, so without this alias a relay
// route would materialize reasoning:false and the effort selector would be
// dead on the free model.
const DEEPSEEK_V4_LEGACY_CHAT_ID = 'deepseek-chat';

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

// GLM-4.5+ / GLM-5.x OpenAI-compatible endpoints use Z.AI's thinking wire:
// `thinking: { type: 'enabled' | 'disabled', clear_thinking: false }`. They
// do not use DeepSeek's reasoning_content replay contract and should not be
// sent a provider-default `reasoning_effort` field. Map every enabled UI rung
// to the one supported wire state and keep the explicit off state available.
const GLM_PATTERN = /^glm-(?:4\.[5-9](?:[.\-_].*)?|5(?:[.\-_].*)?|[6-9]\d*(?:[.\-_].*)?)/i;
const GLM_CHAT_COMPLETIONS_DECLARATION: DshModelReasoningDeclaration = {
  reasoningEfforts: { off: null, low: 'enabled', high: 'enabled', max: 'enabled' },
  compat: {
    thinkingFormat: 'zai',
    supportsReasoningEffort: false,
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
  },
};

// GLM behind an OpenAI Responses-compatible gateway (z.ai serves /v1/responses
// for the GLM line). Enabled rungs send `reasoning: { effort, summary }` plus
// the reasoning.encrypted_content include — exactly what pi-ai's
// openai-responses generator emits once the model declares reasoning — which
// streams the deliberation as separate reasoning_text deltas and keeps the
// message text clean (verified against api.z.ai 2026-09-07, streaming and
// non-streaming, with tools and ~200KB payloads). `off` cannot disable
// thinking on this wire (no disable parameter), so it keeps the send-nothing
// shape: off → null → absent from the thinkingLevelMap → provider default.
// Compat: only fields the RESPONSES_COMPAT_GATE offers are settable —
// supportsStore and the chat-completions dialect knobs are completions-only
// and fail plugin load on this wire.
const GLM_RESPONSES_DECLARATION: DshModelReasoningDeclaration = {
  reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'high' },
  compat: {
    supportsDeveloperRole: false,
  },
};

// GLM behind an Anthropic-Messages-compatible gateway (Volcengine Ark's
// coding/agent plans serve the GLM line over /v1/messages). The wire dialect
// is Claude's adaptive thinking: enabled rungs send
// `thinking: { type: 'adaptive', display: 'summarized' }` plus
// `output_config: { effort }`. Ark's accepted effort vocabulary is exactly
// low/medium/high/max — it 400s `xhigh` (cc-switch#2729, 2026-05-11) — which
// this ladder never emits. `off` keeps the shared send-nothing declaration;
// on this wire pi-ai's writer translates it into the explicit
// `thinking: { type: 'disabled' }` (thinkingLevelMap.off stays absent, and
// absent !== null). forceAdaptiveThinking is offered by the anthropic compat
// gate; without it pi-ai falls back to budget_tokens thinking, which Ark's
// GLM-serving endpoint does not document. Verified against pi-ai
// anthropic-messages streamSimple/buildParams (2026-09-17).
const GLM_ANTHROPIC_DECLARATION: DshModelReasoningDeclaration = {
  reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' },
  compat: {
    forceAdaptiveThinking: true,
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
  const bare = bareModelIdOf(modelId);
  if (DEEPSEEK_V4_PATTERN.test(bare) || bare.toLowerCase() === DEEPSEEK_V4_LEGACY_CHAT_ID) {
    if (apiFormat !== 'openai') return null;
    return DEEPSEEK_V4_CHAT_COMPLETIONS_DECLARATION;
  }
  if (GLM_PATTERN.test(bare)) {
    if (apiFormat === 'openai') return GLM_CHAT_COMPLETIONS_DECLARATION;
    if (apiFormat === 'responses') return GLM_RESPONSES_DECLARATION;
    return GLM_ANTHROPIC_DECLARATION;
  }
  return null;
}

const undeclaredEffortWarnedRoutes = new Set<string>();

/**
 * Warn-once text for a route whose configured reasoning effort cannot ride
 * the wire (the family is undeclared on this apiFormat), or null once the
 * route identity has already been reported this process. Without a
 * declaration the effort is silently ignored and the provider's server-side
 * default decides whether the model thinks — exactly the silence that let
 * the 2026-09-03 z.ai default flip leak deliberation on-chain for days. One
 * log line per route identity makes the next flip visible in cowork.log.
 */
export function undeclaredReasoningRouteWarning(input: {
  provider: string;
  model: string;
  apiFormat: 'openai' | 'responses' | 'anthropic';
  effort: string;
}): string | null {
  const key = `${input.provider}|${input.model}|${input.apiFormat}|${input.effort}`;
  if (undeclaredEffortWarnedRoutes.has(key)) return null;
  undeclaredEffortWarnedRoutes.add(key);
  return (
    `Reasoning effort "${input.effort}" is configured but cannot ride model "${input.model}" ` +
    `on the ${input.apiFormat} wire (provider "${input.provider}"): the family has no thinking ` +
    'declaration, so the effort is ignored and the provider server default decides whether the ' +
    'model thinks. Add a declaration in dshModelReasoning.ts if this model supports reasoning.'
  );
}
