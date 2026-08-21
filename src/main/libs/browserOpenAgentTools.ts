import { z } from 'zod';
import { formatBotBrowserTabs, type BotBrowserControl } from './botBrowserAgentTools';

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

const SURFACE_HINT = 'The Bot Browser surface may not be open; ask the user to switch to Bot Browser mode.';

// Target normalization ported verbatim from the retired metabot-browser-open
// skill (SKILLs/metabot-browser-open/scripts/index.js) — the on-chain URI
// shapes it accepts are the single source of truth.
const PIN_ID_RE = /\b[0-9a-f]{64}i0\b/i;
const GLOBAL_META_ID_RE = /\bid[qprzyt]1[a-z0-9]{20,}\b/i;
const SUPPORTED_URI_RE = /\b(metaid|pin|metaapp|map|metafile):\/\/[^\s"'<>，。！？、]+/i;
const ANY_URI_SCHEME_RE = /\b([a-z][a-z0-9+.-]*):\/\//i;
const WEB3_DOMAIN_RE = /\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.(?:eth|lens|crypto|nft|wallet|bitcoin|btc|dao|888|zil|blockchain|polygon|sol|arb|base)\b/i;
const TRAILING_PUNCTUATION_RE = /[),.;!?，。！？、）]+$/;

function cleanToken(value: string): string {
  return String(value || '').trim().replace(TRAILING_PUNCTUATION_RE, '');
}

function normalizeSupportedUri(rawUri: string): string | null {
  const cleaned = cleanToken(rawUri);
  const match = /^([a-z][a-z0-9+.-]*):\/\/(.+)$/i.exec(cleaned);
  if (!match) {
    return null;
  }

  const scheme = match[1].toLowerCase();
  if (!['metaid', 'pin', 'metaapp', 'map', 'metafile'].includes(scheme)) {
    return null;
  }

  const rest = match[2].trim();
  if (!rest || /\s/.test(rest)) {
    return null;
  }

  return `${scheme}://${scheme === 'map' ? rest : rest.toLowerCase()}`;
}

/**
 * Normalize free-form text into a Bot Browser URI. Accepts explicit
 * metaid://metaapp://metafile://pin://map:// URIs, bare pinIds, bare
 * globalMetaIds, and web3 domains. Exposed for tests.
 */
export function normalizeBrowserOpenTarget(text: string): { uri?: string; error?: string } {
  const value = String(text || '').trim();
  if (!value) {
    return { error: 'Missing Browser target.' };
  }

  const explicitSupportedUri = value.match(SUPPORTED_URI_RE)?.[0];
  if (explicitSupportedUri) {
    const uri = normalizeSupportedUri(explicitSupportedUri);
    if (uri) {
      return { uri };
    }
  }

  const explicitScheme = value.match(ANY_URI_SCHEME_RE)?.[1];
  if (explicitScheme) {
    return { error: `Unsupported Browser URI scheme: ${explicitScheme.toLowerCase()}.` };
  }

  const pinId = value.match(PIN_ID_RE)?.[0]?.toLowerCase();
  if (pinId) {
    if (/(?:\bmeta\s*app\b|\bmetaapp\b|\bapp\b|应用)/i.test(value)) {
      return { uri: `metaapp://${pinId}` };
    }
    return { uri: `pin://${pinId}` };
  }

  const globalMetaId = value.match(GLOBAL_META_ID_RE)?.[0]?.toLowerCase();
  if (globalMetaId) {
    return { uri: `metaid://${globalMetaId}` };
  }

  const domain = value.match(WEB3_DOMAIN_RE)?.[0]?.toLowerCase();
  if (domain) {
    return { uri: `metaid://${domain}` };
  }

  return { error: 'No supported Browser target found.' };
}

/**
 * Inline MCP tool that opens on-chain targets in the host Bot Browser from ANY
 * cowork session surface (unlike bot_browser_open_uri, which is browser-session
 * only). Replaces the external metabot-browser-open skill; the natural-language
 * action inference is dropped in favor of an explicit action param.
 */
export function buildBrowserOpenAgentTools(deps: {
  tool: SdkToolFactory;
  controlBotBrowser: BotBrowserControl;
  sessionId: string;
}): unknown[] {
  const { tool, controlBotBrowser } = deps;

  const browserOpen = tool(
    'browser_open',
    [
      'Open on-chain targets in the host Bot Browser from ANY session surface (Chat included), plus tab management.',
      'Accepts metaid:// / metaapp:// / metafile:// / pin:// / map:// URIs directly, and also normalizes raw targets: a bare 64-hex pinId (pin://, or metaapp:// when the text mentions an app), a globalMetaId (idq1...), or a web3 domain like vitalik.eth (both become metaid://). Unsupported URI schemes are rejected.',
      'Actions: "open" (default) navigates the active tab to target; "open_tab" opens target in a new tab; "close_tab"/"switch_tab" need tab_id; "list_tabs" shows open tabs (call it first to get ids); "get_active_tab" reports the current tab.',
      'Use when the user pastes or mentions a pin/MetaID/domain and wants it opened, from any session type.',
      'When NOT to use: inside a browser session with an already-normalized URI prefer bot_browser_open_uri; to preview a LOCAL app use bot_browser_preview_local.',
    ].join(' '),
    {
      action: z
        .enum(['open', 'open_tab', 'close_tab', 'switch_tab', 'list_tabs', 'get_active_tab'])
        .optional()
        .describe('Browser action to perform; defaults to "open".'),
      target: z
        .string()
        .optional()
        .describe('meta{id,app,file}://, pin://, map:// URI, a bare 64-hex pinId, a globalMetaId (idq1...), or a web3 domain like vitalik.eth'),
      tab_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Tab id for close_tab/switch_tab; call list_tabs first to obtain ids.'),
      actor_id: z
        .string()
        .optional()
        .describe('Optional actor identity hint forwarded to the Bot Browser open request.'),
    },
    async (args: {
      action?: 'open' | 'open_tab' | 'close_tab' | 'switch_tab' | 'list_tabs' | 'get_active_tab';
      target?: string;
      tab_id?: number;
      actor_id?: string;
    }) => {
      const action = args.action ?? 'open';

      try {
        if (action === 'list_tabs') {
          const result = await controlBotBrowser.execute({ action: 'get-tabs' });
          return textResult(`Open tabs (* = active):\n${formatBotBrowserTabs(result)}`);
        }

        if (action === 'get_active_tab') {
          const result = await controlBotBrowser.execute({ action: 'get-active-tab' });
          const active = result.activeTab;
          if (!active) {
            return textResult('No active Bot Browser tab.');
          }
          return textResult(`Active tab: [${active.id}] ${active.title || '(untitled)'} — ${active.uri || '(no uri)'}`);
        }

        if (action === 'close_tab' || action === 'switch_tab') {
          if (typeof args.tab_id !== 'number') {
            return textResult(
              `browser_open: action "${action}" requires tab_id. Call with action "list_tabs" first to see tab ids.`,
              true,
            );
          }
          const result = await controlBotBrowser.execute({
            action: action === 'close_tab' ? 'close-tab' : 'switch-tab',
            tabId: args.tab_id,
          });
          return textResult(`Done. Current tabs (* = active):\n${formatBotBrowserTabs(result)}`);
        }

        // open / open_tab: normalize the target first.
        const target = typeof args.target === 'string' ? args.target.trim() : '';
        if (!target) {
          return textResult(`browser_open: action "${action}" requires a target (URI, pinId, globalMetaId, or web3 domain).`, true);
        }
        const normalized = normalizeBrowserOpenTarget(target);
        if (!normalized.uri) {
          return textResult(normalized.error || 'No supported Browser target found.', true);
        }
        const uri = normalized.uri;

        if (action === 'open_tab') {
          const result = await controlBotBrowser.execute({ action: 'open-tab', uri });
          return textResult(`Opened ${uri} in a new tab. Current tabs (* = active):\n${formatBotBrowserTabs(result)}`);
        }

        await controlBotBrowser.openUri({ uri, actorId: args.actor_id?.trim() || undefined });
        return textResult(`Opened ${uri} in the Bot Browser.`);
      } catch (error) {
        return textResult(
          `Failed to control Bot Browser: ${error instanceof Error ? error.message : String(error)}. ${SURFACE_HINT}`,
          true,
        );
      }
    }
  );

  return [browserOpen];
}
