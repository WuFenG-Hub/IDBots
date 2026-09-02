import { z } from 'zod';
import { stripLoneSurrogates, truncateUtf16Units } from './llmSafeText';
import type { KnowledgeBaseRecord } from '../knowledgeBaseStore';
import type {
  KnowledgeBaseCitation,
  KnowledgeBaseDocumentSource,
  KnowledgeBaseLearnSummary,
} from '../services/knowledgeBaseService';
import { markChainReadSavedToKbSafe } from './chainReadLedger';

/**
 * Control surface the host (main.ts) provides for the knowledge base tools.
 * Backed by KnowledgeBaseService (services/knowledgeBaseService.ts): the
 * per-MetaBot document corpora ("知识库") — registry listing, citation query
 * across KBs, saving bot-collected documents into a KB's raw directory, and
 * incremental/full learning of raw documents into the search index. All
 * methods are metabotId-first; the acting bot is resolved from the session.
 */
export type KnowledgeBaseControl = {
  listKnowledgeBases(metabotId: number): KnowledgeBaseRecord[];
  queryKnowledgeBase(
    metabotId: number,
    input: { query: string; kbId?: string; topK?: number; minScore?: number }
  ): KnowledgeBaseCitation[];
  addDocument(
    metabotId: number,
    input: { kbId?: string; title: string; content: string; source?: KnowledgeBaseDocumentSource }
  ): { kbId: string; filePath: string; relpath: string };
  learnKnowledgeBase(
    metabotId: number,
    kbId: string,
    options?: { full?: boolean }
  ): Promise<KnowledgeBaseLearnSummary>;
  learnAllKnowledgeBases(
    metabotId: number,
    options?: { full?: boolean }
  ): Promise<KnowledgeBaseLearnSummary[]>;
};

/** Minimal shape of the claude-agent-sdk `tool()` helper we depend on. */
type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>
) => unknown;

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

function truncate(value: string, max: number): string {
  const clean = stripLoneSurrogates(value);
  return clean.length > max ? `${truncateUtf16Units(clean, max)}…` : clean;
}

/** "YYYY-MM-DD HH:MM UTC" from an ISO timestamp; '' when never learned. */
function formatLearnedAt(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.parse(iso);
  return Number.isFinite(ms)
    ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
    : iso;
}

/** Human-readable listing for the knowledge_base_list tool response. */
export function formatKnowledgeBaseList(records: KnowledgeBaseRecord[]): string {
  const lines: string[] = [`${records.length} knowledge base(s) for this bot:`];
  records.forEach((record, index) => {
    lines.push(`${index + 1}. ${record.name} (id: ${record.id})${record.isDefault ? ' [default]' : ''}`);
    if (record.description) lines.push(`   description: ${record.description}`);
    lines.push(
      `   documents: ${record.docCount} | chunks: ${record.chunkCount} | last learned: ${formatLearnedAt(record.lastLearnedAt)}`
    );
  });
  lines.push('');
  lines.push(
    'Search these knowledge bases with knowledge_base_query — pass knowledgeBaseId for one KB, or omit it to search ALL of them merged by score. Save new material with knowledge_base_add_document, then absorb it with knowledge_base_learn.'
  );
  return lines.join('\n');
}

/** Numbered citation list for the knowledge_base_query tool response. */
export function formatKnowledgeBaseCitations(query: string, citations: KnowledgeBaseCitation[]): string {
  const lines: string[] = [`${citations.length} citation(s) for "${query}":`];
  citations.forEach((citation, index) => {
    lines.push(`${index + 1}. [${citation.kbName}] ${citation.docTitle} — score ${citation.score}`);
    lines.push(`   source: ${citation.sourcePath}`);
    lines.push(`   ${citation.snippet.replace(/\s+/g, ' ').trim()}`);
  });
  lines.push('');
  lines.push(
    'Answer from what these snippets actually say and cite the KB name + source path so the user can verify. If the snippets do not really answer the question, say so instead of stretching them.'
  );
  return lines.join('\n');
}

/** One-line-per-KB summary for the knowledge_base_learn tool response. */
export function formatKnowledgeBaseLearnSummaries(summaries: KnowledgeBaseLearnSummary[]): string {
  const lines: string[] = [];
  for (const summary of summaries) {
    lines.push(
      `Learned knowledge base "${summary.kbId}" (${summary.full ? 'full rebuild' : 'incremental'}): `
      + `${summary.added} added, ${summary.updated} updated, ${summary.removed} removed, ${summary.unchanged} unchanged`
      + ` — ${summary.docsTotal} doc(s) / ${summary.chunksTotal} chunk(s) indexed.`
    );
    if (summary.failed.length) {
      lines.push('  failed files:');
      for (const failure of summary.failed) {
        lines.push(`  - ${failure.relpath}: ${truncate(failure.error, 200)}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Inline MCP tools over the bot's own knowledge bases ("知识库"), registered
 * for every cowork surface when the host provides a KnowledgeBaseControl (see
 * coworkRunner). knowledge_base_query is the read path (citation search over
 * the learned corpus); knowledge_base_add_document + knowledge_base_learn are
 * the write path (save a Web2/MetaWeb find, then absorb it into the index).
 * The acting MetaBot is resolved from the session — unattributed sessions get
 * a clear error, never a guessed bot.
 */
export function buildKnowledgeBaseAgentTools(deps: {
  tool: SdkToolFactory;
  knowledgeBase: KnowledgeBaseControl;
  sessionId: string;
  resolveMetabotId: (sessionId: string) => number | null | undefined;
}): unknown[] {
  const { tool, knowledgeBase, sessionId, resolveMetabotId } = deps;

  /** Strict per-session bot attribution; null means "do not guess". */
  const requireMetabotId = (toolName: string): number | { isError: true; text: string } => {
    const metabotId = resolveMetabotId(sessionId);
    if (metabotId == null) {
      return {
        isError: true,
        text: `${toolName} could not resolve which MetaBot owns this session, so it has no knowledge bases to work with. Knowledge bases are per-bot; retry from a session attributed to a MetaBot.`,
      };
    }
    return metabotId;
  };

  const knowledgeBaseList = tool(
    'knowledge_base_list',
    'List YOUR OWN knowledge bases (知识库) — local document corpora you can citation-search with knowledge_base_query. Bare call, no arguments. Returns each KB\'s name, id, description, document/chunk counts, last learned time, and which one is the default (where knowledge_base_add_document lands when no KB is chosen). Use to discover what corpora exist before answering domain questions or saving new material. A KB with 0 documents is still listed — it may simply not have content yet.',
    {},
    async () => {
      const metabotId = requireMetabotId('knowledge_base_list');
      if (typeof metabotId !== 'number') {
        return textResult(metabotId.text, true);
      }
      try {
        const records = knowledgeBase.listKnowledgeBases(metabotId);
        if (!records.length) {
          return textResult('This bot has no knowledge bases yet. Documents saved with knowledge_base_add_document land in the default KB, which is created on demand.');
        }
        return textResult(formatKnowledgeBaseList(records));
      } catch (error) {
        return textResult(`knowledge_base_list failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
  );

  const knowledgeBaseQuery = tool(
    'knowledge_base_query',
    'Citation-search YOUR OWN knowledge bases (知识库) — documents you or the user collected, learned into a local full-text index. Omitting knowledgeBaseId searches ALL of your KBs merged by score; pass one KB id (from knowledge_base_list) to scope the search. topK caps results (1-50, default 8); minScore sets the relevance bar (0-1, default 0.18). Returns a numbered list of citations: KB name, document title, source path, score, and the matching snippet. Use BEFORE answering domain questions your KBs cover — this is grounding, not optional decoration. An empty result means insufficient evidence in the corpus: say so honestly instead of inventing content, and consider saving relevant material with knowledge_base_add_document.',
    {
      query: z.string().min(1),
      knowledgeBaseId: z.string().optional(),
      topK: z.number().int().min(1).max(50).optional(),
      minScore: z.number().min(0).max(1).optional(),
    },
    async (args: { query: string; knowledgeBaseId?: string; topK?: number; minScore?: number }) => {
      const query = (args.query ?? '').trim();
      if (!query) {
        return textResult('knowledge_base_query requires a non-empty query.', true);
      }
      const metabotId = requireMetabotId('knowledge_base_query');
      if (typeof metabotId !== 'number') {
        return textResult(metabotId.text, true);
      }
      try {
        const citations = knowledgeBase.queryKnowledgeBase(metabotId, {
          query,
          kbId: (args.knowledgeBaseId ?? '').trim() || undefined,
          topK: args.topK,
          minScore: args.minScore,
        });
        if (!citations.length) {
          const scope = (args.knowledgeBaseId ?? '').trim() || 'any of your knowledge bases';
          return textResult(
            `Insufficient evidence: no knowledge base content passed the relevance bar for "${query}" in ${scope}. The corpus does not cover this well enough to answer from it — answer from your own knowledge instead, or save relevant material first with knowledge_base_add_document and absorb it with knowledge_base_learn.`
          );
        }
        return textResult(formatKnowledgeBaseCitations(query, citations));
      } catch (error) {
        return textResult(`knowledge_base_query failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
  );

  const knowledgeBaseAddDocument = tool(
    'knowledge_base_add_document',
    'Save ONE document into one of YOUR knowledge bases (知识库) so it becomes citation-searchable. The document is written into the KB\'s raw directory under metabot-inbox/ and becomes searchable after the next knowledge_base_learn run — call knowledge_base_learn right after to absorb it immediately. Web2 or synthesized content is stored as SimpleNote-protocol JSON; a MetaWeb pin body is kept verbatim with provenance recorded. sourceType is web (Web2 find, pass url) / metaweb (on-chain pin, pass pinId and the pin body as content) / manual (default). Without knowledgeBaseId the document lands in the default KB; pick a topical KB id from knowledge_base_list when one matches. Not for distilled one-line lessons — those belong to knowledge_upsert.',
    {
      title: z.string().min(1),
      content: z.string().min(1),
      knowledgeBaseId: z.string().optional(),
      sourceType: z.enum(['web', 'metaweb', 'manual']).optional(),
      url: z.string().optional(),
      pinId: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    async (args: {
      title: string;
      content: string;
      knowledgeBaseId?: string;
      sourceType?: 'web' | 'metaweb' | 'manual';
      url?: string;
      pinId?: string;
      tags?: string[];
    }) => {
      const title = (args.title ?? '').trim();
      const content = (args.content ?? '').trim();
      if (!title || !content) {
        return textResult('knowledge_base_add_document requires a non-empty title and content.', true);
      }
      const metabotId = requireMetabotId('knowledge_base_add_document');
      if (typeof metabotId !== 'number') {
        return textResult(metabotId.text, true);
      }
      const source: KnowledgeBaseDocumentSource = {
        type: args.sourceType ?? ((args.pinId ?? '').trim() ? 'metaweb' : (args.url ?? '').trim() ? 'web' : 'manual'),
      };
      const url = (args.url ?? '').trim();
      const pinId = (args.pinId ?? '').trim();
      if (url) source.url = url;
      if (pinId) source.pinId = pinId;
      if (Array.isArray(args.tags) && args.tags.length) source.tags = args.tags;
      try {
        const saved = knowledgeBase.addDocument(metabotId, {
          kbId: (args.knowledgeBaseId ?? '').trim() || undefined,
          title,
          content: args.content,
          source,
        });
        // Back-fill the chain-read ledger: a MetaWeb pin saved into a KB was
        // typically read earlier — flag saved_to_kb on its reads row. No-op
        // when the pin was never recorded as read.
        if (source.type === 'metaweb' && pinId) {
          markChainReadSavedToKbSafe(metabotId, pinId, saved.kbId);
        }
        return textResult(
          [
            `Saved document "${truncate(title, 120)}" into knowledge base "${saved.kbId}" at ${saved.relpath}.`,
            'It becomes searchable after the next learn run — call knowledge_base_learn now to absorb it immediately.',
          ].join('\n')
        );
      } catch (error) {
        return textResult(`knowledge_base_add_document failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
  );

  const knowledgeBaseLearn = tool(
    'knowledge_base_learn',
    'Learn (index) the raw documents of YOUR knowledge bases into their local search index, so knowledge_base_query can find them. Incremental by default: only new, changed, or deleted files are processed. full=true wipes the derived index and rebuilds from scratch — expensive; prefer incremental unless the index is suspect. Omitting knowledgeBaseId learns ALL of your KBs. Run this right after knowledge_base_add_document, and after the user adds files to a KB directory. Reports per-KB counts (added/updated/removed/unchanged, docs/chunks indexed) and any failed files.',
    {
      knowledgeBaseId: z.string().optional(),
      full: z.boolean().optional(),
    },
    async (args: { knowledgeBaseId?: string; full?: boolean }) => {
      const metabotId = requireMetabotId('knowledge_base_learn');
      if (typeof metabotId !== 'number') {
        return textResult(metabotId.text, true);
      }
      const kbId = (args.knowledgeBaseId ?? '').trim();
      const options = { full: args.full === true };
      try {
        const summaries = kbId
          ? [await knowledgeBase.learnKnowledgeBase(metabotId, kbId, options)]
          : await knowledgeBase.learnAllKnowledgeBases(metabotId, options);
        return textResult(formatKnowledgeBaseLearnSummaries(summaries));
      } catch (error) {
        return textResult(`knowledge_base_learn failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
  );

  return [knowledgeBaseList, knowledgeBaseQuery, knowledgeBaseAddDocument, knowledgeBaseLearn];
}
