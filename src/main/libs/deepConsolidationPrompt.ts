/**
 * Deep-consolidation prompt — the LLM side of the compression stroke.
 *
 * While the other hygiene steps are deterministic SQL, this pass periodically
 * reviews the bot's belief layer (value boundaries, work reviews, dream-
 * distilled owner facts, knowledge points) and proposes retire/merge actions
 * so beliefs stay few, current and high-weight as the bot ages — "wisdom
 * aging" instead of endless accumulation. Every proposal is validated against
 * the listed inventory and applied through existing versioned channels (soft
 * archive / knowledge upsert / memory revision), so nothing is ever lost
 * irreversibly.
 *
 * Memory evolution (2026-10-24): the inventory now carries each item's
 * evidence (proof count, newest quotes, first/last seen) and the pass can
 * REWRITE a memory as an evolution narrative. A contradiction or state change
 * is no longer resolved by silently dropping the older belief: the survivor
 * is rewritten to carry both states and the transition ("曾…，现在…" / "used
 * to …, now …"), the superseded item is retired, and the replaced wording
 * stays in user_memory_revisions. Conversation-origin items are listed as
 * read-only context (they may justify a rewrite, never receive one): they can
 * carry the owner's explicit "remember this".
 */

export type DeepConsolidationMemoryKind = 'value_boundary' | 'work_review' | 'profile_fact';

export interface DeepConsolidationInventoryItem {
  id: string;
  kind: DeepConsolidationMemoryKind | 'knowledge';
  text: string;
  extra?: string;
  /** Memory items only: dream-distilled vs conversation-written. */
  origin?: 'dream' | 'conversation';
  /**
   * Whether retire/rewrite proposals may target this item. False items are
   * read-only context (conversation-origin memories, which may carry the
   * owner's explicit instruction). Defaults to true for knowledge.
   */
  rewritable?: boolean;
  /** Active provenance rows corroborating this item. */
  proofCount?: number;
  /** Newest evidence quotes, most recent first. */
  quotes?: string[];
  /** YYYY-MM-DD the item was first written. */
  firstSeen?: string;
  /** YYYY-MM-DD the item was last written/corroborated. */
  lastSeen?: string;
}

export type DeepConsolidationRewriteReason = 'contradiction' | 'state_change' | 'redundant';

export interface DeepConsolidationMemoryRewrite {
  id: string;
  text: string;
  reason: DeepConsolidationRewriteReason;
}

export interface DeepConsolidationOutput {
  retireMemoryIds: string[];
  retireKnowledgeIds: string[];
  /** Evolution-narrative rewrites of belief-layer memories (dream-origin only). */
  rewriteMemories: DeepConsolidationMemoryRewrite[];
  rewriteKnowledge: Array<{
    id: string;
    topic: string;
    summary: string;
    kind: 'know_how' | 'pitfall' | 'principle';
  }>;
  notes: string;
}

const MIN_ITEMS_TO_CONSIDER = 8;
/** Headroom under the 360-char store cap so a narrative is never cut mid-sentence. */
export const DEEP_CONSOLIDATION_REWRITE_MAX_CHARS = 300;
/** Quote length shown per evidence line in the inventory. */
const INVENTORY_QUOTE_MAX_CHARS = 120;
const INVENTORY_QUOTES_PER_ITEM = 2;

export function shouldRunDeepConsolidation(itemCount: number): boolean {
  return itemCount >= MIN_ITEMS_TO_CONSIDER;
}

/**
 * Maximum combined retire/rewrite actions one pass may propose — a quarter
 * of the inventory, rounded up. Shared by the prompt (so the model budgets
 * its own proposal) and the service guardrail (which refuses larger lists
 * as suspected hallucinated purges).
 */
export function deepConsolidationRetireCap(itemCount: number): number {
  return Math.ceil(itemCount * 0.25);
}

function clipQuote(quote: string): string {
  const text = quote.replace(/\s+/g, ' ').trim();
  if (text.length <= INVENTORY_QUOTE_MAX_CHARS) return text;
  return `${text.slice(0, INVENTORY_QUOTE_MAX_CHARS - 1)}…`;
}

function formatInventoryItem(item: DeepConsolidationInventoryItem): string[] {
  const meta: string[] = [];
  if (item.origin) meta.push(`origin=${item.origin}`);
  if (item.rewritable === false) meta.push('read-only');
  if (typeof item.proofCount === 'number') meta.push(`proof=${item.proofCount}`);
  if (item.firstSeen) meta.push(`first=${item.firstSeen}`);
  if (item.lastSeen) meta.push(`last=${item.lastSeen}`);
  if (item.extra) meta.push(item.extra);
  const metaText = meta.length > 0 ? ` [${meta.join(', ')}]` : '';
  const lines = [`- ${item.id} | ${item.kind} | ${item.text}${metaText}`];
  const quotes = (item.quotes ?? []).map(clipQuote).filter(Boolean).slice(0, INVENTORY_QUOTES_PER_ITEM);
  if (quotes.length > 0) {
    lines.push(`    evidence: ${quotes.map((quote) => `"${quote}"`).join(' | ')}`);
  }
  return lines;
}

export function buildDeepConsolidationPrompt(input: {
  botName: string;
  items: DeepConsolidationInventoryItem[];
}): string {
  const cap = deepConsolidationRetireCap(input.items.length);
  const lines: string[] = [];
  lines.push(
    `You are reviewing the long-term belief layer of MetaBot "${input.botName}" as part of a periodic deep-consolidation pass.`,
    'The layer below holds the bot\'s distilled value boundaries, work reviews, owner facts and reusable knowledge points, each with its evidence (proof count, newest quotes, first/last seen).',
    'Goal: keep this layer small, current and high-signal as the bot ages — merge what belongs together, retire what is outdated, and write contradictions as evolution instead of dropping history.',
    '',
    'Merge rules (judge by the evidence, not by wording alone):',
    '- Redundant: two items say the same thing in different words → keep ONE. Retire the weaker (fewer proofs, older, vaguer) via retire_memory_ids. Do not rewrite merely to unify wording.',
    '- Direct contradiction: two items assert incompatible states about the same subject → never silently drop the older state. Rewrite the survivor (prefer the one with more evidence, else the newer) as a temporal narrative that carries BOTH states and the transition — e.g. "曾偏好周五发版(9月前),10月起改为周三发版" / "used to prefer React (until March), switched to Vue in June and no longer uses React" — then retire the superseded item.',
    '- State change: a newer item replaces a state an older item records → rewrite the survivor to name the transition explicitly ("从 X 改为 Y", "used to X, now Y") and retire the old one. Never just restate the new fact.',
    '- When no transition is explainable and the states are incompatible, treat the most recent, better-evidenced state as current and say the earlier one was the previous understanding.',
    '- Items marked [read-only] (conversation-origin, possibly the owner\'s own words) are context only: they may justify rewriting a rewritable item — the owner\'s explicit statement supersedes a dream belief — but must never appear in retire_memory_ids or rewrite_memories.',
    '- Rewritten text must stay a durable belief in the same class (a boundary stays a boundary, an owner fact stays an owner fact), use the same language as the inventory, be at most ' + DEEP_CONSOLIDATION_REWRITE_MAX_CHARS + ' characters, and contain only what the listed items and their evidence support — never invented detail.',
    '',
    'Retire rules:',
    '- Retire a value boundary only when it is clearly superseded by a newer one or refers to a bygone situation. Never retire boundaries that still look load-bearing.',
    '- Retire work reviews that summarize situations unlikely to matter for future tasks (one-off events, resolved episodes).',
    '- Retire knowledge points that duplicate another point or have been proven wrong; prefer rewriting (merging several stale points into one accurate point) over deletion when the underlying lesson still has value.',
    '- Rewrites must reuse an existing id and keep the topic focused; the system stores the prior text as a version, so rewrites are reversible.',
    '- Be conservative: when unsure, keep the item and explain in notes.',
    `- Propose at most ${cap} combined actions across retire_memory_ids, retire_knowledge_ids and rewrite_memories (a quarter of the inventory); the system refuses larger lists.`,
    '- Keep notes under 80 words and answer with the JSON object only — long per-item commentary is not read by anyone.',
    '- Output ONLY a JSON object, no prose around it.',
    '',
    'Output JSON shape:',
    '{"retire_memory_ids": ["<value_boundary/work_review/profile_fact id>"], "retire_knowledge_ids": ["<knowledge id>"], "rewrite_memories": [{"id": "<value_boundary/work_review/profile_fact id>", "text": "<evolution narrative>", "reason": "contradiction|state_change|redundant"}], "rewrite_knowledge": [{"id": "<knowledge id>", "topic": "...", "summary": "...", "kind": "know_how|pitfall|principle"}], "notes": "<one short paragraph>"}',
    '',
    'Inventory (id | kind | text [origin, read-only?, proof, first, last]; evidence lines quote the sources):',
  );
  for (const item of input.items) {
    lines.push(...formatInventoryItem(item));
  }
  return lines.join('\n');
}

export function parseDeepConsolidationOutput(raw: string): DeepConsolidationOutput | null {
  const trimmed = raw.trim();
  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const asStringArray = (value: unknown): string[] => Array.isArray(value)
        ? value.map((entry) => String(entry)).filter(Boolean)
        : [];
      const rewrites = Array.isArray(parsed.rewrite_knowledge)
        ? parsed.rewrite_knowledge
            .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
            .filter((entry) => typeof entry.id === 'string' && typeof entry.topic === 'string' && typeof entry.summary === 'string')
            .map((entry) => ({
              id: String(entry.id),
              topic: String(entry.topic),
              summary: String(entry.summary),
              kind: (entry.kind === 'pitfall' || entry.kind === 'principle' ? entry.kind : 'know_how') as 'know_how' | 'pitfall' | 'principle',
            }))
        : [];
      const rewriteMemories: DeepConsolidationMemoryRewrite[] = Array.isArray(parsed.rewrite_memories)
        ? parsed.rewrite_memories
            .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
            .filter((entry) => typeof entry.id === 'string' && typeof entry.text === 'string' && String(entry.text).trim())
            .map((entry) => ({
              id: String(entry.id),
              text: String(entry.text).trim(),
              reason: (entry.reason === 'contradiction' || entry.reason === 'redundant'
                ? entry.reason
                : 'state_change') as DeepConsolidationRewriteReason,
            }))
        : [];
      return {
        retireMemoryIds: asStringArray(parsed.retire_memory_ids),
        retireKnowledgeIds: asStringArray(parsed.retire_knowledge_ids),
        rewriteMemories,
        rewriteKnowledge: rewrites,
        notes: typeof parsed.notes === 'string' ? parsed.notes : '',
      };
    } catch {
      // Try the next candidate slice.
    }
  }
  return null;
}

/**
 * Human-readable diagnosis for a parse failure — distinguishes an answer
 * with no JSON object at all (prose drift or truncation before the object
 * finished, e.g. the output-token budget cut the stream mid-list) from a
 * complete-but-malformed object, so the settings error line points at the
 * actual cause instead of a bare "unparseable output".
 */
export function describeDeepConsolidationParseFailure(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return 'empty output';
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    return `no complete JSON object in ${trimmed.length} chars of output (prose answer, or truncated at the output-token budget)`;
  }
  return `malformed JSON object (${trimmed.length} chars)`;
}
