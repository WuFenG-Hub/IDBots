/**
 * MetaTask protocol constants.
 *
 * H_ACT: the #8/#9 vote-gate switch point (engine ruling, 2026-09-16) —
 * frozen forever, do not change. NOTE: the chain passed this height (v1.2.1
 * published at chain height 191204); the gates are LIVE for new votes.
 * H_ACT2: the v1.2 feature switch point — published in the v1.2.1
 * registration body (pin cbae49e0…, announced 2026-09-27, activation
 * announcement pin c9ded493…). Round block height 191500.
 */
export const METATASK_PROTOCOL_ROOT = '/protocols/metatask';

export const METATASK_EVENT_PATHS = [
  'task',
  'tree',
  'spec',
  'claim',
  'release',
  'submission',
  'verify',
  'amend',
  'challenge',
] as const;

export type MetaTaskEventPath = (typeof METATASK_EVENT_PATHS)[number];

/** Engine-ruled switch for the #8/#9 vote gates. Frozen. */
export const H_ACT = 190_000;
/** v1.2 feature gate — published in the v1.2.1 registration body. */
export const H_ACT2: number | null = 191_500;

export const hAct2Or = (value: number | null | undefined): number =>
  typeof value === 'number' && value >= 0 ? value : Number.POSITIVE_INFINITY;

/** Settlement constants (protocol text §11 — deliberately not payload fields). */
export const SUBMITTER_SHARE_BP_DEFAULT = 8000;
export const SUBMITTER_SHARE_BP_MIN = 6000;
export const SUBMITTER_SHARE_BP_MAX = 9000;
export const REVIEWER_ACCURACY_FLOOR_BP = 2500;
export const CHALLENGE_TTL_DAYS_DEFAULT = 14;

export const ENGINE_ALGO_VERSION = 'idbots-metatask-engine/1.2.1';
