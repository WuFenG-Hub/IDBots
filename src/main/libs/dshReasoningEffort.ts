// Map IDBots cowork effort/thinking controls onto DSH ReasoningEffortId.
// The Claude path already sends `effort` + `thinking` on every query; DSH
// session/ensure historically ignored both, so providers kept their own
// default regardless of the UI selector.
//
// Official DeepSeek rides the first-party dsh-llm-deepseek adapter
// ('deepseek-official' route), which owns a native off/low/high/max ladder on
// the chat-completions wire and validates it itself. Since 2026-08-19 the
// app-wide effort vocabulary IS that ladder (see llmEffort.ts), so the four
// canonical values pass through one-to-one. Legacy five-step values
// (快速=low, 标准=medium, xhigh) can still arrive here from older stores and
// keep their historical alignment: low/minimal→off, medium→low, xhigh→max.
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
    // Canonical ladder (llmEffort.ts): identity mapping —
    //   off → off, low → low, high → high, max → max.
    // Legacy five-step values keep their historical alignment:
    //   minimal → off, medium → low, xhigh → max.
    if (normalized === 'off' || normalized === 'low' || normalized === 'high' || normalized === 'max') {
      return normalized;
    }
    if (normalized === 'minimal') return 'off';
    if (normalized === 'medium') return 'low';
    if (normalized === 'xhigh') return 'max';
    return undefined;
  }
  if (DSH_REASONING_EFFORTS.has(normalized)) return normalized;
  return undefined;
}
