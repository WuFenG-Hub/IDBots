export const PREFERENCE_PROTOCOL_ROOT = '/protocols/preference';
export const PREFERENCE_SEGMENTS = ['round', 'commit', 'reveal', 'lesson'] as const;
export type PreferenceSegment = (typeof PREFERENCE_SEGMENTS)[number];
export const preferencePoolPath = (segment: PreferenceSegment): string => `${PREFERENCE_PROTOCOL_ROOT}/${segment}`;

export const PREFERENCE_PIN_VERSION = '1.0.0';
export const PREFERENCE_TALLY_ENGINE = 'idbots-preference-tally/1.0.0';

export const FINALITY_GRACE_SEC = 7200;
export const MIN_WINDOW_SEC = 3600;
export const MAX_CANDIDATES = 8;
export const MAX_JUDGES = 32;
export const MAX_PAIRS = 28;

/** Writer-side, non-normative: keeps confirmations clear of the window edges. */
export const COMMIT_CUTOFF_SEC = 1800;
export const REVEAL_DELAY_SEC = 1800;
export const PILOT_CANDIDATE_CAP = 6;

export const PIN_ID_RE = /^[0-9a-f]{64}i[0-9]+$/;
export const HEX64_RE = /^[0-9a-f]{64}$/;
export const GLOBAL_META_ID_RE = /^idq1[0-9a-z]{20,80}$/;
export const CANDIDATE_ID_RE = /^[a-z0-9]{1,8}$/;
export const DIMENSION_ID_RE = /^[a-z][a-z0-9_]{0,23}$/;
export const CATEGORY_TAG_RE = /^[a-z0-9-]+(:[a-z0-9-]+)?$/;
export const ARTIFACT_RE = /^(metaapp|pin|metafile):\/\/\S+$/;
