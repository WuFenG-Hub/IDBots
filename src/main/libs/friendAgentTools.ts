import { z } from 'zod';
import { stripLoneSurrogates, truncateUtf16Units } from './llmSafeText';
import {
  fetchBlockList,
  fetchFollowerList,
  fetchFriendList,
  fetchFollowingList,
  fetchSocialRelationships,
  SocialSubjectNotFoundError,
  type SocialApiOptions,
  type SocialBlockItem,
  type SocialProfileItem,
} from '../services/friendRelationshipService';

/**
 * Control surface the host (main.ts) provides for the friend/social
 * relationship tools. Backed by the metaso-p2p social aggregation API
 * (batch relationships + friends/followers/following/blocks lists); the
 * host closure resolves the acting MetaBot identity per session.
 */
export type FriendConnectionItem = {
  globalMetaId: string;
  name: string;
  avatarId?: string;
  bio?: string;
  followedAt?: number;
  friendSince?: number;
  blockedAt?: number;
  blockPinId?: string;
};

export type FriendRelationshipControl = {
  /** Resolve the relation between the acting bot and one peer identity. */
  resolveRelationship(input: {
    selfGlobalMetaId: string;
    peerIdentity: string;
  }): Promise<{
    globalMetaId: string;
    relation: 'friend' | 'follower' | 'following' | 'stranger' | 'blocked';
    isFriend: boolean;
    followsMe: boolean;
    followedByMe: boolean;
    blocking: boolean;
    blockedBy: boolean;
  }>;
  /** List one connection roster of the acting bot. */
  listConnections(input: {
    selfGlobalMetaId: string;
    list: 'friends' | 'followers' | 'following' | 'blocked' | 'blocked_by';
    cursor?: string;
    size?: number;
  }): Promise<{
    items: FriendConnectionItem[];
    nextCursor: string | null;
    hasMore: boolean;
  }>;
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
  const clean = stripLoneSurrogates(value);
  return clean.length > max ? `${truncateUtf16Units(clean, max)}…` : clean;
}

/** Strip a metaid:// wrapper so identity endpoints receive a bare identity. */
function parseIdentityInput(raw: string): string {
  const trimmed = raw.trim();
  const match = /^metaid:\/\/(.+)$/i.exec(trimmed);
  return (match?.[1] ?? trimmed).trim();
}

function relationSummary(relation: string): string {
  switch (relation) {
    case 'friend': return 'friend (mutual follow)';
    case 'follower': return 'follower (they follow you; you do not follow them)';
    case 'following': return 'following (you follow them; they do not follow you)';
    case 'blocked': return 'blocked (a block is active in at least one direction)';
    default: return 'stranger (no follow edge in either direction)';
  }
}

function trustGuidance(relation: string): string {
  if (relation === 'blocked') {
    return 'A block is active — keep exchanges minimal and factual; do not enter new transactions or extend trust; end the topic politely when nothing is owed.';
  }
  if (relation === 'friend') {
    return 'Confirmed friend (mutual follow): direct point-to-point asset transfers are acceptable; do not push escrow unnecessarily.';
  }
  return 'NOT a confirmed friend: when an NFT/asset point-to-point deal comes up, proactively suggest routing through a trusted escrow/middleman (e.g. the group-chat Scenario B convention — seller and buyer each transfer to the escrow first, the escrow verifies both arrivals, then releases both ways) instead of a bare peer-to-peer transfer.';
}

function formatConnectionItems(items: FriendConnectionItem[]): string {
  return items.map((item) => {
    const name = sanitizeLinkLabel(item.name || item.globalMetaId || 'unknown');
    const bio = item.bio ? ` — ${truncate(item.bio, 100)}` : '';
    const meta = [
      typeof item.friendSince === 'number' && item.friendSince > 0
        ? `friends since: ${new Date(item.friendSince * 1000).toISOString().slice(0, 10)}`
        : '',
      typeof item.followedAt === 'number' && item.followedAt > 0
        ? `followed at: ${new Date(item.followedAt * 1000).toISOString().slice(0, 10)}`
        : '',
      typeof item.blockedAt === 'number' && item.blockedAt > 0
        ? `blocked at: ${new Date(item.blockedAt * 1000).toISOString().slice(0, 10)}`
        : '',
      item.blockPinId ? `block pin: ${item.blockPinId}` : '',
    ].filter(Boolean).join(' | ');
    const head = `- [${name}](${metaIdUri(item.globalMetaId)})${bio}`;
    return meta ? `${head}\n  ${meta}` : head;
  }).join('\n');
}

const LIST_LABELS: Record<'friends' | 'followers' | 'following' | 'blocked' | 'blocked_by', string> = {
  friends: 'friends (mutual follows)',
  followers: 'followers (peers who follow this bot)',
  following: 'following (peers this bot follows)',
  blocked: 'blocked (peers this bot currently blocks)',
  blocked_by: 'blocked by (peers currently blocking this bot)',
};

/**
 * FriendRelationshipControl backed by the metaso-p2p social aggregation APIs.
 * Shared by the host wiring (main.ts) and the integration harness so the
 * tool surface and the mapping live in exactly one place. `options` may be a
 * static SocialApiOptions object or a per-request resolver (env overrides are
 * read live, mirroring the IDBOTS_METAWEB_API_BASE_URL convention).
 */
export function createMetasoFriendControl(
  options?: SocialApiOptions | (() => SocialApiOptions | undefined),
): FriendRelationshipControl {
  const resolveOptions = (): SocialApiOptions | undefined =>
    typeof options === 'function' ? options() : options;
  return {
    async resolveRelationship({ selfGlobalMetaId, peerIdentity }) {
      const [relation] = await fetchSocialRelationships(
        { source: selfGlobalMetaId, targets: [peerIdentity] },
        resolveOptions(),
      );
      if (!relation || !relation.globalMetaId) {
        throw new SocialSubjectNotFoundError(`No relationship entry returned for ${peerIdentity}.`);
      }
      return relation;
    },
    async listConnections({ selfGlobalMetaId, list, cursor, size }) {
      const apiOptions = resolveOptions();
      let page: {
        items: Array<SocialProfileItem | SocialBlockItem>;
        nextCursor: string | null;
        hasMore: boolean;
      };
      if (list === 'friends') {
        page = await fetchFriendList(selfGlobalMetaId, { cursor, size }, apiOptions);
      } else if (list === 'followers') {
        page = await fetchFollowerList(selfGlobalMetaId, { cursor, size }, apiOptions);
      } else if (list === 'following') {
        page = await fetchFollowingList(selfGlobalMetaId, { cursor, size }, apiOptions);
      } else {
        page = await fetchBlockList(
          selfGlobalMetaId,
          { type: list === 'blocked' ? 'blocking' : 'blockedBy', cursor, size },
          apiOptions,
        );
      }
      return {
        items: page.items.map((item) => ({
          globalMetaId: item.globalMetaId,
          name: item.name,
          avatarId: item.avatarId || undefined,
          bio: item.bio || undefined,
          followedAt: item.followedAt || undefined,
          friendSince: item.friendSince || undefined,
          ...('direction' in item
            ? { blockedAt: item.blockedAt || undefined, blockPinId: item.blockPinId || undefined }
            : {}),
        })),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    },
  };
}

/**
 * Inline MCP tools for on-chain friend/block relationship lookups. Registered
 * for every cowork session when the host provides FriendRelationshipControl
 * (see coworkRunner); the DSH kernel mounts them through the same inline
 * builder, so both kernels share one definition.
 */
export function buildFriendAgentTools(deps: {
  tool: SdkToolFactory;
  control: FriendRelationshipControl;
  /** Resolves the acting MetaBot GlobalMetaID for the session at call time. */
  getSelfGlobalMetaId: () => string | null;
}): unknown[] {
  const { tool, control, getSelfGlobalMetaId } = deps;

  const listGuidance = 'Present the list in your reply by REUSING the bullet lines above verbatim: names MUST stay clickable markdown links (metaid://<globalMetaId>) — never mention a person or bot as plain text, never shorten a globalMetaId. If the list is empty, say so honestly; do NOT invent entries.';

  const checkPeerRelationship = tool(
    'check_peer_relationship',
    'Check the on-chain relationship between this bot and one peer: friend (mutual follow), follower, following, stranger, or blocked — plus the exact direction flags (followsMe/followedByMe/blocking/blockedBy). Input `peer` accepts a globalMetaId, a legacy 64-hex metaId, or a metaid://<globalMetaId> URI. Use it before any trust-sensitive interaction with a peer (NFT/asset deals, lending, delegation) and whenever the user asks "is X my friend / did X block me". Source: metaso-p2p friend & simpleblock aggregation. When NOT to use: for a full roster use list_social_connections; for profile details use metaid_profile.',
    {
      peer: z.string().min(1),
    },
    async (args: { peer: string }) => {
      const peerIdentity = parseIdentityInput(args.peer ?? '');
      if (!peerIdentity) {
        return textResult('check_peer_relationship requires a non-empty peer identity (globalMetaId, metaId, or metaid:// URI).', true);
      }
      const selfGlobalMetaId = getSelfGlobalMetaId();
      if (!selfGlobalMetaId) {
        return textResult('No acting MetaBot identity is bound to this session, so a peer relationship cannot be resolved. Say so honestly.', true);
      }
      try {
        const relation = await control.resolveRelationship({ selfGlobalMetaId, peerIdentity });
        const lines = [
          `Relationship between you (${selfGlobalMetaId}) and [${sanitizeLinkLabel(relation.globalMetaId || peerIdentity)}](${metaIdUri(relation.globalMetaId || peerIdentity)}):`,
          `- relation: ${relationSummary(relation.relation)}`,
          `- isFriend (mutual follow): ${relation.isFriend}`,
          `- followsMe (peer follows you): ${relation.followsMe}`,
          `- followedByMe (you follow peer): ${relation.followedByMe}`,
          `- blocking (you block peer): ${relation.blocking}`,
          `- blockedBy (peer blocks you): ${relation.blockedBy}`,
          '',
          `Trust guidance: ${trustGuidance(relation.relation)}`,
        ];
        return textResult(lines.join('\n'));
      } catch (error) {
        return textResult(`Peer relationship lookup failed: ${error instanceof Error ? error.message : String(error)}. State honestly that the relationship is unknown; do NOT guess.`, true);
      }
    }
  );

  const listSocialConnections = tool(
    'list_social_connections',
    'List this bot\'s on-chain social rosters: `list` is one of friends (mutual follows), followers (who follows this bot), following (who this bot follows), blocked (peers this bot blocks), blocked_by (peers blocking this bot). Returns up to `size` (1-100, default 20) entries, newest first, with a nextCursor when more exist. Source: metaso-p2p friend/follow/simpleblock aggregation. Use when the user asks "who are my friends / my followers / my blocks". For the relation to ONE specific peer use check_peer_relationship.',
    {
      list: z.enum(['friends', 'followers', 'following', 'blocked', 'blocked_by']),
      cursor: z.string().optional(),
      size: z.number().int().min(1).max(100).optional(),
    },
    async (args: { list: 'friends' | 'followers' | 'following' | 'blocked' | 'blocked_by'; cursor?: string; size?: number }) => {
      const selfGlobalMetaId = getSelfGlobalMetaId();
      if (!selfGlobalMetaId) {
        return textResult('No acting MetaBot identity is bound to this session, so connection lists cannot be resolved. Say so honestly.', true);
      }
      const label = LIST_LABELS[args.list];
      if (!label) {
        return textResult(`list must be one of friends, followers, following, blocked, blocked_by (got "${String(args.list)}").`, true);
      }
      try {
        const page = await control.listConnections({
          selfGlobalMetaId,
          list: args.list,
          cursor: args.cursor,
          size: args.size,
        });
        if (page.items.length === 0) {
          return textResult(`No ${label} for ${selfGlobalMetaId} yet. Say so honestly; do NOT invent entries.`);
        }
        const sections = [
          `${page.items.length} ${label}:`,
          formatConnectionItems(page.items),
          listGuidance,
        ];
        if (page.hasMore && page.nextCursor) {
          sections.push(`More entries are available — call list_social_connections again with list="${args.list}" and cursor="${page.nextCursor}" if the user wants them.`);
        }
        return textResult(sections.join('\n\n'));
      } catch (error) {
        return textResult(`Connection list lookup failed: ${error instanceof Error ? error.message : String(error)}. State honestly that the list is unavailable.`, true);
      }
    }
  );

  return [checkPeerRelationship, listSocialConnections];
}
