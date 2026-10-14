/**
 * Pure gate regularizers for the capability validation passes
 * (RRSI evolution P1, design §6.1).
 *
 * Every rule the fresh-draft gate and the re-review need to regularize judge
 * noise lives here as a pure function: prospective (post-origin) citation
 * checks, dual-panel outcome combination, and the falsified-hypothesis
 * keys/similarity used by the ledger lookups. This module takes time and data
 * as inputs only — never reads the clock, the filesystem or a random source —
 * so every vector is unit-testable without a database.
 */

import { tokenizeKnowledgeBaseText } from './knowledgeBaseText';

export interface CapabilityGateConfig {
  /** How many times each gate call runs (panel B sees drafts reversed). */
  panels: 1 | 2;
  /** Whether validated verdicts need a post-origin diary citation. */
  prospective: boolean;
}

export const CAPABILITY_GATE_DEFAULTS: CapabilityGateConfig = { panels: 2, prospective: true };

/**
 * Resolve a (possibly invalid) override onto the defaults: only literally
 * valid fields are taken, anything else falls back per-field. Exists so
 * tests downstream of the gate can pin the legacy single-panel behavior;
 * production wiring never sets it.
 */
export function resolveCapabilityGateConfig(input?: Partial<CapabilityGateConfig> | null): CapabilityGateConfig {
  const panels = input?.panels === 1 || input?.panels === 2 ? input.panels : CAPABILITY_GATE_DEFAULTS.panels;
  const prospective = typeof input?.prospective === 'boolean' ? input.prospective : CAPABILITY_GATE_DEFAULTS.prospective;
  return { panels, prospective };
}

/** A ledger row falsified within this many days still blocks re-proposals. */
export const FALSIFIED_BLOCK_DAYS = 30;
/** Hygiene retention horizon for ledger rows. */
export const FALSIFIED_RETENTION_DAYS = 180;
/** Per-bot ledger cap (oldest rows beyond it are purged). */
export const FALSIFIED_MAX_PER_BOT = 200;
/** How many ledger entries ride the dream prompt's falsified section. */
export const FALSIFIED_PROMPT_MAX_ITEMS = 8;
/** Title-token overlap coefficient at which a ledger entry counts as similar. */
export const FALSIFIED_SIMILARITY_MIN = 0.6;

/** Distinct YYYY-MM-DD substrings of a rationale, first-occurrence order. */
export function citedDiaryDates(rationale: string): string[] {
  const dates = String(rationale ?? '').match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  return [...new Set(dates)];
}

/**
 * Prospective rule (design §6.1 P1.1): true iff the rationale cites at least
 * one diary date strictly later than the draft's origin dream date AND that
 * date is among the diary dates actually shown to the panel.
 */
export function hasPostOriginCitation(input: {
  rationale: string;
  draftDreamDate: string;
  evidenceDates: ReadonlySet<string>;
}): boolean {
  return citedDiaryDates(input.rationale).some(
    (cited) => cited > input.draftDreamDate && input.evidenceDates.has(cited),
  );
}

export type GateOutcome = 'promote' | 'demote' | 'hold';
export type PanelAgreement = 'agreed' | 'disagreed' | 'incomplete';

/**
 * Dual-panel agreement (design §6.1 P1.2): the final outcome is the agreed
 * outcome; any disagreement — or a missing panel verdict — is `hold` with no
 * state change.
 */
export function combinePanelOutcomes(
  a: GateOutcome | null,
  b: GateOutcome | null,
): { outcome: GateOutcome; agreement: PanelAgreement } {
  if (a === null || b === null) return { outcome: 'hold', agreement: 'incomplete' };
  if (a === b) return { outcome: a, agreement: 'agreed' };
  return { outcome: 'hold', agreement: 'disagreed' };
}

/**
 * Store both panels' rationales (identical rationales collapse to one), cut
 * to `maxChars` UTF-16 units with an ellipsis when longer.
 */
export function joinPanelRationales(a: string, b: string, maxChars = 600): string {
  const first = String(a ?? '').trim();
  const second = String(b ?? '').trim();
  const joined = first === second ? first : `A: ${first} | B: ${second}`;
  if (joined.length <= maxChars) return joined;
  return `${joined.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** Normalized identity of a hypothesis title: NFKC + lowercase, no space /
 * punctuation / symbol characters — 「先验证、再交付！」 and 「先验证再交付」
 * are the same hypothesis. */
export function hypothesisTitleKey(title: string): string {
  return String(title ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

/** De-duplicated knowledge-base tokens (length >= 2) in first-seen order. */
export function hypothesisTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const token of tokenizeKnowledgeBaseText(String(text ?? ''))) {
    if (token.length >= 2 && !tokens.includes(token)) tokens.push(token);
  }
  return tokens;
}

/**
 * Overlap coefficient of the two titles' token sets: |A ∩ B| / min(|A|, |B|),
 * rounded to 4 decimals. Below 2 tokens on either side it is 0 — a single
 * shared bigram is not a similarity signal.
 */
export function hypothesisSimilarity(a: string, b: string): number {
  const setA = new Set(hypothesisTokens(a));
  const setB = new Set(hypothesisTokens(b));
  const min = Math.min(setA.size, setB.size);
  if (min < 2) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  return Math.round((intersection / min) * 10_000) / 10_000;
}

/**
 * The most similar falsified hypothesis for a title: exact normalized-key
 * match first; otherwise the entry with the highest title similarity that is
 * still >= minSimilarity (ties keep the earliest in input order); null when
 * nothing clears the bar.
 */
export function findSimilarFalsified<T extends { title: string; titleKey: string }>(
  title: string,
  ledger: readonly T[],
  minSimilarity: number = FALSIFIED_SIMILARITY_MIN,
): T | null {
  const key = hypothesisTitleKey(title);
  if (!key) return null;
  let best: T | null = null;
  let bestScore = -1;
  for (const entry of ledger) {
    if (entry.titleKey === key) return entry;
    const score = hypothesisSimilarity(title, entry.title);
    // Strictly greater on replacement keeps the earliest entry on ties.
    if (score >= minSimilarity && (best === null || score > bestScore)) {
      best = entry;
      bestScore = score;
    }
  }
  return best;
}
