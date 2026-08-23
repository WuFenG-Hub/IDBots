import { z } from 'zod';
import type { MetawebSearchItem, MetawebSearchProtocol } from '../services/metawebSearchService';
import type { MetawebPin } from '../services/metawebPinService';

/**
 * Control surface the host (main.ts) provides for the MetaWeb learning tools.
 * Backed by the metaso-p2p /api/metaweb/* aggregation APIs
 * (so.metaid.io): unified cross-protocol search + generic pin read — the
 * bot's window into the Agent Internet knowledge base.
 */
export type MetawebLearningControl = {
  search(input: {
    q: string;
    protocols?: MetawebSearchProtocol[];
    publisher?: string;
    since?: number;
    until?: number;
    sort?: 'relevance' | 'newest';
    size?: number;
    cursor?: string;
  }): Promise<{ items: MetawebSearchItem[]; hasMore: boolean; nextCursor?: string | null }>;
  readPin(pinId: string): Promise<MetawebPin>;
};

/** Minimal shape of the claude-agent-sdk `tool()` helper we depend on. */
type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>
) => unknown;

const PROTOCOL_KEYS = ['simplenote', 'simplebuzz', 'metaapp', 'metabot-skill', 'skill-service', 'metaprotocol'] as const;

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** UTC "YYYY-MM-DD HH:MM" — the MetaWeb APIs return Unix seconds. */
function formatTime(ts: number): string {
  return ts ? `${new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
}

function publisherName(item: MetawebSearchItem): string {
  return item.publisher.name || item.publisher.globalMetaId || item.publisher.metaid || 'unknown';
}

/** Ready-to-scan markdown bullets for search candidates; each carries the pin id to open. */
export function formatMetawebSearchBullets(items: MetawebSearchItem[]): string {
  return items.map((item) => {
    const title = item.title || '(untitled)';
    const summary = item.summary ? ` — ${truncate(item.summary.replace(/\s+/g, ' '), 140)}` : '';
    const meta = [
      `protocol: ${item.protocol || 'unknown'}`,
      `by ${publisherName(item)}`,
      formatTime(item.createdAt),
      item.tags.length ? `tags: ${item.tags.join(', ')}` : '',
      `pin: ${item.currentPinId || item.pinId}`,
    ].filter(Boolean).join(' | ');
    return `- **${title}**${summary}\n  ${meta}`;
  }).join('\n');
}

/**
 * Follow-up hints per protocol, appended to read_metaweb_pin output: where to
 * go when the pin body is only a summary of a richer package. Keeps the
 * search → read → deep-read/install chain closed without hardcoding it into
 * the model's prompt.
 */
const PROTOCOL_FOLLOWUP_HINTS: Record<string, string> = {
  metaapp: 'this is an on-chain MetaApp package and the content above is only its intro — read its full agent-facing documentation (APP.md) with skill_tool extract_metaapp using this pinId.',
  'metabot-skill': 'this is an on-chain skill package — install it with skill_tool install_skill (pass the package metafile:// URI from the payload, e.g. the skill-file field, as the zip source), then verify with list_installed_skills / read_skill.',
};

/** Human-readable sheet for read_metaweb_pin; the creator line keeps a ready-to-quote metaid:// link. */
export function formatMetawebPinDetail(pin: MetawebPin): string {
  const creatorLabel = pin.creator.name || pin.creator.globalMetaId || pin.creator.metaid || pin.creator.address || 'unknown';
  const creatorPart = pin.creator.globalMetaId
    ? `[${creatorLabel.replace(/[[\]]/g, '')}](metaid://${pin.creator.globalMetaId})`
    : creatorLabel;
  const lines = [
    `Pin ${pin.pinId}:`,
    `- title: ${pin.meta.title || '(untitled)'}`,
  ];
  lines.push(`- protocol: ${pin.protocol || 'unknown'}${pin.path ? ` (${pin.path})` : ''} | chain: ${pin.chainName || 'unknown'} | source: ${pin.source}`);
  lines.push(`- author: ${creatorPart}`);
  if (pin.createdAt) lines.push(`- created: ${formatTime(pin.createdAt)}`);
  if (pin.operation !== 'create') lines.push(`- operation: ${pin.operation}${pin.currentPinId && pin.currentPinId !== pin.pinId ? ` (latest: ${pin.currentPinId})` : ''}`);
  if (pin.meta.tags.length) lines.push(`- tags: ${pin.meta.tags.join(', ')}`);
  if (pin.attachments.length) {
    lines.push(`- attachments: ${pin.attachments.map((att) => att.url || att.uri).filter(Boolean).join(', ')}`);
  }
  const followupHint = PROTOCOL_FOLLOWUP_HINTS[pin.protocol];
  if (followupHint) lines.push(`- next: ${followupHint}`);
  if (pin.text != null) {
    const sizeNote = pin.truncated === true && pin.totalLength != null
      ? ` (showing first ${pin.text.length} of ${pin.totalLength} runes — server-side truncated)`
      : '';
    lines.push(`- content${sizeNote}:`);
    lines.push(pin.text);
  }
  return lines.join('\n');
}

/**
 * Inline MCP tools that let any cowork session search MetaWeb knowledge and
 * read pins — same always-on posture as search_social_posts (see
 * coworkRunner). search_metaweb is the search engine; read_metaweb_pin is
 * "click the result". The pair implements progressive disclosure: candidates
 * with title/summary first, full content only for the 1-3 pins the Agent
 * actually picks.
 */
export function buildMetawebLearningAgentTools(deps: {
  tool: SdkToolFactory;
  metawebLearning: MetawebLearningControl;
}): unknown[] {
  const { tool, metawebLearning } = deps;

  const searchGuidance = [
    'Judge these candidates by title + summary, then open the 1-3 most promising pins with read_metaweb_pin (use the pin: ids above verbatim — they work for any protocol).',
    'Answer only from what you actually read, and cite the pinIds you used so the user can verify.',
    'If nothing looks useful, try again with broader or different keywords (fewer terms, synonyms, or the other language — Chinese ↔ English) before concluding MetaWeb has no answer; if it truly has none, say so honestly. Never invent pins, titles, publishers, or content.',
  ].join(' ');

  const searchMetaweb = tool(
    'search_metaweb',
    'Search MetaWeb (the Agent Internet) — your external brain carrying tutorials, how-to guides, skill packages, service listings, apps, and experience posts published by other bots, across protocols (simplenote, simplebuzz, metaapp, metabot-skill, skill-service, metaprotocol). Trigger liberally when the user asks about something you do not reliably know — IDBots/MetaBot usage, agent skills and how to install them, MetaWeb protocols, "how do I …" tasks — or when fresher authoritative knowledge may exist on-chain. Derive the keywords yourself from the user\'s actual need (never hardcode or ask the user for search terms). The corpus is currently predominantly Chinese: after a query in one language, if the results do not directly answer the question, ALWAYS retry with translated keywords in the other language (English ↔ Chinese) before concluding MetaWeb lacks the knowledge. Returns up to `size` relevance-ranked candidates with protocol/title/summary/publisher/pinId; this is the results page, not the content — open chosen pins with read_metaweb_pin. Not for people/identity lookup (search_metaids), app browsing (search_metaapps), or social buzz feeds (search_social_posts).',
    {
      query: z.string().min(1),
      protocols: z.array(z.enum(PROTOCOL_KEYS)).optional(),
      publisher: z.string().optional(),
      sinceDays: z.number().optional(),
      since: z.number().optional(),
      until: z.number().optional(),
      sort: z.enum(['relevance', 'newest']).optional(),
      size: z.number().optional(),
      cursor: z.string().optional(),
    },
    async (args: {
      query: string;
      protocols?: MetawebSearchProtocol[];
      publisher?: string;
      sinceDays?: number;
      since?: number;
      until?: number;
      sort?: 'relevance' | 'newest';
      size?: number;
      cursor?: string;
    }) => {
      const q = (args.query ?? '').trim();
      if (!q) {
        return textResult('search_metaweb requires a non-empty query.', true);
      }
      const size = Math.min(50, Math.max(1, Math.floor(args.size ?? 10)));
      const since = typeof args.sinceDays === 'number' && args.sinceDays > 0
        ? Math.floor(Date.now() / 1000) - Math.floor(args.sinceDays) * 86400
        : args.since;
      try {
        const { items, hasMore, nextCursor } = await metawebLearning.search({
          q,
          protocols: args.protocols,
          publisher: args.publisher,
          since,
          until: args.until,
          sort: args.sort,
          size,
          cursor: args.cursor,
        });
        if (!items.length) {
          return textResult(`No MetaWeb content matched "${q}". Try again with broader or different keywords (fewer terms, synonyms, or the other language — Chinese ↔ English). If several attempts find nothing, tell the user honestly that MetaWeb does not cover this yet and fall back to your own knowledge; do NOT invent pins or content.`);
        }
        const sections = [
          `${items.length} MetaWeb result(s) for "${q}"${args.protocols?.length ? ` (protocols: ${args.protocols.join(', ')})` : ''}:`,
          formatMetawebSearchBullets(items),
          searchGuidance,
        ];
        // Deterministic language nudge: the corpus is currently Chinese-heavy,
        // so a pure-ASCII (English) query deserves an explicit retry reminder
        // when results may be off-topic.
        if (/^[\x00-\x7F]+$/.test(q)) {
          sections.push('Language note: MetaWeb content is currently predominantly Chinese. If these results do not directly answer the question, retry with translated Chinese keywords before answering — do not settle for weak or off-topic results.');
        }
        if (hasMore && nextCursor) {
          sections.push(`More results are available — call search_metaweb again with cursor="${nextCursor}" if you want them.`);
        }
        return textResult(sections.join('\n\n'));
      } catch (error) {
        return textResult(`MetaWeb search failed: ${error instanceof Error ? error.message : String(error)}. Tell the user MetaWeb search is temporarily unavailable and answer from your own knowledge instead.`, true);
      }
    }
  );

  const readMetawebPin = tool(
    'read_metaweb_pin',
    'Open one MetaWeb pin by pinId and read its full content — the "click the search result" step after search_metaweb. Works for any protocol (simplenote, simplebuzz, metaapp, metabot-skill, skill-service, …); you do NOT need to know which protocol the pin belongs to, and any version of a pinId resolves to the latest version. Returns title/meta, the normalized markdown body, resolved attachment URLs, and the author. The body may be server-side truncated (truncated=true with totalLength); work with the head you received. Pins with null content are encrypted or empty — skip them and try another result. Requires an existing pinId — to discover pins use search_metaweb first.',
    {
      pinId: z.string().min(1),
    },
    async (args: { pinId: string }) => {
      const pinId = (args.pinId ?? '').trim();
      if (!pinId) {
        return textResult('read_metaweb_pin requires a non-empty pinId.', true);
      }
      try {
        const pin = await metawebLearning.readPin(pinId);
        if (pin.text == null) {
          return textResult(`Pin "${pinId}" (${pin.protocol || 'unknown protocol'}) has no readable text content (encrypted, binary, or empty). Skip it and try another search result; do NOT invent its content.`);
        }
        return textResult(formatMetawebPinDetail(pin));
      } catch (error) {
        if (error instanceof Error && error.name === 'MetawebPinNotFoundError') {
          return textResult(`No MetaWeb pin matches "${pinId}" (it does not exist or was revoked). Tell the user honestly; do NOT invent pin content.`);
        }
        return textResult(`Failed to read the MetaWeb pin: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
  );

  return [searchMetaweb, readMetawebPin];
}
