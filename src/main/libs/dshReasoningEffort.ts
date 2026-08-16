// Map IDBots cowork effort/thinking controls onto DSH/pi-ai ReasoningEffortId.
// The Claude path already sends `effort` + `thinking` on every query; DSH
// session/ensure historically ignored both, so DeepSeek kept its provider
// default (thinking ON, no reasoning_effort) regardless of the UI selector.

const DSH_REASONING_EFFORTS = new Set([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

export function mapDshReasoningEffort(
  effort: string | null | undefined,
  thinking?: { type?: string } | null,
): string | undefined {
  if (thinking?.type === 'disabled') return 'off';
  if (effort == null) return undefined;
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'none' || normalized === 'disabled') return 'off';
  if (DSH_REASONING_EFFORTS.has(normalized)) return normalized;
  return undefined;
}
