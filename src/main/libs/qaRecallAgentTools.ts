import { z } from 'zod';
import type { QaAnswerItem, QaQuestionItem } from '../services/qaRecallService';
import { buildPinBrowserUri, markdownSelfLink } from './metawebUri';
import { truncateUtf16Units } from './llmSafeText';

const QUESTION_PATH = '/protocols/simplequestion';
const ANSWER_PATH = '/protocols/simpleanswer';

/**
 * Control surface the host (main.ts) provides for the on-chain Q&A recall
 * tools. Backed by the metaso-p2p Q&A APIs (so.metaid.io/api/qa/*): question
 * search, latest-questions feed, question detail with ranked answers, and the
 * publisher-filtered answer list.
 */
export type QaRecallControl = {
  search(input: {
    q: string;
    tags?: string[];
    publisher?: string;
    answered?: boolean;
    sort?: 'relevance' | 'newest';
    size?: number;
    cursor?: string;
  }): Promise<{ items: QaQuestionItem[]; hasMore: boolean; nextCursor?: string | null }>;
  latestQuestions(input: {
    tags?: string[];
    minAnswers?: number;
    maxAnswers?: number;
    sort?: 'newest' | 'hot';
    size?: number;
    cursor?: string;
  }): Promise<{ items: QaQuestionItem[]; hasMore: boolean; nextCursor?: string | null }>;
  questionDetail(pinId: string): Promise<{
    question: QaQuestionItem;
    answers: QaAnswerItem[];
    hasMore: boolean;
    nextCursor?: string | null;
  }>;
  questionAnswers(input: {
    pinId: string;
    publisher?: string;
    size?: number;
    cursor?: string;
  }): Promise<{ items: QaAnswerItem[]; hasMore: boolean; nextCursor?: string | null }>;
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

function metaIdUri(globalMetaId: string): string {
  return `metaid://${globalMetaId}`;
}

function sanitizeLinkLabel(value: string): string {
  return value.replace(/[[\]]/g, '');
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${truncateUtf16Units(value, max)}…` : value;
}

/** UTC "YYYY-MM-DD HH:MM" — the Q&A API timestamps are Unix seconds (block time). */
function formatTime(ts: number): string {
  return ts ? `${new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
}

function publisherName(publisher: { globalMetaId: string; name: string; metaId: string }): string {
  return publisher.name || publisher.globalMetaId || publisher.metaId || 'unknown';
}

function publisherLink(publisher: { globalMetaId: string; name: string; metaId: string }): string {
  const name = publisherName(publisher);
  const label = sanitizeLinkLabel(name);
  return publisher.globalMetaId ? `[${label}](${metaIdUri(publisher.globalMetaId)})` : label;
}

function questionLabel(question: QaQuestionItem): string {
  return sanitizeLinkLabel(truncate(question.title || question.summary || '(untitled question)', 120));
}

function questionViewLink(question: QaQuestionItem): string {
  return buildPinBrowserUri({ pinId: question.pinId, path: QUESTION_PATH });
}

/** Ready-to-quote markdown bullets for question items; titles are pin:// links, authors metaid:// links. */
export function formatQaQuestionBullets(items: QaQuestionItem[]): string {
  return items.map((question) => {
    const title = question.pinId
      ? `[${questionLabel(question)}](${questionViewLink(question)})`
      : questionLabel(question);
    const head = `- **${title}** — asked by ${publisherLink(question.publisher)} · ${formatTime(question.createdAt)}${question.answerCount ? ` · ${question.answerCount} answer(s)` : ' · unanswered'}`;
    const meta = [
      `likes ${question.likeCount}`,
      question.dislikeCount ? `dislikes ${question.dislikeCount}` : '',
      question.commentCount ? `comments ${question.commentCount}` : '',
      question.hotScore != null ? `hot ${question.hotScore}` : '',
      question.tags.length ? `tags: ${question.tags.join(', ')}` : '',
      question.isMempool ? 'mempool (unconfirmed)' : '',
      question.pinId ? `pin: ${question.pinId}` : '',
    ].filter(Boolean).join(' | ');
    const lines = [meta ? `${head}\n  ${meta}` : head];
    if (question.topAnswer) {
      const top = question.topAnswer;
      const topText = sanitizeLinkLabel(truncate(top.summary || '(no summary)', 140));
      const topPart = top.pinId
        ? `[${topText}](${buildPinBrowserUri({ pinId: top.pinId, path: ANSWER_PATH })})`
        : topText;
      lines.push(`  top answer (+${top.likeCount}${top.dislikeCount ? `/-${top.dislikeCount}` : ''}) by ${publisherLink(top.publisher)}: ${topPart}`);
    }
    return lines.join('\n');
  }).join('\n');
}

/** Ready-to-quote markdown bullets for ranked answer items. */
export function formatQaAnswerBullets(items: QaAnswerItem[]): string {
  return items.map((answer, index) => {
    const summary = sanitizeLinkLabel(truncate(answer.summary || '(no summary)', 200));
    const summaryPart = answer.pinId
      ? `[${summary}](${buildPinBrowserUri({ pinId: answer.pinId, path: ANSWER_PATH })})`
      : summary;
    const head = `- #${index + 1} **${summaryPart}** — by ${publisherLink(answer.publisher)} · ${formatTime(answer.createdAt)}`;
    const meta = [
      `score ${answer.score} (likes ${answer.likeCount}${answer.dislikeCount ? `, dislikes ${answer.dislikeCount}` : ''})`,
      answer.commentCount ? `comments ${answer.commentCount}` : '',
      answer.isMempool ? 'mempool (unconfirmed)' : '',
      answer.pinId ? `pin: ${answer.pinId}` : '',
    ].filter(Boolean).join(' | ');
    return meta ? `${head}\n  ${meta}` : head;
  }).join('\n');
}

/** Human-readable sheet for one question with its ranked answers. */
export function formatQaQuestionDetail(input: {
  question: QaQuestionItem;
  answers: QaAnswerItem[];
}): string {
  const question = input.question;
  const lines = [
    `Question ${question.pinId}:`,
    `- title: ${question.title || '(untitled)'}`,
    `- asked by: ${publisherLink(question.publisher)}`,
  ];
  if (question.createdAt) lines.push(`- asked at: ${formatTime(question.createdAt)}${question.isMempool ? ' (mempool, unconfirmed)' : ''}`);
  lines.push(`- engagement: likes ${question.likeCount} | dislikes ${question.dislikeCount} | comments ${question.commentCount} | answers ${question.answerCount}`);
  if (question.tags.length) lines.push(`- tags: ${question.tags.join(', ')}`);
  if (question.summary) lines.push(`- question summary: ${truncate(question.summary, 600)}`);
  if (question.pinId) lines.push(`- view: ${markdownSelfLink(questionViewLink(question))}`);
  if (!input.answers.length) {
    lines.push('', 'No answers yet — if you know the answer, post_simpleanswer with `answer_to` = the question pinId above.');
    return lines.join('\n');
  }
  lines.push('', 'Answers (ranked by likes − dislikes, best first):', formatQaAnswerBullets(input.answers));
  lines.push('', 'Answer summaries are ~200 chars; read the full body of an answer with read_metaweb_pin on its pinId before relying on it. React with like_pin (1 like / -1 dislike) on the answer pinId.');
  return lines.join('\n');
}

/**
 * Inline MCP tools for the on-chain Q&A knowledge base (simplequestion /
 * simpleanswer via the MetaSo Q&A APIs). Registered for every cowork surface
 * when the host provides QaRecallControl (see coworkRunner). The core loop
 * they serve: search BEFORE asking, browse unanswered questions to answer,
 * open a question's ranked answers before re-answering.
 */
export function buildQaRecallAgentTools(deps: {
  tool: SdkToolFactory;
  qaRecall: QaRecallControl;
}): unknown[] {
  const { tool, qaRecall } = deps;

  const searchQa = tool(
    'search_qa',
    [
      'Search the on-chain Q&A knowledge base (questions and their answers published on MetaWeb via simplequestion/simpleanswer).',
      'SEARCH BEFORE ASKING: whenever you are stuck or missing knowledge, call this FIRST — an existing high-scored answer may solve your problem immediately. Only when the search comes up empty (or the answers do not actually help) should you publish a new question with post_simplequestion.',
      'Returns questions matching keywords, each with its top answer, answer count and engagement; answers are ranked by community likes. Open a question\'s full ranked answers with get_question_answers, and read full answer bodies with read_metaweb_pin.',
      '`answered`: true = only answered questions; false = only unanswered. `publisher` accepts a GlobalMetaID or MetaID. Full bodies are never returned here — summaries only.',
    ].join(' '),
    {
      query: z.string().min(1).describe('Keyword query, e.g. "recover wallet mnemonic" or "MVC fee rate".'),
      tags: z.array(z.string()).optional().describe('Filter by question tags (all must match).'),
      publisher: z.string().optional().describe('Filter by question publisher (GlobalMetaID or MetaID).'),
      answered: z.boolean().optional().describe('true = only answered; false = only unanswered.'),
      sort: z.enum(['relevance', 'newest']).optional().describe('Default relevance; newest = question block time desc.'),
      size: z.number().optional().describe('Page size (default 10, max 50).'),
      cursor: z.string().optional().describe('Continuation cursor from a previous call.'),
    },
    async (args: {
      query: string;
      tags?: string[];
      publisher?: string;
      answered?: boolean;
      sort?: 'relevance' | 'newest';
      size?: number;
      cursor?: string;
    }) => {
      const q = (args.query ?? '').trim();
      if (!q) {
        return textResult('search_qa requires a non-empty `query`.', true);
      }
      try {
        const { items, hasMore, nextCursor } = await qaRecall.search({
          q,
          tags: args.tags,
          publisher: args.publisher,
          answered: args.answered,
          sort: args.sort,
          size: args.size,
          cursor: args.cursor,
        });
        if (!items.length) {
          return textResult(
            `No on-chain Q&A matched "${q}". If you are stuck on this yourself, this is the moment to publish the question with post_simplequestion (clear title, context, tags) — and if you later solve it, answer it for everyone with post_simpleanswer. Do NOT invent questions or answers.`,
          );
        }
        const ordering = args.sort === 'newest' ? 'newest first' : 'best match first';
        const sections = [
          `${items.length} on-chain question(s) matching "${q}", ${ordering}:`,
          formatQaQuestionBullets(items),
          'Reuse these bullet lines in your reply (titles stay pin:// links, authors stay metaid:// links, pinIds stay intact). Before relying on an answer, read its full body with read_metaweb_pin; good answers that solved your problem deserve a like_pin.',
        ];
        if (hasMore && nextCursor) {
          sections.push(`More results are available — call search_qa again with the same query and cursor="${nextCursor}".`);
        }
        return textResult(sections.join('\n\n'));
      } catch (error) {
        return textResult(`Q&A search failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
  );

  const listLatestQuestions = tool(
    'list_latest_questions',
    [
      'Browse the latest questions published on-chain (simplequestion) — the feed for bots that want to answer.',
      'Use `max_answers: 0` to see UNANSWERED questions only: scan them, and when one is squarely in your competence, answer it with post_simpleanswer (`answer_to` = the question pinId). Answering what you genuinely know is how the whole network levels up.',
      '`sort: hot` ranks by recent engagement (answers + likes + comments over the last 7 days). Tags filter by topic.',
      'Open a specific question with get_question_answers; read full bodies with read_metaweb_pin.',
    ].join(' '),
    {
      tags: z.array(z.string()).optional().describe('Filter by question tags (all must match).'),
      min_answers: z.number().optional().describe('Lower bound on answer count.'),
      max_answers: z.number().optional().describe('Upper bound on answer count; 0 = unanswered questions only.'),
      sort: z.enum(['newest', 'hot']).optional().describe('Default newest; hot = recent engagement ranking.'),
      size: z.number().optional().describe('Page size (default 10, max 50).'),
      cursor: z.string().optional().describe('Continuation cursor from a previous call.'),
    },
    async (args: {
      tags?: string[];
      min_answers?: number;
      max_answers?: number;
      sort?: 'newest' | 'hot';
      size?: number;
      cursor?: string;
    }) => {
      try {
        const { items, hasMore, nextCursor } = await qaRecall.latestQuestions({
          tags: args.tags,
          minAnswers: args.min_answers,
          maxAnswers: args.max_answers,
          sort: args.sort,
          size: args.size,
          cursor: args.cursor,
        });
        if (!items.length) {
          return textResult(
            'No on-chain questions matched this filter. Tell the user honestly; do NOT invent questions.',
          );
        }
        const ordering = args.sort === 'hot' ? 'hot-ranked (last 7 days)' : 'newest first';
        const sections = [
          `${items.length} on-chain question(s), ${ordering}:`,
          formatQaQuestionBullets(items),
          'Reuse these bullet lines in your reply (titles stay pin:// links, authors stay metaid:// links, pinIds stay intact). When a question is squarely in your competence, answer it with post_simpleanswer.',
        ];
        if (hasMore && nextCursor) {
          sections.push(`More questions are available — call list_latest_questions again with cursor="${nextCursor}".`);
        }
        return textResult(sections.join('\n\n'));
      } catch (error) {
        return textResult(`Q&A feed failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
  );

  const getQuestionAnswers = tool(
    'get_question_answers',
    [
      'Get one on-chain question by pinId together with its answers, RANKED by community score (likes − dislikes, best first) — the ZhiHu/Quora page view of a question.',
      'Use after search_qa / list_latest_questions picked a question, or on any simplequestion pinId you hold. Answer summaries are ~200 chars; read the full body with read_metaweb_pin before relying on one. React with like_pin on answer pinIds.',
      '`publisher` (GlobalMetaID or MetaID) filters the answer list to one author — e.g. to review someone\'s (or your own) answers to this question before posting your own with post_simpleanswer.',
    ].join(' '),
    {
      question_pin_id: z.string().min(1).describe('pinId of the question (any version of it works).'),
      publisher: z.string().optional().describe('Filter answers to one publisher (GlobalMetaID or MetaID).'),
      size: z.number().optional().describe('Answer page size (default 50, max 50).'),
      cursor: z.string().optional().describe('Continuation cursor from a previous call.'),
    },
    async (args: { question_pin_id: string; publisher?: string; size?: number; cursor?: string }) => {
      const pinId = (args.question_pin_id ?? '').trim();
      if (!pinId) {
        return textResult('get_question_answers requires a non-empty `question_pin_id`.', true);
      }
      try {
        const detail = await qaRecall.questionDetail(pinId);
        let answers = detail.answers;
        let hasMore = detail.hasMore;
        let nextCursor = detail.nextCursor ?? null;
        if (args.publisher?.trim()) {
          const page = await qaRecall.questionAnswers({
            pinId,
            publisher: args.publisher,
            size: args.size,
            cursor: args.cursor,
          });
          answers = page.items;
          hasMore = page.hasMore;
          nextCursor = page.nextCursor ?? null;
        }
        const sections = [formatQaQuestionDetail({ question: detail.question, answers })];
        if (hasMore && nextCursor) {
          sections.push(`More answers are available — call get_question_answers again with cursor="${nextCursor}".`);
        }
        return textResult(sections.join('\n\n'));
      } catch (error) {
        if (error instanceof Error && error.name === 'QaRecallNotFoundError') {
          return textResult(
            `No on-chain question matches pinId "${pinId}" (missing, hidden, or not a simplequestion pin). Tell the user honestly; do NOT invent question data.`,
          );
        }
        return textResult(`Failed to fetch the question: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
  );

  return [searchQa, listLatestQuestions, getQuestionAnswers];
}
