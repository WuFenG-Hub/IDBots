/**
 * Per-MetaBot A2A private-chat conversation limits.
 *
 * These knobs were previously hardcoded inside privateChatDaemon; they are now
 * stored on the metabots table (nullable columns; NULL means "use default")
 * and editable from the MetaBot edit panel's Chat Settings tab.
 */

/** Selectable max incoming turns per active A2A session before forcing "bye". */
export const A2A_MAX_INCOMING_TURNS_OPTIONS: readonly number[] = [20, 30, 50, 80, 100, 150, 200];
export const DEFAULT_A2A_MAX_INCOMING_TURNS = 30;

/** Selectable cooldown after an auto-bye before the conversation may reopen. */
export const A2A_BYE_COOLDOWN_MS_OPTIONS: readonly number[] = [
  60_000, // 1 min
  300_000, // 5 min
  600_000, // 10 min
  1_800_000, // 30 min
  3_600_000, // 60 min
];
export const DEFAULT_A2A_BYE_COOLDOWN_MS = 300_000;

export function normalizeA2AMaxIncomingTurns(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return A2A_MAX_INCOMING_TURNS_OPTIONS.includes(numeric) ? numeric : DEFAULT_A2A_MAX_INCOMING_TURNS;
}

export function normalizeA2AByeCooldownMs(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return A2A_BYE_COOLDOWN_MS_OPTIONS.includes(numeric) ? numeric : DEFAULT_A2A_BYE_COOLDOWN_MS;
}

/**
 * Closing-phase threshold derived from the max turns (historically 20 of 30).
 * The bot is nudged to wrap up once incoming turns pass ~2/3 of the limit.
 */
export function deriveA2AClosingPhaseTurns(maxIncomingTurns: number): number {
  return Math.max(1, Math.floor(normalizeA2AMaxIncomingTurns(maxIncomingTurns) * 2 / 3));
}
