import type { BrowserActor, BrowserTrustedActionKind } from '@openagentinternet/agent-browser-host-contract';
import type { Metabot } from '../../types/metabot';
import type { MetaAppRecord } from '../../types/metaApp';

export type BotBrowserSurfaceMode = 'home' | 'browser';

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

export interface BotBrowserSurfaceHandle {
  openUri(input: BotBrowserOpenUriInput): Promise<void>;
  openNewTab(): Promise<void>;
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
