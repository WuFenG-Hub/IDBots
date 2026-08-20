import type { BrowserActor, BrowserTrustedActionKind } from '@openagentinternet/agent-browser-host-contract';
import type { Metabot } from '../../types/metabot';
import type { MetaAppRecord } from '../../types/metaApp';

export type BotBrowserSurfaceMode = 'home' | 'browser';

/** Destination inside the Bot Internet tab. The browser pane stays mounted. */
export type BotInternetPane = 'browser' | 'gigSquare' | 'metaapps';

export type BotBrowserIntent =
  | { type: 'openBrowserHome' }
  | {
      type: 'openBotPage';
      uri: string;
      switchActingBotToLocalMetabotId?: number | null;
    }
  | {
      type: 'openMetaApp';
      uri: string;
    }
  | {
      type: 'openConversationInHome';
      localMetabotId: number;
      peerGlobalMetaId: string;
      peerName?: string | null;
      peerAvatar?: string | null;
    };

export interface BotBrowserOpenUriInput {
  uri: string;
  actorId?: string | null;
}

export type BotBrowserTabAction =
  | 'open-tab'
  | 'close-tab'
  | 'switch-tab'
  | 'get-tabs'
  | 'get-active-tab'
  | 'get-content'
  | 'get-tab-info';

export interface BotBrowserTabCommand {
  action: BotBrowserTabAction;
  uri?: string;
  tabId?: number;
}

export interface BotBrowserTabInfo {
  id: number;
  uri: string | null;
  title: string | null;
  isActive: boolean;
}

/** Rendered page content of a tab (ABC getTabContent; empty for opaque MetaApp frames). */
export interface BotBrowserTabContent {
  tabId: number;
  uri: string | null;
  title: string | null;
  contentType: string;
  text: string;
  html: string;
  truncated: boolean;
  extractedAt: number;
}

/** Full resolve envelope of a tab (ABC getTabInfo). */
export interface BotBrowserTabEnvelope extends BotBrowserTabInfo {
  current: unknown | null;
}

export interface BotBrowserTabCommandResult {
  action: BotBrowserTabAction;
  openedTabId?: number;
  tabs: BotBrowserTabInfo[];
  activeTab: BotBrowserTabInfo | null;
  content?: BotBrowserTabContent | null;
  info?: BotBrowserTabEnvelope | null;
}

export interface BotBrowserSurfaceHandle {
  openUri(input: BotBrowserOpenUriInput): Promise<void>;
  openNewTab(): Promise<void>;
  controlTabs(command: BotBrowserTabCommand): Promise<BotBrowserTabCommandResult>;
  refreshRuntime(): Promise<void>;
}

export interface BotBrowserLocalActor extends BrowserActor {
  localMetabotId: number;
}

export interface BotBrowserConversationRequest {
  actionKind: Extract<BrowserTrustedActionKind, 'open-conversation' | 'private-chat'>;
  actorId?: string | null;
  resourceUri: string;
  conversationUri?: string | null;
  peerGlobalMetaId: string;
  peerName?: string | null;
  peerAvatar?: string | null;
}

export interface BotBrowserHomeEntryCallbacks {
  onOpenLocalMetabotInBrowser?: (metabot: Metabot) => void;
  onOpenRemoteBotInBrowser?: (input: {
    globalMetaId: string;
    name?: string | null;
    avatar?: string | null;
  }) => void;
  onOpenMetaAppInBrowser?: (app: MetaAppRecord) => Promise<boolean> | boolean;
}
