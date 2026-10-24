/**
 * Standing-page refresh — the LLM side of the briefing pages.
 *
 * Runs inside the nightly hygiene pass, after deep consolidation. For each
 * active page the engine samples the sediments in the page's scope into
 * capped source lines, hashes them into a scope fingerprint, and skips the
 * page entirely when the fingerprint matches the one it was last built from
 * (Hindsight's "a busy bank does not cause unrelated models to churn").
 * A stale page is refreshed with SURGICAL operations only: the model sees
 * the current sections and may upsert or delete by stable key; the host
 * physically preserves everything unmentioned, so a page stays the document
 * it was instead of drifting into a paraphrase of itself.
 *
 * Idle-time only: every token here is spent outside the conversation path.
 */

import { createHash } from 'node:crypto';
import type { CoworkStore } from '../coworkStore';
import type { DreamStore } from '../dreamStore';
import type { MetaIDKnowledgeStore } from '../metaidKnowledgeStore';
import { stripLoneSurrogates, truncateUtf16Units } from './llmSafeText';
import type { StandingPageSection, StandingPageSectionOperation, StandingPageSpec } from '../standingPageStore';

export interface StandingPageScopeStores {
  coworkStore: CoworkStore;
  dreamStore?: DreamStore | null;
  knowledgeStore?: MetaIDKnowledgeStore | null;
}

export interface StandingPageScopeSample {
  /** Capped source lines for the refresh prompt. */
  lines: string[];
  /** Hash over the lines — the page's scope fingerprint. */
  fingerprint: string;
}

const OWNER_SCOPE = { scopeKind: 'owner' as const, scopeKey: 'owner:self' };
const MEMORY_LINE_MAX_CHARS = 240;
const SUMMARY_LINE_MAX_CHARS = 240;
const KNOWLEDGE_LINE_MAX_CHARS = 220;
const EVIDENCE_QUOTES_PER_MEMORY = 2;
/** Generous headroom over 8 sections × 600 chars; keeps JSON output whole. */
export const STANDING_PAGE_MAX_OUTPUT_TOKENS = 8_192;

const clip = (value: string, maxChars: number): string => {
  const text = stripLoneSurrogates(String(value ?? '')).replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  return `${truncateUtf16Units(text, maxChars - 1)}…`;
};

function fingerprintLines(lines: readonly string[]): string {
  return createHash('sha1').update(lines.join('\n')).digest('hex');
}

interface ScopedMemoryLineInput {
  coworkStore: CoworkStore;
  metabotId: number;
  usageClasses: Array<{ usageClass: string; limit: number }>;
  minTotal: number;
}

/**
 * Owner-scope memory lines with evidence quotes (owner_profile and the
 * generic custom scope). The proof count rides the line, so a corroborated
 * belief (a new source row) changes the fingerprint even when its text
 * never moves.
 */
function buildMemoryLines(input: ScopedMemoryLineInput): string[] | null {
  const memories = input.usageClasses.flatMap(({ usageClass, limit }) =>
    input.coworkStore.listUserMemories({
      metabotId: input.metabotId,
      ...OWNER_SCOPE,
      usageClass: usageClass as never,
      status: 'created' as const,
      limit,
    })
  );
  if (memories.length < input.minTotal) return null;
  const evidence = input.coworkStore.listUserMemoryEvidence(
    memories.map((memory) => memory.id),
    { maxQuotes: EVIDENCE_QUOTES_PER_MEMORY }
  );
  return memories.map((memory) => {
    const quotes = evidence.get(memory.id)?.quotes ?? [];
    const quoteText = quotes.length > 0 ? ` 引文:${quotes.map((quote) => `"${clip(quote, 120)}"`).join('|')}` : '';
    return `- [${memory.usageClass ?? 'fact'}|proof=${evidence.get(memory.id)?.proofCount ?? 1}] ${clip(memory.text, MEMORY_LINE_MAX_CHARS)}${quoteText}`;
  });
}

/** Sample the sediments one page reads. Null = not enough sediment yet (never an error). */
export function sampleStandingPageScope(
  stores: StandingPageScopeStores,
  metabotId: number,
  spec: StandingPageSpec
): StandingPageScopeSample | null {
  let lines: string[] | null = null;
  if (spec === 'owner_profile') {
    lines = buildMemoryLines({
      coworkStore: stores.coworkStore,
      metabotId,
      usageClasses: [
        { usageClass: 'profile_fact', limit: 25 },
        { usageClass: 'preference', limit: 20 },
        { usageClass: 'operational_preference', limit: 10 },
        { usageClass: 'value_boundary', limit: 15 },
      ],
      minTotal: 4,
    });
  } else if (spec === 'work_threads') {
    const summaries = stores.dreamStore
      ? stores.dreamStore.listDailySummaries(metabotId, 14)
      : [];
    if (summaries.length === 0) return null;
    const reviewLines = buildMemoryLines({
      coworkStore: stores.coworkStore,
      metabotId,
      usageClasses: [{ usageClass: 'work_review', limit: 10 }],
      minTotal: 0,
    }) ?? [];
    lines = [
      ...summaries.map((summary) => `- [${summary.summaryDate}] ${clip(summary.summaryText, SUMMARY_LINE_MAX_CHARS)}`),
      ...reviewLines,
    ];
  } else if (spec === 'playbook') {
    const procedures = stores.knowledgeStore
      ? stores.knowledgeStore.listProcedures({ metabotId, status: 'active', limit: 20 })
      : [];
    const knowledge = stores.knowledgeStore
      ? stores.knowledgeStore.listKnowledge({ metabotId, status: 'active', limit: 20 })
      : [];
    if (procedures.length + knowledge.length === 0) return null;
    lines = [
      ...procedures.map((procedure) => `- [procedure] ${clip(procedure.title, 100)} — ${clip(procedure.triggerText, 120)} (${procedure.steps.length} steps)`),
      ...knowledge.map((entry) => `- [${entry.kind}] ${clip(entry.topic, 80)}: ${clip(entry.summary, KNOWLEDGE_LINE_MAX_CHARS)}`),
    ];
  } else {
    lines = buildMemoryLines({
      coworkStore: stores.coworkStore,
      metabotId,
      usageClasses: [{ usageClass: 'profile_fact', limit: 40 }],
      minTotal: 4,
    });
    if (lines && stores.knowledgeStore) {
      const knowledge = stores.knowledgeStore.listKnowledge({ metabotId, status: 'active', limit: 10 });
      lines = [...lines, ...knowledge.map((entry) => `- [${entry.kind}] ${clip(entry.topic, 80)}: ${clip(entry.summary, KNOWLEDGE_LINE_MAX_CHARS)}`)];
    }
  }
  if (!lines || lines.length === 0) return null;
  return { lines, fingerprint: fingerprintLines(lines) };
}

export function buildStandingPageRefreshPrompt(input: {
  botName: string;
  pageName: string;
  question: string;
  sections: readonly StandingPageSection[];
  lines: readonly string[];
}): string {
  const linesOut: string[] = [];
  linesOut.push(
    `You maintain one standing briefing page of MetaBot "${input.botName}": "${input.pageName}".`,
    `The page answers ONE question, always currently: ${input.question}`,
    'The source digest below is the ground truth the page is built from. Rewrite the page from it.',
    '',
    'Rules:',
    '- Use ONLY what the source digest supports. Never invent, never pad; an empty area stays absent.',
    '- Write in the same language as the sources.',
    '- At most 8 sections total; each section body is at most 600 characters and titled clearly.',
    input.sections.length > 0
      ? '- Current sections are listed with stable keys. A section whose content is still supported is KEPT AUTOMATICALLY by the system — do NOT output it again unless its content actually needs to change; re-outputting an unchanged section is noise.'
      : '- The page is empty: write the full first version.',
    '- Output an upsert only for a new section or one whose content must change (reuse its key).',
    '- Output a delete only for a section that is clearly obsolete or contradicted by the digest.',
    '- Answer with the JSON object only: {"operations": [{"action": "upsert", "key": "stable-ascii-slug", "title": "...", "body": "..."}, {"action": "delete", "key": "..."}], "notes": "<at most 40 words"}',
    '- An empty operations list is a valid answer when nothing needs to change.',
  );
  if (input.sections.length > 0) {
    linesOut.push('', 'Current sections (key | title):');
    for (const section of input.sections) {
      linesOut.push(`- ${section.key} | ${section.title}`);
    }
  }
  linesOut.push('', 'Source digest:');
  linesOut.push(...input.lines);
  return linesOut.join('\n');
}

export interface StandingPageRefreshOutput {
  operations: StandingPageSectionOperation[];
  notes: string;
}

export function parseStandingPageRefreshOutput(raw: string): StandingPageRefreshOutput | null {
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
      if (!Array.isArray(parsed.operations)) return null;
      const operations: StandingPageSectionOperation[] = [];
      for (const entry of parsed.operations) {
        if (!entry || typeof entry !== 'object') continue;
        const record = entry as Record<string, unknown>;
        const key = typeof record.key === 'string' ? record.key : '';
        if (!key.trim()) continue;
        if (record.action === 'delete') {
          operations.push({ action: 'delete', key });
          continue;
        }
        if (record.action !== 'upsert') continue;
        const title = typeof record.title === 'string' ? record.title : '';
        const body = typeof record.body === 'string' ? record.body : '';
        if (!title.trim() && !body.trim()) continue;
        operations.push({ action: 'upsert', key, title, body });
      }
      return {
        operations,
        notes: typeof parsed.notes === 'string' ? parsed.notes : '',
      };
    } catch {
      // Try the next candidate slice.
    }
  }
  return null;
}
