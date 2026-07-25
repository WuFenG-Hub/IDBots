import { z } from 'zod';
import type {
  BotBrowserTabCommand,
  BotBrowserTabCommandResult,
} from '../services/botBrowserTabBridge';

/**
 * Control surface the host (main.ts) provides for Bot Browser agent tools.
 * `openUri` broadcasts the botBrowser:openUri channel; `execute` goes through
 * the Bot Browser tab bridge.
 */
export type BotBrowserControl = {
  openUri(input: { uri: string; actorId?: string | null }): Promise<void> | void;
  execute(command: BotBrowserTabCommand): Promise<BotBrowserTabCommandResult>;
};

/** Minimal shape of the claude-agent-sdk `tool()` helper we depend on. */
type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>
) => unknown;

const SURFACE_HINT = 'The Bot Browser surface may not be open; ask the user to switch to Bot Browser mode.';

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

export function formatBotBrowserTabs(result: BotBrowserTabCommandResult): string {
  if (!result.tabs.length) return 'No open tabs.';
  return result.tabs
    .map((tab) => `${tab.isActive ? '* ' : '  '}[${tab.id}] ${tab.title || '(untitled)'} — ${tab.uri || '(no uri)'}`)
    .join('\n');
}

/**
 * Inline MCP tools that let a browser-type cowork session drive the Bot
 * Browser: navigate to on-chain URIs and manage tabs. Only registered for
 * `sessionType === 'browser'` sessions (see coworkRunner).
 */
export function buildBotBrowserAgentTools(deps: {
  tool: SdkToolFactory;
  controlBotBrowser: BotBrowserControl;
}): unknown[] {
  const { tool, controlBotBrowser } = deps;

  const botBrowserTabs = tool(
    'bot_browser_tabs',
    'List, open, close, or switch tabs in the Bot Browser (the on-chain Agent browser shown on the right side of the app). Use action "list" to inspect open tabs (ids, titles, URIs, which one is active), "open" with a uri to open a new tab, "close" or "switch" with a tabId.',
    {
      action: z.enum(['list', 'open', 'close', 'switch']),
      uri: z.string().optional(),
      tabId: z.number().optional(),
    },
    async (args: { action: 'list' | 'open' | 'close' | 'switch'; uri?: string; tabId?: number }) => {
      try {
        if (args.action === 'open' && !args.uri?.trim()) {
          return textResult('bot_browser_tabs: action "open" requires a uri.', true);
        }
        if ((args.action === 'close' || args.action === 'switch') && typeof args.tabId !== 'number') {
          return textResult(`bot_browser_tabs: action "${args.action}" requires a numeric tabId. Call with action "list" first to see tab ids.`, true);
        }
        const actionMap = {
          list: 'get-tabs',
          open: 'open-tab',
          close: 'close-tab',
          switch: 'switch-tab',
        } as const;
        const result = await controlBotBrowser.execute({
          action: actionMap[args.action],
          uri: args.uri,
          tabId: args.tabId,
        });
        const summary = formatBotBrowserTabs(result);
        return textResult(
          args.action === 'list'
            ? `Open tabs (* = active):\n${summary}`
            : `Done. Current tabs (* = active):\n${summary}`
        );
      } catch (error) {
        return textResult(`Failed to control Bot Browser tabs: ${error instanceof Error ? error.message : String(error)}. ${SURFACE_HINT}`, true);
      }
    }
  );

  const botBrowserOpenUri = tool(
    'bot_browser_open_uri',
    'Navigate the Bot Browser to a URI: metaid://<globalMetaId> for an Agent homepage, metaapp://<pinId> for a MetaApp, map:// or metafile:// resources. By default the active tab navigates; set newTab=true to open in a new tab instead. Use this when the user asks to open or view a specific Agent, app, or on-chain page.',
    {
      uri: z.string().min(1),
      newTab: z.boolean().optional(),
    },
    async (args: { uri: string; newTab?: boolean }) => {
      const uri = args.uri.trim();
      try {
        if (args.newTab) {
          const result = await controlBotBrowser.execute({ action: 'open-tab', uri });
          return textResult(`Opened ${uri} in a new tab. Current tabs (* = active):\n${formatBotBrowserTabs(result)}`);
        }
        await controlBotBrowser.openUri({ uri });
        return textResult(`Navigated the active Bot Browser tab to ${uri}.`);
      } catch (error) {
        return textResult(`Failed to open ${uri} in Bot Browser: ${error instanceof Error ? error.message : String(error)}. ${SURFACE_HINT}`, true);
      }
    }
  );

  return [botBrowserTabs, botBrowserOpenUri];
}
