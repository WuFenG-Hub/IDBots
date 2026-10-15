/**
 * Agent-procedure probation (RRSI P2, design §6.2 P2.2): a procedure the bot
 * saves at runtime (origin `agent`, including surf-learned ones) enters
 * recall-only probation instead of the always-on hot layer; the existing
 * dream validation gate decides when it becomes hot. Pure module — constants,
 * normalization, and the host-template description for probation drafts.
 */

import { truncateUtf16Units } from './llmSafeText';

export const PROCEDURE_HOT_REASONS = [
  'probation',
  'gate_rejected',
  'demoted',
  'rollback',
  'unused',
  'situational',
] as const;

export type ProcedureHotReason = (typeof PROCEDURE_HOT_REASONS)[number];

/** Narrow an unknown DB/config value to a hot reason; null for anything else. */
export function normalizeProcedureHotReason(value: unknown): ProcedureHotReason | null {
  return typeof value === 'string' && (PROCEDURE_HOT_REASONS as readonly string[]).includes(value)
    ? value as ProcedureHotReason
    : null;
}

const PROBATION_DESCRIPTION_MAX_CHARS = 1200;

/**
 * Host-template description for a probation draft: trigger, ordered steps,
 * pitfalls, and the MetaWeb pin ids the procedure was learned from. The pin
 * ids ride the description so the chain-evidence digest can verify them.
 * Truncated to 1200 chars; never any free-form LLM text.
 */
export function buildProbationDraftDescription(input: {
  triggerText: string;
  steps: string[];
  pitfalls: string[];
  sourcePinIds: string[];
}): string {
  const lines: string[] = [`触发:${input.triggerText}`];
  if (input.steps.length > 0) lines.push(`步骤:${input.steps.join(' → ')}`);
  if (input.pitfalls.length > 0) lines.push(`避免:${input.pitfalls.join(';')}`);
  if (input.sourcePinIds.length > 0) lines.push(`来源 pin:${input.sourcePinIds.join(', ')}`);
  const text = lines.join('\n');
  return text.length > PROBATION_DESCRIPTION_MAX_CHARS
    ? `${truncateUtf16Units(text, PROBATION_DESCRIPTION_MAX_CHARS - 1).trim()}…`
    : text;
}
