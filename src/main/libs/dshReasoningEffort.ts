// Map IDBots cowork effort/thinking controls onto DSH ReasoningEffortId.
// The Claude path already sends `effort` + `thinking` on every query; DSH
// session/ensure historically ignored both, so providers kept their own
// default regardless of the UI selector.
//
// Official DeepSeek rides the first-party dsh-llm-deepseek adapter
// ('deepseek-official' route), which owns a native off/low/high/max ladder on
// the chat-completions wire and validates it itself. Product mapping (aligned
// to that ladder, 2026-08-19): 快速→off (thinking disabled), 标准→low,
// 深度→high, 极限→max. The value rides session/ensure each turn.
//
// Everything else stays on the pi-ai route, where effort is NOT passed:
// pi-ai models' thinking keeps the provider default (the historical behavior
// for non-deepseek providers).

const DSH_REASONING_EFFORTS = new Set([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

export type DshReasoningEffortDialect = 'deepseek-native' | 'generic';

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
  if (dialect === 'deepseek-native') {
    // The dsh-llm-deepseek adapter ladder (chat-completions wire):
    //   快速 / low / minimal → off    (thinking disabled)
    //   标准 / medium        → low
    //   深度 / high          → high
    //   极限 / max / xhigh   → max
    if (normalized === 'low' || normalized === 'minimal') return 'off';
    if (normalized === 'medium') return 'low';
    if (normalized === 'high') return 'high';
    if (normalized === 'max' || normalized === 'xhigh') return 'max';
  }
  if (DSH_REASONING_EFFORTS.has(normalized)) return normalized;
  return undefined;
}
