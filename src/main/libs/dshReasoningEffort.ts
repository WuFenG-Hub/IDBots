// Map IDBots cowork effort/thinking controls onto DSH/pi-ai ReasoningEffortId.
// The Claude path already sends `effort` + `thinking` on every query; DSH
// session/ensure historically ignored both, so DeepSeek kept its provider
// default (thinking ON, no reasoning_effort) regardless of the UI selector.
//
// DeepSeek's official chat-completions wire only accepts off | high | max.
// Passing the UI's 快速 (`low`) through as `low` used to alias onto wire
// `high` (thinking ON) — the same spelling as 深度 — so Fast/Deep/Max all
// felt identical. 快速's copy is "least thinking, fastest response", which
// on this API is thinking disabled (`off`).
//
// The Responses wire (the current default route) takes none | low | medium |
// high | max on the reasoning toggle, and pi-ai FORCES `none` when no effort
// rides the request — without an explicit mapping the UI selector silently ran
// every turn with thinking disabled. Product mapping (2026-08): 快速→none,
// 标准→low, 深度→medium, 极限→high (wire max declared but deliberately unused).
//
// These low/medium levels are only requestable because the runtime config
// declares DEEPSEEK_RESPONSES_REASONING_EFFORTS on the generated model entries:
// pi-ai's builtin catalog pins low/medium to null for deepseek models, and
// without the declaration the runtime rejects them with
// UNSUPPORTED_REASONING_EFFORT before the request leaves the process (the
// 2026-08-18 标准-crash on a fresh V4 Pro session).

const DSH_REASONING_EFFORTS = new Set([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

export type DshReasoningEffortDialect = 'deepseek' | 'deepseek-responses' | 'generic';

export function mapDshReasoningEffort(
  effort: string | null | undefined,
  thinking?: { type?: string } | null,
  dialect: DshReasoningEffortDialect = 'generic',
): string | undefined {
  if (thinking?.type === 'disabled') return 'off';
  if (effort == null) return undefined;
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'none' || normalized === 'disabled') return 'off';
  if (dialect === 'deepseek') {
    // Official DeepSeek chat-completions wire is only off | high | max. Map
    // the cowork UI onto those three so the selector actually changes the
    // request:
    //   快速 / low / minimal → off (thinking disabled)
    //   标准 / medium        → high (same as 深度; the API has no middle)
    //   深度 / high          → high
    //   极限 / max           → max
    if (normalized === 'low' || normalized === 'minimal') return 'off';
    if (normalized === 'medium') return 'high';
  }
  if (dialect === 'deepseek-responses') {
    // DeepSeek Responses reasoning toggle. The product mapping shifts the
    // whole UI ladder one notch down so every level is a real wire value:
    //   快速 / low / minimal → off    (pi-ai omits effort → wire none)
    //   标准 / medium        → low
    //   深度 / high          → medium
    //   极限 / max / xhigh   → high   (wire max is declared and legal, but the
    //                                 product ladder tops out at high)
    if (normalized === 'low' || normalized === 'minimal') return 'off';
    if (normalized === 'medium') return 'low';
    if (normalized === 'high') return 'medium';
    if (normalized === 'max' || normalized === 'xhigh') return 'high';
  }
  if (DSH_REASONING_EFFORTS.has(normalized)) return normalized;
  return undefined;
}
