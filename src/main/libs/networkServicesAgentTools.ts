import { z } from 'zod';
import { stripLoneSurrogates, truncateUtf16Units } from './llmSafeText';

/**
 * One currently-orderable MetaWeb service whose provider is online.
 * Shape is the Gig Square yellow-pages row plus live last-seen from
 * ProviderDiscoveryService (the same snapshot the Gig Square UI uses).
 */
export type OnlineServiceRow = {
  servicePinId: string;
  displayName: string;
  serviceName: string;
  description: string;
  price: string;
  currency: string;
  providerGlobalMetaId: string;
  providerName: string;
  providerSkill: string;
  ratingAvg: number | null;
  ratingCount: number;
  lastSeenAgoSeconds: number | null;
  updatedAt: number;
  isOwn?: boolean;
};

/**
 * Control surface the host (main.ts) provides for online service discovery.
 * Backed by ProviderDiscoveryService.availableServices — already filtered to
 * providers that currently appear online. Matches OAC `network services --online`.
 */
export type NetworkServicesControl = {
  listOnlineServices(): Promise<{ services: OnlineServiceRow[] }>;
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
const MAX_CELL_CHARS = 40;
const MAX_DETAIL_CHARS = 120;

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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

function tokenizeQuery(value: string): string[] {
  return [...new Set(
    value
      .toLowerCase()
      .split(/[\s,.;:!?()[\]{}"'`|/\\，。！？；：（）【】《》、]+/u)
      .filter((token) => token.length > 0),
  )];
}

function fieldScore(field: string, query: string, tokens: string[], exactWeight: number, tokenWeight: number): number {
  const haystack = field.toLowerCase();
  if (!haystack) return 0;
  let score = 0;
  if (haystack === query) score += exactWeight * 2;
  else if (haystack.includes(query) || query.includes(haystack)) score += exactWeight;
  for (const token of tokens) {
    if (haystack.includes(token)) score += tokenWeight;
  }
  return score;
}

function scoreService(service: OnlineServiceRow, query: string, tokens: string[]): number {
  return (
    fieldScore(service.displayName, query, tokens, 80, 16)
    + fieldScore(service.serviceName, query, tokens, 50, 10)
    + fieldScore(service.description, query, tokens, 40, 8)
    + fieldScore(service.providerSkill, query, tokens, 30, 6)
    + fieldScore(service.providerName, query, tokens, 20, 4)
    + fieldScore(service.providerGlobalMetaId, query, tokens, 10, 2)
  );
}

/** Rank online services. With a query, drop non-matches; otherwise recency then rating. */
export function filterAndRankOnlineServices(
  services: OnlineServiceRow[],
  query?: string,
): OnlineServiceRow[] {
  const normalizedQuery = normalizeText(query).toLowerCase();
  if (!normalizedQuery) {
    return [...services].sort((left, right) => {
      const leftSeen = left.lastSeenAgoSeconds;
      const rightSeen = right.lastSeenAgoSeconds;
      if (leftSeen != null && rightSeen != null && leftSeen !== rightSeen) {
        return leftSeen - rightSeen;
      }
      if ((leftSeen == null) !== (rightSeen == null)) {
        return leftSeen == null ? 1 : -1;
      }
      if (right.ratingCount !== left.ratingCount) {
        return right.ratingCount - left.ratingCount;
      }
      return (right.updatedAt || 0) - (left.updatedAt || 0);
    });
  }

  const tokens = tokenizeQuery(normalizedQuery);
  return services
    .map((service) => ({ service, score: scoreService(service, normalizedQuery, tokens) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const leftSeen = left.service.lastSeenAgoSeconds;
      const rightSeen = right.service.lastSeenAgoSeconds;
      if (leftSeen != null && rightSeen != null && leftSeen !== rightSeen) {
        return leftSeen - rightSeen;
      }
      return right.service.ratingCount - left.service.ratingCount;
    })
    .map((entry) => entry.service);
}

function formatPrice(service: OnlineServiceRow): string {
  const price = normalizeText(service.price);
  const currency = normalizeText(service.currency);
  if (!price) return '-';
  return `${price}${currency}`;
}

function formatProviderCell(service: OnlineServiceRow): string {
  const gmid = service.providerGlobalMetaId;
  if (!gmid) return '-';
  const name = sanitizeLinkLabel(normalizeText(service.providerName));
  const own = service.isOwn ? ' (your MetaBot)' : '';
  if (name) {
    return `[${escapeTableCell(truncate(name, 20))}](${metaIdUri(gmid)})${own}`;
  }
  return `[${gmid}](${metaIdUri(gmid)})${own}`;
}

function formatLastSeen(service: OnlineServiceRow): string {
  if (typeof service.lastSeenAgoSeconds !== 'number' || !Number.isFinite(service.lastSeenAgoSeconds)) {
    return '-';
  }
  return `${Math.max(0, Math.floor(service.lastSeenAgoSeconds))}s 🟢`;
}

/** Markdown table matching OAC `network services --online`, with metaid:// provider links. */
export function formatOnlineServicesTable(services: OnlineServiceRow[]): string {
  const header = [
    '| # | service | provider | price | Last Seen |',
    '|---|---------|----------|-------|-----------|',
  ];
  const rows = services.map((service, index) => {
    const title = escapeTableCell(truncate(
      sanitizeLinkLabel(service.displayName || service.serviceName || 'untitled'),
      MAX_CELL_CHARS,
    ));
    return `| ${index + 1} | ${title} | ${formatProviderCell(service)} | ${escapeTableCell(formatPrice(service))} | ${formatLastSeen(service)} |`;
  });
  return [...header, ...rows].join('\n');
}

export function formatOnlineServicesDetails(services: OnlineServiceRow[]): string {
  const lines = services.map((service, index) => {
    const rating = service.ratingAvg != null
      ? `rating ${service.ratingAvg} (${service.ratingCount})`
      : `rating n/a (${service.ratingCount})`;
    const skill = service.providerSkill ? `skill: ${service.providerSkill}` : 'skill: -';
    const description = escapeTableCell(truncate(service.description || '', MAX_DETAIL_CHARS));
    return `${index + 1}. pin ${service.servicePinId} | ${skill} | ${rating}${description ? ` | ${description}` : ''}`;
  });
  return ['Routing details (copy pin ids verbatim; do not invent them):', ...lines].join('\n');
}

/**
 * Inline MCP tool that lists currently-online MetaWeb services. Registered for
 * every cowork surface when the host provides NetworkServicesControl
 * (see coworkRunner). Complements search_metaids (identity search) with live
 * Gig Square yellow-pages semantics from OAC `network services --online`.
 */
export function buildNetworkServicesAgentTools(deps: {
  tool: SdkToolFactory;
  networkServices: NetworkServicesControl;
  /** True for browser-type sessions (Bot Browser side panel with bot_browser_open_uri available). */
  openBestMatchInBrowser: boolean;
}): unknown[] {
  const { tool, networkServices, openBestMatchInBrowser } = deps;

  const tableGuidance = openBestMatchInBrowser
    ? 'Present the table to the user by REUSING it verbatim: provider names/ids MUST remain markdown links — never mention a provider as plain text, never shorten a globalMetaId. If the user wants to view a provider Bot page, open it with bot_browser_open_uri on metaid://<globalMetaId> (prefer newTab=true). To order a service, follow the host remote-service delegation path with the pin id from the details list — do not invent pin ids. Use metaid_profile for a provider\'s full profile.'
    : 'Present the table to the user by REUSING it verbatim: provider names/ids MUST remain clickable markdown links (metaid://<globalMetaId>) — never mention a provider as plain text, never shorten a globalMetaId. Do NOT open anything in the Bot Browser yourself. To order a service, follow the host remote-service delegation path with the pin id from the details list — do not invent pin ids. Use metaid_profile for a provider\'s full profile.';

  const listOnlineServices = tool(
    'list_online_services',
    'List MetaWeb services whose providers are currently online (Gig Square yellow pages). Use when the user asks for online Bot services, who can do a task right now, or to browse the live service directory. Pass query with short task keywords to rank matches. When NOT to use: finding a person/bot by name or personality (search_metaids), listing currently-online people without a service intent, or publishing a local skill as a service. Returns a markdown table of up to `limit` rows (1-100, default 20) with provider metaid:// links, price, last-seen, and routing pin ids. Page with cursor.',
    {
      query: z.string().optional(),
      limit: z.number().optional(),
      cursor: z.number().optional(),
    },
    async (args: { query?: string; limit?: number; cursor?: number }) => {
      const limit = clampLimit(args.limit);
      const cursor = clampCursor(args.cursor);
      const query = normalizeText(args.query) || undefined;
      try {
        const page = await networkServices.listOnlineServices();
        const ranked = filterAndRankOnlineServices(
          Array.isArray(page.services) ? page.services.filter((row) => normalizeText(row.servicePinId) || normalizeText(row.providerGlobalMetaId)) : [],
          query,
        );
        const total = ranked.length;
        const slice = ranked.slice(cursor, cursor + limit);
        if (!slice.length) {
          const empty = query
            ? `No currently-online MetaWeb services matched "${query}". Tell the user honestly; do NOT invent services.`
            : 'No MetaWeb services are currently online. Tell the user honestly; do NOT invent services.';
          return textResult(empty);
        }
        const shownFrom = cursor + 1;
        const shownTo = cursor + slice.length;
        const queryNote = query ? `, query "${query}"` : '';
        const sections = [
          `Currently online MetaWeb services (${shownFrom}–${shownTo} of ${total}${queryNote}):`,
          formatOnlineServicesTable(slice),
          formatOnlineServicesDetails(slice),
          tableGuidance,
        ];
        if (cursor + slice.length < total) {
          sections.push(`More online services are available — call list_online_services again with cursor=${cursor + slice.length}${query ? ` and the same query` : ''} if the user wants them.`);
        }
        return textResult(sections.join('\n\n'));
      } catch (error) {
        return textResult(`Online service directory lookup failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
  );

  return [listOnlineServices];
}
