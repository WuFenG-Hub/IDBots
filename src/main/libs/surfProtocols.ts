/**
 * MetaWeb surf protocol registry.
 *
 * One descriptor per surfable chain protocol: how to fetch fresh items since
 * the bot's watermark, how to search old items, which interactions the bot may
 * perform, and a relevance hint rendered into the surf prompt. Adding support
 * for a future protocol means adding one descriptor here — the surf loop
 * itself never hard-codes protocol behavior.
 */

import { getSocialFeed } from '../services/socialRecallService';
import { searchMetaweb, type MetawebSearchItem } from '../services/metawebSearchService';
import { qaLatestQuestions, qaSearch, type QaQuestionItem } from '../services/qaRecallService';
import { listPinsByPath, type ManapiPathListItem } from '../services/manapiPinService';

/** One content item surfaced to the bot during a surf run. */
export interface SurfItem {
  /** Pin id to deep-read (current version when the source folds revisions). */
  pinId: string;
  protocolKey: string;
  chainName: string;
  title: string;
  summary: string;
  authorName: string;
  authorGlobalMetaId: string;
  /** Unix seconds. */
  createdAt: number;
  likeCount: number | null;
  commentCount: number | null;
  /** Short protocol-specific note, e.g. "3 answers". */
  extra: string | null;
}

export type SurfInteraction = 'like' | 'comment' | 'answer' | 'ask' | 'post' | 'challenge';

export interface SurfProtocolDescriptor {
  key: string;
  displayName: string;
  /** Chain paths this protocol lives under — used for new-protocol discovery. */
  paths: string[];
  interactions: SurfInteraction[];
  /** Persona-matching guidance rendered into the surf prompt. */
  relevanceHint: string;
  fetchFresh: (input: { sinceTs: number | null; limit: number }) => Promise<SurfItem[]>;
  search?: (input: { query: string; limit: number }) => Promise<SurfItem[]>;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** contentSummary is truncated server-side and may not parse; best-effort. */
function extractJsonField(raw: string, field: string): string {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return text(parsed?.[field]);
  } catch {
    const match = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(raw);
    if (!match) return '';
    try {
      return JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return match[1];
    }
  }
}

const fromSocialPost = (item: import('../services/socialRecallService').SocialPostItem): SurfItem => ({
  pinId: item.currentPinId || item.pinId,
  protocolKey: 'simplebuzz',
  chainName: item.chainName || 'mvc',
  title: '',
  summary: (item.payload?.content ?? '').slice(0, 280),
  authorName: '',
  authorGlobalMetaId: item.author.globalMetaId,
  createdAt: item.createdAt,
  likeCount: item.likeCount,
  commentCount: item.commentCount,
  extra: item.quoteCount > 0 ? `${item.quoteCount} quotes` : null,
});

const fromSearchItem = (item: MetawebSearchItem, protocolKey: string): SurfItem => ({
  pinId: item.currentPinId || item.pinId,
  protocolKey,
  chainName: item.chainName || 'mvc',
  title: item.title,
  summary: item.summary,
  authorName: item.publisher.name,
  authorGlobalMetaId: item.publisher.globalMetaId,
  createdAt: item.createdAt,
  likeCount: null,
  commentCount: null,
  extra: null,
});

const fromQaQuestion = (item: QaQuestionItem): SurfItem => ({
  pinId: item.currentPinId || item.pinId,
  protocolKey: 'simplequestion',
  chainName: item.chainName || 'mvc',
  title: item.title,
  summary: item.summary,
  authorName: item.publisher.name,
  authorGlobalMetaId: item.publisher.globalMetaId,
  createdAt: item.createdAt,
  likeCount: item.likeCount,
  commentCount: item.commentCount,
  extra: item.answerCount > 0
    ? `${item.answerCount} answers`
    : 'unanswered',
});

const fromManapiItem = (item: ManapiPathListItem, protocolKey: string): SurfItem => {
  const title = extractJsonField(item.contentSummary, 'title');
  const content = extractJsonField(item.contentSummary, 'content');
  const slug = extractJsonField(item.contentSummary, 'slug');
  return {
    pinId: item.pinId,
    protocolKey,
    chainName: 'mvc',
    title,
    summary: (content || item.contentSummary).slice(0, 280),
    authorName: '',
    authorGlobalMetaId: item.globalMetaId,
    createdAt: item.timestamp || item.seenTime,
    likeCount: null,
    commentCount: null,
    extra: slug ? `entry: ${slug}` : null,
  };
};

const sinceFiltered = (items: SurfItem[], sinceTs: number | null, limit: number): SurfItem[] =>
  items
    .filter((item) => item.pinId && (sinceTs === null || item.createdAt > sinceTs))
    .slice(0, limit);

const simplebuzz: SurfProtocolDescriptor = {
  key: 'simplebuzz',
  displayName: 'Buzz (链上推特)',
  paths: ['/protocols/simplebuzz'],
  interactions: ['like', 'comment'],
  relevanceHint:
    'Short posts. Save the ones that teach something about your role or goals; ' +
    'like genuinely good content; comment only when you have something real to add.',
  fetchFresh: async ({ sinceTs, limit }) => {
    const page = await getSocialFeed({ since: sinceTs ?? undefined, size: limit, sort: 'newest' });
    return sinceFiltered(page.items.map(fromSocialPost), sinceTs, limit);
  },
  search: async ({ query, limit }) => {
    const page = await getSocialFeed({ keyword: query, size: limit, sort: 'newest' });
    return page.items.map(fromSocialPost).slice(0, limit);
  },
};

const simplenote: SurfProtocolDescriptor = {
  key: 'simplenote',
  displayName: 'SimpleNote (链上博客)',
  paths: ['/protocols/simplenote'],
  interactions: ['like', 'comment'],
  relevanceHint:
    'Long-form articles. Your main learning source: save articles that deepen ' +
    'your professional knowledge, distill key points into your knowledge store.',
  fetchFresh: async ({ sinceTs, limit }) => {
    const page = await listPinsByPath({ path: '/protocols/simplenote', size: limit });
    return sinceFiltered(page.items.map((item) => fromManapiItem(item, 'simplenote')), sinceTs, limit);
  },
  search: async ({ query, limit }) => {
    const page = await searchMetaweb({ q: query, protocols: ['simplenote'], size: limit });
    return page.items.map((item) => fromSearchItem(item, 'simplenote')).slice(0, limit);
  },
};

const simplequestion: SurfProtocolDescriptor = {
  key: 'simplequestion',
  displayName: 'Q&A (链上问答)',
  paths: ['/protocols/simplequestion', '/protocols/simpleanswer'],
  interactions: ['like', 'answer', 'ask', 'comment'],
  relevanceHint:
    'Community questions. Answer only questions squarely inside your role and ' +
    'expertise, with genuinely helpful answers; like good answers from others; ' +
    'ask a question yourself only when you truly need help.',
  fetchFresh: async ({ sinceTs, limit }) => {
    // The questions feed has no server-side since filter; filter client-side.
    const page = await qaLatestQuestions({ size: Math.min(50, limit * 2), sort: 'newest' });
    return sinceFiltered(page.items.map(fromQaQuestion), sinceTs, limit);
  },
  search: async ({ query, limit }) => {
    const page = await qaSearch({ q: query, size: limit });
    return page.items.map(fromQaQuestion).slice(0, limit);
  },
};

const agentpedia: SurfProtocolDescriptor = {
  key: 'agentpedia',
  displayName: 'Agentpedia (链上百科)',
  paths: ['/protocols/agentpedia/rev'],
  interactions: ['challenge'],
  relevanceHint:
    'The shared encyclopedia bots reach consensus from. Learn entries related ' +
    'to your role. Conservative mode: only challenge an entry when you are ' +
    'confident it is factually wrong — never for style or wording.',
  fetchFresh: async ({ sinceTs, limit }) => {
    const page = await listPinsByPath({ path: '/protocols/agentpedia/rev', size: limit });
    return sinceFiltered(page.items.map((item) => fromManapiItem(item, 'agentpedia')), sinceTs, limit);
  },
};

/** Default registry; the surf service accepts an override for tests. */
export const DEFAULT_SURF_PROTOCOLS: SurfProtocolDescriptor[] = [
  simplebuzz,
  simplenote,
  simplequestion,
  agentpedia,
];
