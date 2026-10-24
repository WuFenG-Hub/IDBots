/**
 * Memory evidence ledger — the pure helpers behind two columns of memory
 * provenance that the per-turn prompt never sees:
 *
 *   - `user_memory_sources.quote`: the verbatim excerpt a write was distilled
 *     from (the sentence of the user's message, the dream lesson's cited
 *     experience). A memory can then explain itself — "why do I believe
 *     this?" — and the idle-time passes (dream, deep consolidation) can judge
 *     a belief by its evidence instead of by its wording alone.
 *   - `user_memory_revisions`: the text a merge or rewrite replaced. Before
 *     this ledger, a near-duplicate merge silently overwrote the stored
 *     wording; now every change of wording is an audit trail and every
 *     consolidation rewrite stays reversible.
 *
 * Context discipline: quotes and revisions are storage and idle-time inputs
 * only. The injected memory text keeps its existing caps, so this ledger adds
 * zero chars to a conversation turn.
 */

import { stripLoneSurrogates, truncateUtf16Units } from '../libs/llmSafeText';
import { normalizeMemorySemanticKey, scoreMemorySimilarity } from './memorySimilarity';

/** Longest excerpt one source row keeps; longer evidence is cut with an ellipsis. */
export const MEMORY_EVIDENCE_QUOTE_MAX_CHARS = 280;
/** Newest revisions kept per memory; older ones are pruned on write. */
export const MEMORY_REVISIONS_KEEP_PER_MEMORY = 10;
/** Default number of distinct quotes an evidence summary carries. */
export const MEMORY_EVIDENCE_QUOTES_PER_MEMORY = 3;

/**
 * Why a memory's wording changed. `near_duplicate_merge` and
 * `dream_cross_night_merge` are the two write-time merges; `evolution_rewrite`
 * is the deep-consolidation narrative rewrite; `user_edit` is an owner/tool
 * edit; `protected_update` is the dream service rewriting a protected row
 * (self_identity).
 */
export type MemoryRevisionReason =
  | 'near_duplicate_merge'
  | 'dream_cross_night_merge'
  | 'evolution_rewrite'
  | 'user_edit'
  | 'protected_update';

export interface MemoryRevision {
  id: string;
  memoryId: string;
  previousText: string;
  newText: string;
  reason: MemoryRevisionReason | string;
  sourceType: string | null;
  createdAt: number;
}

export interface MemoryEvidenceSummary {
  /** Active provenance rows — how many writes corroborated this memory. */
  proofCount: number;
  /** Newest distinct non-empty quotes, most recent first. */
  quotes: string[];
}

export function normalizeMemoryQuote(
  value: string | null | undefined,
  maxChars: number = MEMORY_EVIDENCE_QUOTE_MAX_CHARS,
): string | null {
  const text = stripLoneSurrogates(String(value ?? '')).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length <= maxChars) return text;
  return `${truncateUtf16Units(text, maxChars - 1)}…`;
}

/**
 * How far corroboration may move a memory's recall rank: a multiplicative
 * nudge centred on 1.0 and capped at ±(alpha / 2) = ±5%. Secondary signals
 * must never outrank relevance — a barely-relevant memory cannot leapfrog a
 * clearly relevant one just because more sources repeated it — so the boost
 * is multiplicative (proportional to the base score), not additive.
 */
export const MEMORY_PROOF_BOOST_ALPHA = 0.1;

/**
 * proof_norm = clamp(0.5 + ln(n) / 10, 0, 1); boost = 1 + alpha * (proof_norm - 0.5).
 * One source is neutral (1.0); 3 → +1.1%; 10 → +2.3%; 150+ saturates at +5%.
 * Missing/zero counts are neutral too, so rows written before the ledger
 * existed rank exactly as they did.
 */
export function proofCountBoost(proofCount: number | null | undefined): number {
  const count = Math.floor(Number(proofCount));
  if (!Number.isFinite(count) || count <= 1) return 1;
  const norm = Math.max(0, Math.min(1, 0.5 + Math.log(count) / 10));
  return 1 + MEMORY_PROOF_BOOST_ALPHA * (norm - 0.5);
}

const SENTENCE_TERMINATORS = new Set(['。', '！', '？', '!', '?', '；', ';']);

/**
 * Split a message into sentence-sized candidates. CJK and ASCII terminators
 * end a sentence in place; an ASCII period only ends one when followed by
 * whitespace (so "v1.2" or "a.b" stays whole); line breaks always split.
 */
export function splitEvidenceSentences(sourceText: string): string[] {
  const text = String(sourceText ?? '');
  const sentences: string[] = [];
  let current = '';
  const flush = (): void => {
    const trimmed = current.replace(/\s+/g, ' ').trim();
    if (trimmed.length >= 2) sentences.push(trimmed);
    current = '';
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\n' || char === '\r') {
      flush();
      continue;
    }
    current += char;
    if (SENTENCE_TERMINATORS.has(char)) {
      flush();
      continue;
    }
    if (char === '.' && /\s/.test(text[index + 1] ?? ' ')) {
      flush();
    }
  }
  flush();
  return sentences;
}

/**
 * Pick the sentence of `sourceText` that best supports `memoryText`, using
 * the same CJK-safe similarity the revive path uses. Deterministic: ties go
 * to the earlier sentence. A source with no overlapping sentence still yields
 * its opening sentence — the memory was extracted from this message, so the
 * message is its evidence even when the distillation reworded everything.
 * Returns null only for an empty source.
 */
export function pickEvidenceQuote(
  sourceText: string | null | undefined,
  memoryText: string,
  maxChars: number = MEMORY_EVIDENCE_QUOTE_MAX_CHARS,
): string | null {
  const sentences = splitEvidenceSentences(sourceText ?? '');
  if (sentences.length === 0) return null;
  const memoryKey = normalizeMemorySemanticKey(memoryText);
  let best = sentences[0];
  let bestScore = -1;
  for (const sentence of sentences) {
    const sentenceKey = normalizeMemorySemanticKey(sentence);
    if (!sentenceKey) continue;
    const score = memoryKey ? scoreMemorySimilarity(sentenceKey, memoryKey) : 0;
    if (score > bestScore) {
      bestScore = score;
      best = sentence;
    }
  }
  return normalizeMemoryQuote(best, maxChars);
}
