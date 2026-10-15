import type { HotLayerItemKind } from '../coworkStore';

/** Trailing window the rosters rank on (design §6.3 P3.2). */
export const HOT_LAYER_UTILITY_WINDOW_DAYS = 30;
/** A newly hot item is protected from pruning this long. */
export const HOT_LAYER_GRACE_DAYS = 14;
/** Roster slots reserved for newcomers still inside the grace period. */
export const HOT_LAYER_FRESH_SLOTS = 1;
/** Audited hot exposure nights (trailing window) before pruning can strike. */
export const HOT_LAYER_PRUNE_MIN_EXPOSED_NIGHTS = 5;
/** Demotion cap per night (techniques + procedures share it). */
export const HOT_LAYER_PRUNE_MAX_PER_NIGHT = 2;
/** Re-entry lookback for an `unused` procedure's recall evidence. */
export const HOT_LAYER_REENTRY_WINDOW_DAYS = 14;
/** Audited applied nights required to re-enter the hot layer. */
export const HOT_LAYER_REENTRY_MIN_APPLIED_NIGHTS = 2;

const DAY_MS = 86_400_000;

/** One hot-layer item with its trailing-window usage evidence (RRSI P3). */
export interface HotLayerCandidate {
  key: string;
  kind: HotLayerItemKind;
  /** When the item entered the hot layer (ms). */
  hotSinceMs: number;
  /** Hot-layer usage stats fields over the window the caller chose. */
  appliedNights: number;
  exposedNights: number;
}

const byRank = <T extends HotLayerCandidate>(a: T, b: T): number =>
  b.appliedNights - a.appliedNights
  || b.hotSinceMs - a.hotSinceMs
  || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

const isFresh = (item: HotLayerCandidate, nowMs: number, graceDays: number): boolean =>
  nowMs - item.hotSinceMs < graceDays * DAY_MS;

/**
 * Utility ordering with a fresh slot (design §6.3 P3.2): applied evidence
 * first, then recency, with `freshSlots` roster positions reserved for the
 * newest items still inside the grace period — without a reserved slot a
 * newcomer could never earn exposure. The returned items keep `sorted` order.
 */
export function rankHotLayerItems<T extends HotLayerCandidate>(
  items: readonly T[],
  options: { cap: number; nowMs: number; freshSlots?: number; graceDays?: number },
): T[] {
  const cap = Math.floor(Number(options.cap));
  if (!Number.isFinite(cap) || cap <= 0) return [];
  const freshSlots = Math.max(0, Math.floor(options.freshSlots ?? HOT_LAYER_FRESH_SLOTS));
  const graceDays = options.graceDays ?? HOT_LAYER_GRACE_DAYS;
  const sorted = [...items].sort(byRank);
  const selected = new Set<T>(sorted.slice(0, Math.max(0, cap - freshSlots)));
  for (let slot = 0; slot < freshSlots && selected.size < cap; slot += 1) {
    const freshPick = sorted
      .filter((item) => !selected.has(item) && isFresh(item, options.nowMs, graceDays))
      .sort((a, b) => b.hotSinceMs - a.hotSinceMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))[0];
    const fallback = freshPick ?? sorted.find((item) => !selected.has(item));
    if (!fallback) break;
    selected.add(fallback);
  }
  for (const item of sorted) {
    if (selected.size >= cap) break;
    selected.add(item);
  }
  return sorted.filter((item) => selected.has(item));
}

/**
 * L1 pruning picks (design §6.3 P3.3): items past their grace period with at
 * least `minExposedNights` audited hot nights and zero applied nights — worst
 * exposure first, then the longest-standing. Capped per night; the caller
 * merges techniques and procedures into one list so the cap is shared.
 */
export function selectHotLayerDemotions<T extends HotLayerCandidate>(
  items: readonly T[],
  options: { nowMs: number; graceDays?: number; minExposedNights?: number; maxPerNight?: number },
): T[] {
  const graceDays = options.graceDays ?? HOT_LAYER_GRACE_DAYS;
  const minExposedNights = options.minExposedNights ?? HOT_LAYER_PRUNE_MIN_EXPOSED_NIGHTS;
  const maxPerNight = Math.max(0, options.maxPerNight ?? HOT_LAYER_PRUNE_MAX_PER_NIGHT);
  return items
    .filter((item) =>
      !isFresh(item, options.nowMs, graceDays)
      && item.exposedNights >= minExposedNights
      && item.appliedNights === 0)
    .sort((a, b) =>
      b.exposedNights - a.exposedNights
      || a.hotSinceMs - b.hotSinceMs
      || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, maxPerNight);
}

/**
 * Re-entry picks (design §6.3 P3.3): `unused` procedures the recall channel
 * proved applied often enough within the re-entry window. No cap — the ranked
 * roster still caps injection.
 */
export function selectHotLayerReentries<T extends HotLayerCandidate>(
  items: readonly T[],
  options?: { minAppliedNights?: number },
): T[] {
  const minAppliedNights = options?.minAppliedNights ?? HOT_LAYER_REENTRY_MIN_APPLIED_NIGHTS;
  return items
    .filter((item) => item.appliedNights >= minAppliedNights)
    .sort((a, b) =>
      b.appliedNights - a.appliedNights
      || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
