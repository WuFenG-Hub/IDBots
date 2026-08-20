// App-wide LLM reasoning-effort vocabulary and its per-wire mappings.
//
// The UI exposes a single four-step ladder — off / low / high / max — matching
// the first-party dsh-llm-deepseek adapter's native ladder. Every persistence
// surface (MetaBot brain fields, cowork session effort) stores values from
// this vocabulary; `null` means "follow the model default".
//
// The renderer mirror of the vocabulary lives in
// src/renderer/services/modelCatalog.ts (LlmEffortLevel) — keep the two in
// sync when the ladder changes.
//
// History: the pre-2026-08 effort selector used a five-value ladder
// (null/low/medium/high/max). Unambiguous leftover tokens (medium / minimal /
// xhigh) still convert at read boundaries. Canonical `low` must NOT convert
// to `off`: the current picker uses `low` for light thinking, and rewriting
// it as `off` made the Low choice display and run as Off.

export type LlmEffortLevel = 'off' | 'low' | 'high' | 'max';

export const LLM_EFFORT_LEVELS: readonly LlmEffortLevel[] = ['off', 'low', 'high', 'max'];

const LEVEL_SET = new Set<string>(LLM_EFFORT_LEVELS);

/** True when `value` is one of the four canonical effort levels. */
export function isLlmEffortLevel(value: unknown): value is LlmEffortLevel {
  return typeof value === 'string' && LEVEL_SET.has(value);
}

/**
 * Map a leftover five-step effort token onto the current four-step ladder.
 * Canonical off/low/high/max pass through unchanged — `low` is a current
 * picker rung ("light thinking"), not a synonym for "thinking off".
 *
 *   null → null (auto / model default)
 *   off / low / high / max → themselves
 *   minimal / none / disabled → 'off'
 *   medium → 'low'
 *   xhigh → 'max'
 */
export function convertLegacyEffortLevel(value: unknown): LlmEffortLevel | null {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
  if (isLlmEffortLevel(normalized)) return normalized;
  switch (normalized) {
    case 'minimal':
    case 'none':
    case 'disabled':
      return 'off';
    case 'medium':
      return 'low';
    case 'xhigh':
      return 'max';
    default:
      return null;
  }
}

/**
 * Accept either vocabulary at a persistence boundary and normalize onto the
 * four-step ladder. Canonical values (including `low`) pass through.
 */
export function toLlmEffortLevel(value: unknown): LlmEffortLevel | null {
  return convertLegacyEffortLevel(value);
}

/**
 * Effort for the Claude Agent SDK query options. The SDK accepts
 * low/medium/high/xhigh/max and silently downgrades for models without the
 * higher steps, so max maps losslessly. `off` disables thinking instead of
 * picking an effort step.
 */
export function effortForClaudeSdk(
  effort: LlmEffortLevel | null | undefined,
): { effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; thinking?: { type: 'enabled' | 'disabled' } } {
  switch (effort ?? null) {
    case 'off':
      return { thinking: { type: 'disabled' } };
    case 'low':
      return { effort: 'low' };
    case 'high':
      return { effort: 'high' };
    case 'max':
      return { effort: 'max', thinking: { type: 'enabled' } };
    default:
      return {};
  }
}

/**
 * Effort for the Anthropic Messages wire (thinking + budget_tokens). Budgets
 * follow the tiers the direct-call path already used (10k default), with a
 * smaller low tier and a larger max tier. `off` disables thinking.
 */
export function effortForAnthropicWire(
  effort: LlmEffortLevel | null | undefined,
): { thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'disabled' } } {
  switch (effort ?? null) {
    case 'off':
      return { thinking: { type: 'disabled' } };
    case 'low':
      return { thinking: { type: 'enabled', budget_tokens: 4000 } };
    case 'high':
      return { thinking: { type: 'enabled', budget_tokens: 10000 } };
    case 'max':
      return { thinking: { type: 'enabled', budget_tokens: 32000 } };
    default:
      return {};
  }
}

/**
 * Effort for OpenAI-compatible reasoning_effort. The wire only has
 * low/medium/high (plus minimal on some models), so max caps at high and off
 * omits the parameter entirely (providers keep their default behavior).
 */
export function effortForOpenAiWire(
  effort: LlmEffortLevel | null | undefined,
): 'low' | 'medium' | 'high' | undefined {
  switch (effort ?? null) {
    case 'off':
      return undefined;
    case 'low':
      return 'low';
    case 'high':
      return 'high';
    case 'max':
      return 'high';
    default:
      return undefined;
  }
}
