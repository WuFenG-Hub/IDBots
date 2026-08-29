import { z } from 'zod';
import { stripLoneSurrogates, truncateUtf16Units } from './llmSafeText';
import type { MetaIdDetail, MetaIdSearchItem } from '../services/metaIdSearchService';

/** A search candidate from the MetaID aggregation API, marked when it is one of the user's own MetaBots. */
export type MetaIdSearchCandidate = MetaIdSearchItem & { isOwn?: boolean };
/** A full MetaID profile, marked when it is one of the user's own MetaBots. */
export type MetaIdProfile = MetaIdDetail & { isOwn?: boolean };

/**
 * Control surface the host (main.ts) provides for MetaID search tools.
 * Backed by the metaso-p2p MetaID aggregation API (GET /api/metaid/list and
 * GET /api/metaid/detail/:identity); items are pre-marked with isOwn when the
 * identity belongs to one of the user's MetaBots.
 */
export type MetaIdSearchControl = {
  search(input: {
    keyword?: string;
    skill?: string;
    chainName?: string;
    hasChatPubkey?: boolean;
    hasHomepage?: boolean;
    since?: number;
    until?: number;
    limit?: number;
    cursor?: string;
  }): Promise<{ items: MetaIdSearchCandidate[]; hasMore: boolean; nextCursor?: string | null }>;
  detail(identity: string): Promise<MetaIdProfile>;
};

/** Minimal shape of the claude-agent-sdk `tool()` helper we depend on. */
type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>
) => unknown;

const METAID_AVATAR_CONTENT_BASE_URL = 'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/';

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
  const clean = stripLoneSurrogates(value);
  return clean.length > max ? `${truncateUtf16Units(clean, max)}…` : clean;
}

/** Ready-to-quote markdown bullets for MetaID search candidates: names are already metaid:// links. */
export function formatMetaIdCandidates(items: MetaIdSearchCandidate[]): string {
  return items.map((item) => {
    const name = sanitizeLinkLabel(item.name || item.globalMetaId || 'unknown');
    const bio = item.bio ? ` — ${truncate(item.bio, 120)}` : '';
    const own = item.isOwn ? ' (your MetaBot)' : '';
    const meta = [
      item.chatSkills.length ? `skills: ${item.chatSkills.join(', ')}` : '',
      item.chainName ? `chain: ${item.chainName}` : '',
      item.hasChatPubkey ? 'open to private chat' : '',
      item.hasHomepage ? 'custom homepage' : '',
      item.updatedAt ? `updated: ${new Date(item.updatedAt * 1000).toISOString().slice(0, 10)}` : '',
    ].filter(Boolean).join(' | ');
    const head = `- [${name}](${metaIdUri(item.globalMetaId)})${own}${bio}`;
    return meta ? `${head}\n  ${meta}` : head;
  }).join('\n');
}

function formatJsonField(value: unknown, max: number): string {
  if (value == null) return '';
  try {
    return truncate(JSON.stringify(value), max);
  } catch {
    return '';
  }
}

/** Human-readable profile sheet for metaid_profile; the name line is a ready-to-quote metaid:// link. */
export function formatMetaIdProfile(profile: MetaIdProfile): string {
  const name = sanitizeLinkLabel(profile.name || profile.globalMetaId || 'unknown');
  const own = profile.isOwn ? ' (your MetaBot)' : '';
  const lines = [
    `Profile of [${name}](${metaIdUri(profile.globalMetaId)})${own}:`,
    `- globalMetaId: ${profile.globalMetaId}`,
  ];
  if (profile.chainName) lines.push(`- chain: ${profile.chainName}`);
  if (profile.address) lines.push(`- address: ${profile.address}`);
  if (profile.bio) lines.push(`- bio: ${profile.bio}`);
  if (profile.role) lines.push(`- role: ${profile.role}`);
  if (profile.soul) lines.push(`- soul: ${profile.soul}`);
  if (profile.goal) lines.push(`- goal: ${profile.goal}`);
  if (profile.chatSkills.length) lines.push(`- chatSkills: ${profile.chatSkills.join(', ')}`);
  if (profile.llm) {
    const llm = [profile.llm.provider, profile.llm.model].filter(Boolean).join('/');
    lines.push(`- llm: ${llm}${profile.llm.name ? ` (${profile.llm.name})` : ''}`);
  }
  const persona = formatJsonField(profile.persona, 400);
  if (persona) lines.push(`- persona: ${persona}`);
  const homepage = formatJsonField(profile.homepage, 300);
  if (homepage) lines.push(`- homepage: ${homepage}`);
  lines.push(`- private chat: ${profile.chatPubkey ? 'available (chatpubkey set)' : 'not available'}`);
  if (profile.avatarId) lines.push(`- avatar: ${METAID_AVATAR_CONTENT_BASE_URL}${profile.avatarId}`);
  if (profile.background) lines.push(`- background: ${profile.background}`);
  const created = profile.createdAt ? new Date(profile.createdAt * 1000).toISOString().slice(0, 10) : '';
  const updated = profile.updatedAt ? new Date(profile.updatedAt * 1000).toISOString().slice(0, 10) : '';
  if (created || updated) {
    lines.push(`- ${[created ? `registered: ${created}` : '', updated ? `last updated: ${updated}` : ''].filter(Boolean).join(' | ')}`);
  }
  return lines.join('\n');
}

/** Strip a metaid:// wrapper so the detail endpoint receives a bare identity. */
function parseIdentityInput(raw: string): string {
  const trimmed = raw.trim();
  const match = /^metaid:\/\/(.+)$/i.exec(trimmed);
  return (match?.[1] ?? trimmed).trim();
}

/**
 * Inline MCP tools that let any cowork session search on-chain MetaID
 * identities (bots and users) and fetch full profiles. Registered for every
 * session type when the host provides MetaIdSearchControl (see coworkRunner).
 * Browser-type sessions additionally have bot_browser_open_uri, so their
 * guidance tells the Agent to open the best match right away; other sessions
 * only present clickable metaid:// links and never touch the Bot Browser.
 */
export function buildMetaIdSearchAgentTools(deps: {
  tool: SdkToolFactory;
  metaIdSearch: MetaIdSearchControl;
  /** True for browser-type sessions (Bot Browser side panel with bot_browser_open_uri available). */
  openBestMatchInBrowser: boolean;
}): unknown[] {
  const { tool, metaIdSearch, openBestMatchInBrowser } = deps;

  const candidatesGuidance = openBestMatchInBrowser
    ? 'Pick the single best match for the user\'s intent and open their bot page with bot_browser_open_uri on metaid://<globalMetaId> (prefer newTab=true). When listing people in your reply, REUSE the bullet lines above verbatim: names MUST remain markdown links — never mention a person or bot as plain text. Offer 2–3 alternatives if the best one might not be what they meant; if nothing fits, say so instead of opening a random page. Use metaid_profile for a candidate\'s full profile.'
    : 'Present the candidates in your reply by REUSING the bullet lines above verbatim: names MUST remain clickable markdown links (metaid://<globalMetaId>) — never mention a person or bot as plain text, never shorten a globalMetaId. Highlight the single best match first, then offer 2–3 alternatives; if nothing fits, say so honestly. Do NOT open anything in the Bot Browser yourself: the user is working in this chat view and will click a name/link to open the bot page in the Bot Browser tab. Use metaid_profile for a candidate\'s full profile.';

  const profileGuidance = openBestMatchInBrowser
    ? 'Present these fields to the user with the name kept as a clickable link, and open their bot page with bot_browser_open_uri on the metaid:// URI above when the user wants to view it.'
    : 'Present these fields to the user with the name kept as a clickable metaid:// link. Do NOT open the Bot Browser yourself — the user clicks the link to view the bot page.';

  const searchMetaIds = tool(
    'search_metaids',
    'Search on-chain MetaID identities (bots AND users) — find a person or bot. Already hold an identity string (globalMetaId/address/metaid:// URI)? Call metaid_profile directly. For who is online right now use list_online_bots, for currently-online paid services use list_online_services, for social posts use search_social_posts, for apps use search_metaapps. Returns up to `limit` candidates, best first, markdown bullets with names as metaid://<globalMetaId> links. Use skill for skill lookups, chatOnly=true for users who can receive private messages.',
    {
      query: z.string().optional(),
      skill: z.string().optional(),
      chainName: z.string().optional(),
      chatOnly: z.boolean().optional(),
      hasHomepage: z.boolean().optional(),
      sinceDays: z.number().optional(),
      cursor: z.string().optional(),
      limit: z.number().optional(),
    },
    async (args: {
      query?: string;
      skill?: string;
      chainName?: string;
      chatOnly?: boolean;
      hasHomepage?: boolean;
      sinceDays?: number;
      cursor?: string;
      limit?: number;
    }) => {
      const limit = Math.min(20, Math.max(1, Math.floor(args.limit ?? 8)));
      const since = typeof args.sinceDays === 'number' && args.sinceDays > 0
        ? Math.floor(Date.now() / 1000) - Math.floor(args.sinceDays) * 86400
        : undefined;
      const request = {
        keyword: args.query,
        skill: args.skill,
        chainName: args.chainName,
        hasChatPubkey: args.chatOnly === true ? true : undefined,
        hasHomepage: args.hasHomepage === true ? true : undefined,
        since,
        limit,
        cursor: args.cursor,
      };
      try {
        let { items, hasMore, nextCursor } = await metaIdSearch.search(request);
        // Empty-result degradation: drop the weakest (last) query token once and retry.
        if (!items.length && !args.cursor && args.query?.trim()) {
          const tokens = args.query.trim().split(/\s+/);
          if (tokens.length > 1) {
            ({ items, hasMore, nextCursor } = await metaIdSearch.search({
              ...request,
              keyword: tokens.slice(0, -1).join(' '),
            }));
          }
        }
        if (!items.length) {
          return textResult(`No on-chain MetaID identities matched${args.query ? ` "${args.query}"` : ''}${args.skill ? ` with skill "${args.skill}"` : ''}${args.chainName ? ` on ${args.chainName}` : ''}. Tell the user honestly; do NOT invent people or bots.`);
        }
        const sections = [
          `${items.length} on-chain MetaID candidate(s), best first:`,
          formatMetaIdCandidates(items),
          candidatesGuidance,
        ];
        if (hasMore && nextCursor) {
          sections.push(`More results are available — call search_metaids again with cursor="${nextCursor}" if the user wants them.`);
        }
        return textResult(sections.join('\n\n'));
      } catch (error) {
        return textResult(`MetaID search failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
  );

  const metaIdProfile = tool(
    'metaid_profile',
    'Get the full on-chain profile of a specific MetaID identity (bot or user): name, avatar, bio, role/soul/goal, persona, LLM, chat skills, homepage, private-chat availability, timestamps. `identity` accepts a globalMetaId, a legacy metaId, an address, or a metaid://<globalMetaId> URI. Use after search_metaids when the user asks for details about a specific person/bot, or when you already hold an identity string. When NOT to use: do not call before you have a concrete identity — use search_metaids to find one first; and for that identity\'s social activity/posts use search_social_posts (publisher=identity), not this profile tool.',
    {
      identity: z.string().min(1),
    },
    async (args: { identity: string }) => {
      const identity = parseIdentityInput(args.identity ?? '');
      if (!identity) {
        return textResult('metaid_profile requires a non-empty identity (globalMetaId, metaId, address, or metaid:// URI).', true);
      }
      try {
        const profile = await metaIdSearch.detail(identity);
        return textResult([
          formatMetaIdProfile(profile),
          profileGuidance,
        ].join('\n\n'));
      } catch (error) {
        if (error instanceof Error && error.name === 'MetaIdSearchNotFoundError') {
          return textResult(`No on-chain MetaID identity matches "${identity}" (tried as globalMetaId/metaId/address). Tell the user honestly; do NOT invent a profile.`);
        }
        return textResult(`Failed to fetch the MetaID profile: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
  );

  return [searchMetaIds, metaIdProfile];
}
