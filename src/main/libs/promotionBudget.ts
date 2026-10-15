/**
 * Annealed nightly promotion budget (RRSI P2, design §6.2 P2.1): how many
 * validated capability drafts may harden into procedure memory per night.
 *
 * A new bot promotes up to `max` per night (its lessons are mostly novel);
 * as the bot accumulates non-empty dream nights the budget anneals down to
 * `min` along a raised cosine, so a mature bot changes its habits slowly.
 * Pure module: time and history arrive as inputs.
 */

export const PROMOTION_BUDGET_MAX = 3;
export const PROMOTION_BUDGET_MIN = 1;
export const PROMOTION_BUDGET_ANNEAL_NIGHTS = 60;

/**
 * Budget for the night after `completedNights` completed non-empty dream
 * nights (nights strictly before the dreamed date). Non-finite or negative
 * inputs read as "no history yet". The result is an integer in [min, max].
 */
export function promotionBudgetForNight(
  completedNights: number,
  options?: { max?: number; min?: number; annealNights?: number },
): number {
  const max = Math.floor(Number(options?.max ?? PROMOTION_BUDGET_MAX));
  const min = Math.floor(Number(options?.min ?? PROMOTION_BUDGET_MIN));
  const annealNights = Math.floor(Number(options?.annealNights ?? PROMOTION_BUDGET_ANNEAL_NIGHTS));
  const t = Number.isFinite(completedNights) && completedNights > 0 ? completedNights : 0;
  const tt = Math.min(Math.floor(t), annealNights);
  const value = min + (max - min) * 0.5 * (1 + Math.cos(Math.PI * tt / annealNights));
  return Math.max(min, Math.ceil(value - 1e-9));
}
