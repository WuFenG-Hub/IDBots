import type { MemoryUserMemory } from './memoryBackend';
import { normalizeScopeChannel } from './memoryScope';
import {
  MEMORY_IMPORTANCE_GUARANTEED_MAX_ITEMS,
  MEMORY_IMPORTANCE_GUARANTEED_THRESHOLD,
} from './memoryImportance';
import { memoryRecencyBoost, proofCountBoost } from './memoryEvidence';

export type MemoryPromptEntryLike = Pick<MemoryUserMemory, 'id' | 'text' | 'usageClass' | 'visibility' | 'updatedAt' | 'lastUsedAt' | 'lastAppliedAt' | 'importance' | 'proofCount' | 'occurredAt'>;

/**
 * Byte budget for the whole rendered memory injection (all scoped blocks
 * combined). Memory earns its context (recall quality beats another tool
 * schema), so the default is generous — 12K chars ≈ 3K tokens, ~5x the
 * typical 20-entry block — but unbounded growth must not crowd out the
 * conversation itself. Over budget, entries are evicted lowest-importance-first
 * (ties: oldest lastUsedAt ?? updatedAt), never below the single top-ranked entry.
 */
export const DEFAULT_MEMORY_PROMPT_MAX_CHARS = 12000;
const MIN_MEMORY_PROMPT_MAX_CHARS = 2000;
const MAX_MEMORY_PROMPT_MAX_CHARS = 65536;

export function clampMemoryPromptMaxChars(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MEMORY_PROMPT_MAX_CHARS;
  return Math.max(
    MIN_MEMORY_PROMPT_MAX_CHARS,
    Math.min(MAX_MEMORY_PROMPT_MAX_CHARS, Math.floor(value))
  );
}

export interface RankedScopedMemoryEntry extends MemoryPromptEntryLike {
  block: 'owner' | 'contact' | 'conversation' | 'ownerOperationalPreference';
  relevanceScore: number;
}

export interface ScopedMemoryPromptSelection {
  ownerMemories: RankedScopedMemoryEntry[];
  contactMemories: RankedScopedMemoryEntry[];
  conversationMemories: RankedScopedMemoryEntry[];
  ownerOperationalPreferences: RankedScopedMemoryEntry[];
}

export interface RankScopedMemoryEntriesInput {
  requestChannel?: string | null;
  ownerEntries?: MemoryPromptEntryLike[];
  contactEntries?: MemoryPromptEntryLike[];
  conversationEntries?: MemoryPromptEntryLike[];
  currentUserText?: string;
  maxOwnerEntries?: number;
  maxScopedEntries?: number;
  maxOwnerOperationalPreferences?: number;
  /**
   * Optional semantic relevance scores (e.g. cerebellum noul probabilities)
   * keyed by entry id. An entry whose id is present uses the map score AS its
   * relevance rank key (it replaces the lexical score — the value is a rank
   * key, not a summand); entries absent from the map keep the lexical score.
   * The guaranteed-importance tier is unaffected.
   */
  relevanceScoreById?: ReadonlyMap<string, number>;
  /**
   * Combined char budget across all rendered memory blocks. Over budget,
   * entries are evicted lowest-importance-first (ties: oldest
   * lastUsedAt ?? updatedAt), never below the single top-ranked entry.
   * Defaults to DEFAULT_MEMORY_PROMPT_MAX_CHARS.
   */
  maxTotalChars?: number;
}

export interface BuildScopedMemoryPromptBlocksInput extends RankScopedMemoryEntriesInput {
  channel?: string | null;
}

function normalizePromptText(value?: string | null): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function isExternalChannel(channel?: string | null): boolean {
  const normalized = normalizeScopeChannel(channel);
  return Boolean(normalized && normalized !== 'cowork_ui');
}

function tokenizePromptText(value?: string): string[] {
  const normalized = normalizePromptText(value);
  if (!normalized) {
    return [];
  }
  return normalized.split(/[\s,，、|/\\;；:.!?]+/g).filter((token) => token.length >= 2);
}

function scoreEntryForPrompt(entry: MemoryPromptEntryLike, currentUserText?: string): number {
  const normalizedText = normalizePromptText(entry.text);
  if (!normalizedText) {
    return 0;
  }

  const tokens = tokenizePromptText(currentUserText);
  let score = 1;
  for (const token of tokens) {
    if (normalizedText.includes(token)) {
      score += 3;
    }
  }
  if (currentUserText && normalizedText.includes(normalizePromptText(currentUserText))) {
    score += 6;
  }
  return score;
}

function rankEntries(
  entries: MemoryPromptEntryLike[] | undefined,
  block: RankedScopedMemoryEntry['block'],
  currentUserText?: string,
  limit = 12,
  relevanceScoreById?: ReadonlyMap<string, number>
): RankedScopedMemoryEntry[] {
  // Cerebellum nouls (0..1) and lexical scores (base 1, +3 per token hit)
  // live on incompatible scales: with a plain merge any unscored entry
  // outranks every scored one, so the semantic re-rank is nullified (or
  // inverted) whenever the pool exceeds the candidate cap the ranker sent.
  // The comparator below tiers instead: entries the cerebellum examined
  // form the top band ordered by noul; ids it never scored sink below all
  // of them, keeping their own lexical order. Without a live map (ranker
  // off/failed) the sort is pure lexical.
  const hasCerebellumScores = (relevanceScoreById?.size ?? 0) > 0;
  const cerebellumScored = (entry: { id?: unknown }): boolean =>
    hasCerebellumScores
    && typeof entry.id === 'string'
    && (relevanceScoreById?.has(entry.id) ?? false);
  const scored = [...(entries ?? [])]
    .filter((entry) => normalizePromptText(entry.text))
    .map((entry) => {
      const id = typeof entry.id === 'string' ? entry.id : '';
      const mapScore = id ? relevanceScoreById?.get(id) : undefined;
      return {
        ...entry,
        block,
        // A cerebellum score replaces the lexical score outright (it is a
        // rank key, not a summand); the tier split happens in the sort. Both
        // tiers get the bounded proof boost (<= +5%) and the event-time
        // recency nudge (+10% / -8%), both multiplicative: a corroborated or
        // recent memory nudges up, but relevance still decides.
        relevanceScore: proofCountBoost(entry.proofCount)
          * memoryRecencyBoost(entry.occurredAt)
          * (mapScore ?? scoreEntryForPrompt(entry, currentUserText)),
      };
    })
    .sort((left, right) => {
      const leftScored = cerebellumScored(left);
      const rightScored = cerebellumScored(right);
      if (leftScored !== rightScored) {
        return leftScored ? -1 : 1;
      }
      if (right.relevanceScore !== left.relevanceScore) {
        return right.relevanceScore - left.relevanceScore;
      }
      return normalizePromptText(left.text).localeCompare(normalizePromptText(right.text));
    });
  // Guaranteed tier: high-importance memories (explicit user instructions,
  // self-identity) always render ahead of the relevance-ranked rest, capped at
  // MEMORY_IMPORTANCE_GUARANTEED_MAX_ITEMS — the char budget still trims them.
  // The final count stays at the policy limit unless the guaranteed tier
  // itself is larger.
  const guaranteed = scored
    .filter((entry) => (entry.importance ?? 0.5) >= MEMORY_IMPORTANCE_GUARANTEED_THRESHOLD)
    .slice(0, MEMORY_IMPORTANCE_GUARANTEED_MAX_ITEMS);
  if (guaranteed.length === 0) {
    return scored.slice(0, limit);
  }
  const guaranteedSet = new Set<RankedScopedMemoryEntry>(guaranteed);
  const rest = scored.filter((entry) => !guaranteedSet.has(entry));
  return [...guaranteed, ...rest].slice(0, Math.max(limit, guaranteed.length));
}

function applyPromptCharBudget(
  selection: ScopedMemoryPromptSelection,
  maxTotalChars: number
): ScopedMemoryPromptSelection {
  const budget = clampMemoryPromptMaxChars(maxTotalChars);
  const blocks: RankedScopedMemoryEntry[][] = [
    selection.ownerMemories,
    selection.contactMemories,
    selection.conversationMemories,
    selection.ownerOperationalPreferences,
  ];
  const entryChars = (entry: RankedScopedMemoryEntry): number => entry.text.length + 4; // "- " prefix + newline
  const rankedFlat = blocks.flat();
  let total = rankedFlat.reduce((sum, entry) => sum + entryChars(entry), 0);
  if (total <= budget) {
    return selection;
  }
  // Evict globally by lowest importance first (ties: oldest recency =
  // lastAppliedAt ?? lastUsedAt ?? updatedAt, then fewer corroborating
  // sources, then the lower-priority rank) — the applied stamp (written only
  // when the nightly usage audit judged the memory APPLIED) outranks the mere
  // injection touch, so a proven-useful memory survives over a merely-injected
  // one, and at equal recency a belief many sources repeated survives over a
  // one-off. Never evict the top-ranked entry overall: a budget must not zero
  // memory out entirely.
  const evictionOrder = rankedFlat
    .map((entry, rankIndex) => ({ entry, rankIndex }))
    .sort((left, right) => {
      const leftImportance = left.entry.importance ?? 0.5;
      const rightImportance = right.entry.importance ?? 0.5;
      if (leftImportance !== rightImportance) {
        return leftImportance - rightImportance;
      }
      const leftRecency = left.entry.lastAppliedAt ?? left.entry.lastUsedAt ?? left.entry.updatedAt ?? 0;
      const rightRecency = right.entry.lastAppliedAt ?? right.entry.lastUsedAt ?? right.entry.updatedAt ?? 0;
      if (leftRecency !== rightRecency) {
        return leftRecency - rightRecency;
      }
      const leftProof = left.entry.proofCount ?? 0;
      const rightProof = right.entry.proofCount ?? 0;
      if (leftProof !== rightProof) {
        return leftProof - rightProof;
      }
      return right.rankIndex - left.rankIndex;
    });
  const evicted = new Set<RankedScopedMemoryEntry>();
  for (const { entry, rankIndex } of evictionOrder) {
    if (total <= budget) break;
    if (rankIndex === 0) continue;
    evicted.add(entry);
    total -= entryChars(entry);
  }
  const keep = (entries: RankedScopedMemoryEntry[]): RankedScopedMemoryEntry[] =>
    entries.filter((entry) => !evicted.has(entry));
  return {
    ownerMemories: keep(selection.ownerMemories),
    contactMemories: keep(selection.contactMemories),
    conversationMemories: keep(selection.conversationMemories),
    ownerOperationalPreferences: keep(selection.ownerOperationalPreferences),
  };
}

export function selectScopedMemoryPromptEntries(input: RankScopedMemoryEntriesInput): ScopedMemoryPromptSelection {
  const channel = input.requestChannel ?? input.currentUserText ?? null;
  const scopedLimit = Math.max(1, input.maxScopedEntries ?? 12);
  const ownerLimit = Math.max(1, input.maxOwnerEntries ?? scopedLimit);
  const ownerOperationalLimit = Math.max(1, input.maxOwnerOperationalPreferences ?? 3);
  const maxTotalChars = input.maxTotalChars ?? DEFAULT_MEMORY_PROMPT_MAX_CHARS;

  if (!isExternalChannel(channel)) {
    return applyPromptCharBudget({
      ownerMemories: rankEntries(input.ownerEntries, 'owner', input.currentUserText, ownerLimit, input.relevanceScoreById),
      contactMemories: [],
      conversationMemories: [],
      ownerOperationalPreferences: [],
    }, maxTotalChars);
  }

  const safeOwnerOperationalEntries = (input.ownerEntries ?? []).filter((entry) =>
    entry.usageClass === 'operational_preference' && entry.visibility === 'external_safe'
  );
  const contactMemories = rankEntries(input.contactEntries, 'contact', input.currentUserText, scopedLimit, input.relevanceScoreById);
  const conversationMemories = contactMemories.length > 0
    ? []
    : rankEntries(input.conversationEntries, 'conversation', input.currentUserText, scopedLimit, input.relevanceScoreById);

  return applyPromptCharBudget({
    ownerMemories: [],
    contactMemories,
    conversationMemories,
    ownerOperationalPreferences: rankEntries(
      safeOwnerOperationalEntries,
      'ownerOperationalPreference',
      input.currentUserText,
      ownerOperationalLimit,
      input.relevanceScoreById
    ),
  }, maxTotalChars);
}

export function rankScopedMemoryEntries(input: RankScopedMemoryEntriesInput): RankedScopedMemoryEntry[] {
  const selection = selectScopedMemoryPromptEntries(input);
  return [
    ...selection.ownerMemories,
    ...selection.contactMemories,
    ...selection.conversationMemories,
    ...selection.ownerOperationalPreferences,
  ];
}

function renderPromptBlock(tagName: string, entries: RankedScopedMemoryEntry[]): string {
  if (entries.length === 0) {
    return '';
  }
  const lines = entries.map((entry) => `- ${escapeXml(entry.text)}`);
  return `<${tagName}>\n${lines.join('\n')}\n</${tagName}>`;
}

export interface ScopedMemoryPromptBlocksDetailed {
  xml: string;
  /**
   * Deduped ids of every entry that survived selection + the char budget —
   * i.e. the rows that actually rendered into the prompt. Rendering IS the
   * usage event for the hygiene decay clock: callers use these ids to touch
   * last_used_at, while the wider candidate pool stays untouched.
   */
  injectedIds: string[];
}

export function buildScopedMemoryPromptBlocksDetailed(
  input: BuildScopedMemoryPromptBlocksInput
): ScopedMemoryPromptBlocksDetailed {
  const selection = selectScopedMemoryPromptEntries({
    ...input,
    requestChannel: input.channel ?? input.requestChannel,
  });

  const xml = [
    renderPromptBlock('ownerMemories', selection.ownerMemories),
    renderPromptBlock('contactMemories', selection.contactMemories),
    renderPromptBlock('conversationMemories', selection.conversationMemories),
    renderPromptBlock('ownerOperationalPreferences', selection.ownerOperationalPreferences),
  ]
    .filter(Boolean)
    .join('\n');

  const seen = new Set<string>();
  const injectedIds: string[] = [];
  for (const entry of [
    ...selection.ownerMemories,
    ...selection.contactMemories,
    ...selection.conversationMemories,
    ...selection.ownerOperationalPreferences,
  ]) {
    // Entries arriving without an id (test fixtures, hand-mapped rows) still
    // render but can never be touched, so they drop out of the id list.
    const id = typeof entry.id === 'string' ? entry.id : '';
    if (id && !seen.has(id)) {
      seen.add(id);
      injectedIds.push(id);
    }
  }

  return { xml, injectedIds };
}

export function buildScopedMemoryPromptBlocks(input: BuildScopedMemoryPromptBlocksInput): string {
  return buildScopedMemoryPromptBlocksDetailed(input).xml;
}
