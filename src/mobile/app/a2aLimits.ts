/**
 * Mobile mirror of the A2A chat-limit option sets (UE rework 2026-10-29, A5).
 *
 * The values MUST stay identical to `src/main/services/a2aChatLimits.ts` —
 * that file deliberately lives in the main-process tree and must never be
 * imported into the mobile bundle (bundle-budget rule, REQ-E-19), so the
 * edit form mirrors the arrays here and `tests/mobileA2aLimits.test.ts`
 * asserts the two modules stay in lockstep.
 */

export const A2A_MAX_INCOMING_TURNS_OPTIONS: readonly number[] = [20, 30, 50, 80, 100, 150, 200];
export const DEFAULT_A2A_MAX_INCOMING_TURNS = 50;

export const A2A_BYE_COOLDOWN_MS_OPTIONS: readonly number[] = [
  60_000, // 1 min
  300_000, // 5 min
  600_000, // 10 min
  1_800_000, // 30 min
  3_600_000, // 60 min
];
export const DEFAULT_A2A_BYE_COOLDOWN_MS = 300_000;

/** "1 / 5 / 10 / 30 / 60" — the labels render the unit via i18n. */
export function cooldownMinutes(ms: number): number {
  return Math.round(ms / 60_000);
}

/** Canvas geometry for the avatar picker: largest w×h that fits maxEdge. */
export function fitInside(width: number, height: number, maxEdge: number): { width: number; height: number } {
  if (width <= 0 || height <= 0 || !Number.isFinite(width) || !Number.isFinite(height)) {
    return { width: maxEdge, height: maxEdge };
  }
  if (width <= maxEdge && height <= maxEdge) return { width, height };
  const scale = Math.min(maxEdge / width, maxEdge / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
