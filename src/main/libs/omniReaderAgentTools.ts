import { z } from 'zod';
import { truncateUtf16Units } from './llmSafeText';

/**
 * Control surface the host (main.ts) provides for the omni_read tool. Pure
 * HTTP reads against the public MetaID/MetaWeb indexers; injected so tests
 * can stub the network. Endpoints and params are sourced from the retired
 * metabot-omni-reader skill's references/00-user.md .. 03-file.md.
 */
export type OmniReaderControl = {
  fetchJson(url: string): Promise<unknown>;
  fetchText(url: string): Promise<string>;
};

/** Minimal shape of the claude-agent-sdk tool() helper we depend on. */
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

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// Indexer base URLs (see the skill references).
const MANAPI_BASE = 'https://manapi.metaid.io';
const METAFILE_INDEXER_BASE = 'https://file.metaid.io/metafile-indexer';
const SHOWNOW_BASE = 'https://show.now/man';
const MAN_BASE = 'https://man.metaid.io';

/** Keep large indexer payloads from flooding the conversation. */
const MAX_RESULT_CHARS = 20000;

function formatData(data: unknown): string {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  if (text.length > MAX_RESULT_CHARS) {
    return `${truncateUtf16Units(text, MAX_RESULT_CHARS)}\n...(truncated, narrow the query with cursor/size)`;
  }
  return text;
}

/**
 * Build an indexer URL. `path` is resolved against the base (which may carry a
 * path prefix like /metafile-indexer); query entries that are undefined or
 * empty are dropped, everything else is URL-encoded by URLSearchParams.
 */
function buildUrl(
  base: string,
  path: string,
  query?: Record<string, string | number | undefined>,
): string {
  const url = new URL(path, base.endsWith('/') ? base : `${base}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

const ACTIONS = [
  'user_info',
  'search_users',
  'buzz_newest',
  'buzz_recommended',
  'buzz_hot',
  'buzz_search',
  'buzz_info',
  'notifications',
  'followers',
  'following',
  'pin',
  'pin_version',
  'pin_list',
  'metaid_list',
  'block_list',
  'mempool_list',
  'pins_by_path',
  'pins_by_metaid',
  'pins_by_address',
  'pin_content',
  'file_info',
  'file_latest',
  'files_by_creator',
  'files_by_metaid',
  'files_by_extension',
  'indexer_status',
  'indexer_stats',
  'global_counts',
] as const;

type OmniReadAction = (typeof ACTIONS)[number];

type OmniReadArgs = {
  action: OmniReadAction;
  metaid?: string;
  address?: string;
  globalmetaid?: string;
  keyword?: string;
  keytype?: 'metaid' | 'name';
  limit?: number;
  lastId?: string;
  size?: number;
  followed?: number;
  userAddress?: string;
  key?: string;
  pinId?: string;
  ver?: number;
  page?: number;
  path?: string;
  cursor?: string;
  firstPinId?: string;
  extension?: string;
  timestamp?: string;
};

/**
 * Inline MCP tool exposing read-only MetaID/MetaWeb indexer queries. Registered
 * for every cowork surface when the host provides OmniReaderControl (see
 * coworkRunner). Replaces the external metabot-omni-reader skill; the endpoint
 * shapes (including the `/api/notifcation/list` typo) are unchanged.
 */
export function buildOmniReaderAgentTools(deps: {
  tool: SdkToolFactory;
  control: OmniReaderControl;
}): unknown[] {
  const { tool, control } = deps;

  const omniRead = tool(
    'omni_read',
    [
      'Read-only raw MetaID/MetaWeb indexer queries over HTTP.',
      'Users: action "user_info" with exactly one of metaid | address | globalmetaid (metafile-indexer first, falls back to manapi for metaid/address); "search_users" with keyword plus optional keytype metaid|name and limit (default 10).',
      'Social/buzz: "buzz_newest" (lastId, size, metaid, followed 0/1), "buzz_recommended" (lastId, size, userAddress), "buzz_hot" (lastId, size <= 50), "buzz_search" (key required), "buzz_info" (pinId required); "notifications" (address required, size, lastId); "followers"/"following" (metaid required, cursor default 0, size).',
      'Pins: "pin" (pinId), "pin_version" (pinId + ver int, 0 = initial), "pin_list"/"metaid_list"/"block_list"/"mempool_list" (page, size), "pins_by_path" (path required, e.g. /protocols/simplebuzz, size 1-100, cursor), "pins_by_metaid" (metaid required, optional path), "pins_by_address" (address + path required), "pin_content" (pinId, returns the raw content body).',
      'Metafile index: "file_info" (pinId), "file_latest" (firstPinId), "files_by_creator" (address), "files_by_metaid" (metaid), "files_by_extension" (extension like .jpg required, optional metaid/timestamp/size); plus "indexer_status", "indexer_stats", "global_counts".',
      'Paged actions echo lastId/cursor in the response; pass it back for the next page. All parameters are URL-encoded automatically.',
      'Prefer search_metaids / metaid_profile for identity discovery and search_social_posts for full-text social search when those fit; omni_read is the low-level fallback returning raw indexer JSON. It never writes on-chain.',
    ].join(' '),
    {
      action: z.enum(ACTIONS).describe('Which indexer query to run.'),
      metaid: z.string().optional().describe('MetaID (hex id) for user_info, followers/following, pins_by_metaid, files_by_metaid, files_by_extension.'),
      address: z.string().optional().describe('Wallet address for user_info, notifications, pins_by_address, files_by_creator.'),
      globalmetaid: z.string().optional().describe('Global MetaID (idq...) for user_info; metafile-indexer only, no manapi fallback.'),
      keyword: z.string().optional().describe('Search keyword for search_users.'),
      keytype: z.enum(['metaid', 'name']).optional().describe('search_users key type; omit to search both.'),
      limit: z.number().int().optional().describe('search_users result limit (default 10).'),
      lastId: z.string().optional().describe('Paging cursor echoed by buzz/notification list responses.'),
      size: z.number().int().optional().describe('Page size. buzz_hot caps at 50; pins_by_path allows 1-100.'),
      followed: z.number().int().min(0).max(1).optional().describe('buzz_newest filter: 1 = followed users only, 0 = all.'),
      userAddress: z.string().optional().describe('Wallet address for buzz_recommended personalization.'),
      key: z.string().optional().describe('Search keyword for buzz_search.'),
      pinId: z.string().optional().describe('Pin id (txid+iN) for pin, pin_version, buzz_info, pin_content, file_info.'),
      ver: z.number().int().optional().describe('pin_version version number; 0 = initial version, >= 1 = history.'),
      page: z.number().int().optional().describe('Page number for pin_list, metaid_list, block_list, mempool_list.'),
      path: z.string().optional().describe('MetaID protocol path, e.g. /protocols/simplebuzz. Required for pins_by_path and pins_by_address.'),
      cursor: z.string().optional().describe('Cursor-based paging token (string). followers/following default to 0.'),
      firstPinId: z.string().optional().describe('First pin id of a file chain for file_latest.'),
      extension: z.string().optional().describe('File extension like .jpg for files_by_extension.'),
      timestamp: z.string().optional().describe('Optional timestamp filter for files_by_extension.'),
    },
    async (args: OmniReadArgs) => {
      try {
        switch (args.action) {
          case 'user_info': {
            const candidates: Array<['metaid' | 'address' | 'globalmetaid', string]> = [];
            if (asString(args.metaid)) candidates.push(['metaid', asString(args.metaid)]);
            if (asString(args.address)) candidates.push(['address', asString(args.address)]);
            if (asString(args.globalmetaid)) candidates.push(['globalmetaid', asString(args.globalmetaid)]);
            if (candidates.length !== 1) {
              return textResult('omni_read user_info requires exactly one of metaid, address, or globalmetaid.', true);
            }
            const [idType, idValue] = candidates[0];
            const encoded = encodeURIComponent(idValue);
            const primaryUrl = buildUrl(METAFILE_INDEXER_BASE, `api/v1/info/${idType}/${encoded}`);
            try {
              return textResult(formatData(await control.fetchJson(primaryUrl)));
            } catch (primaryError) {
              // The manapi fallback has no globalmetaid endpoint.
              if (idType === 'globalmetaid') throw primaryError;
              const fallbackUrl = buildUrl(MANAPI_BASE, `api/info/${idType}/${encoded}`);
              try {
                return textResult(formatData(await control.fetchJson(fallbackUrl)));
              } catch (fallbackError) {
                const pm = primaryError instanceof Error ? primaryError.message : String(primaryError);
                const fm = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
                return textResult(
                  `omni_read user_info failed: metafile-indexer: ${pm}; manapi fallback: ${fm}`,
                  true,
                );
              }
            }
          }

          case 'search_users': {
            const keyword = asString(args.keyword);
            if (!keyword) return textResult('omni_read search_users requires keyword.', true);
            const url = buildUrl(METAFILE_INDEXER_BASE, 'api/v1/info/search', {
              keyword,
              keytype: args.keytype,
              limit: args.limit ?? 10,
            });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'buzz_newest': {
            const url = buildUrl(SHOWNOW_BASE, 'social/buzz/newest', {
              lastId: asString(args.lastId) || undefined,
              size: args.size,
              metaid: asString(args.metaid) || undefined,
              followed: args.followed,
            });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'buzz_recommended': {
            const url = buildUrl(SHOWNOW_BASE, 'social/buzz/recommended', {
              lastId: asString(args.lastId) || undefined,
              size: args.size,
              userAddress: asString(args.userAddress) || undefined,
            });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'buzz_hot': {
            if (args.size !== undefined && args.size > 50) {
              return textResult('omni_read buzz_hot size must be <= 50.', true);
            }
            const url = buildUrl(SHOWNOW_BASE, 'social/buzz/hot', {
              lastId: asString(args.lastId) || undefined,
              size: args.size,
            });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'buzz_search': {
            const key = asString(args.key);
            if (!key) return textResult('omni_read buzz_search requires key.', true);
            const url = buildUrl(SHOWNOW_BASE, 'social/buzz/search', {
              lastId: asString(args.lastId) || undefined,
              size: args.size,
              key,
            });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'buzz_info': {
            const pinId = asString(args.pinId);
            if (!pinId) return textResult('omni_read buzz_info requires pinId.', true);
            const url = buildUrl(SHOWNOW_BASE, 'social/buzz/info', { pinId });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'notifications': {
            const address = asString(args.address);
            if (!address) return textResult('omni_read notifications requires address.', true);
            // The "notifcation" spelling is the backend's; keep it verbatim.
            const url = buildUrl(MANAPI_BASE, 'api/notifcation/list', {
              address,
              size: args.size,
              lastId: asString(args.lastId) || undefined,
            });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'followers':
          case 'following': {
            const metaid = asString(args.metaid);
            if (!metaid) return textResult(`omni_read ${args.action} requires metaid.`, true);
            const endpoint = args.action === 'followers' ? 'followerList' : 'followingList';
            const url = buildUrl(MAN_BASE, `api/metaid/${endpoint}/${encodeURIComponent(metaid)}`, {
              cursor: asString(args.cursor) || '0',
              size: args.size,
              followDetail: 'true',
            });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'pin': {
            const pinId = asString(args.pinId);
            if (!pinId) return textResult('omni_read pin requires pinId.', true);
            const url = buildUrl(MANAPI_BASE, `api/pin/${encodeURIComponent(pinId)}`);
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'pin_version': {
            const pinId = asString(args.pinId);
            if (!pinId) return textResult('omni_read pin_version requires pinId.', true);
            if (args.ver === undefined || !Number.isInteger(args.ver) || args.ver < 0) {
              return textResult('omni_read pin_version requires ver (int, 0 = initial version).', true);
            }
            const url = buildUrl(MANAPI_BASE, `api/pin/ver/${encodeURIComponent(pinId)}/${args.ver}`);
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'pin_list':
          case 'metaid_list':
          case 'block_list':
          case 'mempool_list': {
            const segment = args.action.replace('_list', '');
            const url = buildUrl(MANAPI_BASE, `api/${segment}/list`, {
              page: args.page,
              size: args.size,
            });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'pins_by_path': {
            const path = asString(args.path);
            if (!path) return textResult('omni_read pins_by_path requires path (e.g. /protocols/simplebuzz).', true);
            if (args.size !== undefined && (args.size < 1 || args.size > 100)) {
              return textResult('omni_read pins_by_path size must be between 1 and 100.', true);
            }
            const url = buildUrl(MANAPI_BASE, 'api/pin/path/list', {
              path,
              size: args.size,
              cursor: asString(args.cursor) || undefined,
            });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'pins_by_metaid': {
            const metaid = asString(args.metaid);
            if (!metaid) return textResult('omni_read pins_by_metaid requires metaid.', true);
            const url = buildUrl(MANAPI_BASE, `api/metaid/pin/list/${encodeURIComponent(metaid)}`, {
              path: asString(args.path) || undefined,
              size: args.size,
              cursor: asString(args.cursor) || undefined,
            });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'pins_by_address': {
            const address = asString(args.address);
            if (!address) return textResult('omni_read pins_by_address requires address.', true);
            const path = asString(args.path);
            if (!path) return textResult('omni_read pins_by_address requires path.', true);
            const url = buildUrl(MANAPI_BASE, `api/address/pin/list/${encodeURIComponent(address)}`, {
              path,
              size: args.size,
              cursor: asString(args.cursor) || undefined,
            });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'pin_content': {
            const pinId = asString(args.pinId);
            if (!pinId) return textResult('omni_read pin_content requires pinId.', true);
            const url = buildUrl(MANAPI_BASE, `content/${encodeURIComponent(pinId)}`);
            const body = await control.fetchText(url);
            const text = body.length > MAX_RESULT_CHARS
              ? `${truncateUtf16Units(body, MAX_RESULT_CHARS)}\n...(truncated, narrow the query with cursor/size)`
              : body;
            return textResult(text);
          }

          case 'file_info': {
            const pinId = asString(args.pinId);
            if (!pinId) return textResult('omni_read file_info requires pinId.', true);
            const url = buildUrl(METAFILE_INDEXER_BASE, `api/v1/files/${encodeURIComponent(pinId)}`);
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'file_latest': {
            const firstPinId = asString(args.firstPinId);
            if (!firstPinId) return textResult('omni_read file_latest requires firstPinId.', true);
            const url = buildUrl(METAFILE_INDEXER_BASE, `api/v1/files/latest/${encodeURIComponent(firstPinId)}`);
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'files_by_creator': {
            const address = asString(args.address);
            if (!address) return textResult('omni_read files_by_creator requires address.', true);
            const url = buildUrl(METAFILE_INDEXER_BASE, `api/v1/files/creator/${encodeURIComponent(address)}`, {
              cursor: asString(args.cursor) || undefined,
              size: args.size,
            });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'files_by_metaid': {
            const metaid = asString(args.metaid);
            if (!metaid) return textResult('omni_read files_by_metaid requires metaid.', true);
            const url = buildUrl(METAFILE_INDEXER_BASE, `api/v1/files/metaid/${encodeURIComponent(metaid)}`, {
              cursor: asString(args.cursor) || undefined,
              size: args.size,
            });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'files_by_extension': {
            const extension = asString(args.extension);
            if (!extension) return textResult('omni_read files_by_extension requires extension (e.g. .jpg).', true);
            const metaid = asString(args.metaid);
            const path = metaid
              ? `api/v1/files/metaid/${encodeURIComponent(metaid)}/extension`
              : 'api/v1/files/extension';
            const url = buildUrl(METAFILE_INDEXER_BASE, path, {
              extension,
              timestamp: asString(args.timestamp) || undefined,
              size: args.size,
            });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'indexer_status': {
            const url = buildUrl(METAFILE_INDEXER_BASE, 'api/v1/status');
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'indexer_stats': {
            const url = buildUrl(METAFILE_INDEXER_BASE, 'api/v1/stats');
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'global_counts': {
            const url = buildUrl(MANAPI_BASE, 'debug/count');
            return textResult(formatData(await control.fetchJson(url)));
          }

          default:
            return textResult(`omni_read does not support action "${String(args.action)}".`, true);
        }
      } catch (error) {
        return textResult(
          `omni_read ${String(args.action)} failed: ${error instanceof Error ? error.message : String(error)}`,
          true,
        );
      }
    }
  );

  return [omniRead];
}
