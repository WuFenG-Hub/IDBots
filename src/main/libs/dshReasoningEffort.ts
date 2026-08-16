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

const DSH_REASONING_EFFORTS = new Set([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

export type DshReasoningEffortDialect = 'deepseek' | 'generic';

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
    // Official DeepSeek wire is only off | high | max. Map the cowork UI
    // onto those three so the selector actually changes the request:
    //   快速 / low / minimal → off (thinking disabled)
    //   标准 / medium        → high (same as 深度; the API has no middle)
    //   深度 / high          → high
    //   极限 / max           → max
    if (normalized === 'low' || normalized === 'minimal') return 'off';
    if (normalized === 'medium') return 'high';
  }
  if (DSH_REASONING_EFFORTS.has(normalized)) return normalized;
  return undefined;
}
