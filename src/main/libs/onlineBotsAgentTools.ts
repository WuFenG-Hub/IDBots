import { z } from 'zod';
import { stripLoneSurrogates, truncateUtf16Units } from './llmSafeText';

/**
 * One identity (bot or user) currently online in the shared idchat presence
 * registry. Row shape mirrors IdchatPresenceService.fetchOnlineUsers with the
 * profile fields (name/bio) flattened from the endpoint's userInfo payload.
 */
export type OnlineBotRow = {
  globalMetaId: string;
  name: string;
  bio: string;
  lastSeenAgoSeconds: number;
  deviceCount: number;
  isOwn?: boolean;
};

/**
 * Control surface the host (main.ts) provides for online-presence discovery.
 * Backed by IdchatPresenceService.fetchOnlineUsers (GET
 * /group-chat/socket/online-users) — the same registry that powers group-chat
 * presence and OpenTeam invites. Matches OAC `network bots --online`.
 */
export type OnlineBotsControl = {
  listOnlineBots(input: { cursor: number; limit: number }): Promise<{
    total: number;
    onlineWindowSeconds: number;
    list: OnlineBotRow[];
  }>;
};

/** Minimal shape of the claude-agent-sdk `tool()` helper we depend on. */
type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>
) => unknown;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_NAME_CHARS = 24;
const MAX_BIO_CHARS = 60;

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

function escapeTableCell(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

function truncate(value: string, max: number): string {
  const clean = stripLoneSurrogates(value);
  return clean.length > max ? `${truncateUtf16Units(clean, max)}…` : clean;
}

function clampLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)));
}

function clampCursor(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/**
 * Bot bios on the presence endpoint are frequently JSON blobs
 * (role/soul/goal/...) rather than prose. For a table cell keep the readable
 * persona fields; anything else falls back to the raw text.
 */
export function summarizeBio(raw: string): string {
  const text = (raw ?? '').trim();
  if (!text) return '';
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of ['role', 'soul', 'goal', 'background']) {
        const value = parsed[key];
        if (typeof value === 'string' && value.trim()) {
          parts.push(value.trim());
        }
        if (parts.length >= 2) break;
      }
      if (parts.length > 0) return parts.join(' · ');
    } catch {
      // Not valid JSON — fall through to the raw text.
    }
  }
  return text;
}

function formatNameCell(row: OnlineBotRow): string {
  const gmid = row.globalMetaId;
  if (!gmid) return '-';
  const name = sanitizeLinkLabel((row.name ?? '').trim());
  const own = row.isOwn ? ' (your MetaBot)' : '';
  if (name) {
    return `[${escapeTableCell(truncate(name, MAX_NAME_CHARS))}](${metaIdUri(gmid)})${own}`;
  }
  return `[${gmid}](${metaIdUri(gmid)})${own}`;
}

function formatIdentityCell(row: OnlineBotRow): string {
  const gmid = row.globalMetaId;
  if (!gmid) return '-';
  return `[${gmid}](${metaIdUri(gmid)})`;
}

function formatLastSeen(row: OnlineBotRow): string {
  if (typeof row.lastSeenAgoSeconds !== 'number' || !Number.isFinite(row.lastSeenAgoSeconds)) {
    return '-';
  }
  return `${Math.max(0, Math.floor(row.lastSeenAgoSeconds))}s 🟢`;
}

/** Markdown table matching OAC `network bots --online`, with metaid:// links. */
export function formatOnlineBotsTable(rows: OnlineBotRow[]): string {
  const header = [
    '| # | name | globalMetaId | bio | Last Seen |',
    '|---|------|--------------|-----|-----------|',
  ];
  const body = rows.map((row, index) => {
    const bio = escapeTableCell(truncate(summarizeBio(row.bio), MAX_BIO_CHARS));
    return `| ${index + 1} | ${formatNameCell(row)} | ${formatIdentityCell(row)} | ${bio || '-'} | ${formatLastSeen(row)} |`;
  });
  return [...header, ...body].join('\n');
}

/**
 * Inline MCP tool that lists who is online RIGHT NOW in the MetaID network
 * presence registry (bots and users). Registered for every cowork surface
 * when the host provides OnlineBotsControl (see coworkRunner). Distinct from
 * search_metaids (on-chain identity search, no presence) and from
 * list_online_services (orderable paid services).
 */
export function buildOnlineBotsAgentTools(deps: {
  tool: SdkToolFactory;
  onlineBots: OnlineBotsControl;
  /** True for browser-type sessions (Bot Browser side panel with bot_browser_open_uri available). */
  openBestMatchInBrowser: boolean;
}): unknown[] {
  const { tool, onlineBots, openBestMatchInBrowser } = deps;

  const tableGuidance = openBestMatchInBrowser
    ? 'Present the table to the user by REUSING it verbatim: names/globalMetaIds MUST remain markdown links — never mention an identity as plain text, never shorten a globalMetaId. If the user wants to view an identity\'s Bot page, open it with bot_browser_open_uri on metaid://<globalMetaId> (prefer newTab=true). Use metaid_profile for a full profile.'
    : 'Present the table to the user by REUSING it verbatim: names/globalMetaIds MUST remain clickable markdown links (metaid://<globalMetaId>) — never mention an identity as plain text, never shorten a globalMetaId. Do NOT open anything in the Bot Browser yourself. Use metaid_profile for a full profile.';

  const listOnlineBots = tool(
    'list_online_bots',
    'List who is online RIGHT NOW in the MetaID network presence registry — bots and users with a heartbeat inside the live presence window. Use when the user asks who is online, who is currently present, or who is available to chat / invite / collaborate right now. When NOT to use: finding a person or bot by name, personality, or skill regardless of presence (search_metaids), orderable paid services (list_online_services), or social posts (search_social_posts) — presence means reachable now, not offering a service. Returns a markdown table of up to `limit` rows (1-100, default 20) with name, metaid:// globalMetaId links, bio, and last-seen. Page with cursor.',
    {
      limit: z.number().optional(),
      cursor: z.number().optional(),
    },
    async (args: { limit?: number; cursor?: number }) => {
      const limit = clampLimit(args.limit);
      const cursor = clampCursor(args.cursor);
      try {
        const page = await onlineBots.listOnlineBots({ cursor, limit });
        const rows = Array.isArray(page.list) ? page.list.filter((row) => (row?.globalMetaId ?? '').trim()) : [];
        const total = Math.max(0, Math.floor(page.total ?? 0));
        if (!rows.length) {
          return textResult('No identities are currently online in the presence registry. Tell the user honestly; do NOT invent people.');
        }
        const shownFrom = cursor + 1;
        const shownTo = cursor + rows.length;
        const windowMinutes = Math.max(1, Math.round((page.onlineWindowSeconds || 0) / 60));
        const sections = [
          `Currently online identities (${shownFrom}–${shownTo} of ${total}; presence window ≈ ${windowMinutes} min):`,
          formatOnlineBotsTable(rows),
          tableGuidance,
        ];
        if (cursor + rows.length < total) {
          sections.push(`More online identities are available — call list_online_bots again with cursor=${cursor + rows.length} if the user wants them.`);
        }
        return textResult(sections.join('\n\n'));
      } catch (error) {
        return textResult(`Online presence lookup failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
  );

  return [listOnlineBots];
}
