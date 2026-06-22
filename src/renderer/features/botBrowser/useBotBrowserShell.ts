import { useCallback, useRef, useState } from 'react';
import type { Metabot } from '../../types/metabot';
import type { MetaAppRecord } from '../../types/metaApp';
import {
  buildBotPageBrowserUri,
  buildLocalMetabotActorId,
} from './botBrowserIntent.js';
import {
  buildMetaAppBrowserUri,
  canOpenMetaAppInBrowser,
} from '../../components/metaapps/metaAppLaunch.js';
import type {
  BotBrowserOpenUriInput,
  BotBrowserSurfaceHandle,
  BotBrowserSurfaceMode,
} from './types';

interface UseBotBrowserShellInput {
  showToast: (message: string) => void;
}

export function useBotBrowserShell(input: UseBotBrowserShellInput) {
  const { showToast } = input;
  const browserRef = useRef<BotBrowserSurfaceHandle | null>(null);
  const pendingOpenUriRef = useRef<BotBrowserOpenUriInput | null>(null);
  const [surfaceMode, setSurfaceMode] = useState<BotBrowserSurfaceMode>('home');
  const [hasMountedBrowser, setHasMountedBrowser] = useState(false);

  const messageFromError = (error: unknown, fallback: string): string => {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string' && error.trim()) return error;
    return fallback;
  };

  const ensureLocalBot = useCallback(async (): Promise<boolean> => {
    try {
      const result = await window.electron.metabot.list();
      if (!result?.success) {
        showToast(messageFromError(result?.error, 'Failed to load local Bots.'));
        return false;
      }

      if (!Array.isArray(result.list) || result.list.length === 0) {
        showToast('No local Bot. Please create a Bot first.');
        return false;
      }

      return true;
    } catch (error) {
      showToast(messageFromError(error, 'Failed to load local Bots.'));
      return false;
    }
  }, [showToast]);

  const showBrowser = useCallback(async (): Promise<boolean> => {
    if (!await ensureLocalBot()) return false;
    setHasMountedBrowser(true);
    setSurfaceMode('browser');
    return true;
  }, [ensureLocalBot]);

  const openUriWhenBrowserReady = useCallback((input: BotBrowserOpenUriInput) => {
    pendingOpenUriRef.current = input;
    if (!browserRef.current || !pendingOpenUriRef.current) return;
    const pending = pendingOpenUriRef.current;
    pendingOpenUriRef.current = null;
    void browserRef.current.openUri(pending);
  }, []);

  const onBrowserReady = useCallback(() => {
    if (!pendingOpenUriRef.current || !browserRef.current) return;
    const pending = pendingOpenUriRef.current;
    pendingOpenUriRef.current = null;
    void browserRef.current.openUri(pending);
  }, []);

  const openBrowserHome = useCallback(async () => {
    await showBrowser();
  }, [showBrowser]);

  const openLocalMetabot = useCallback(async (metabot: Metabot) => {
    const globalMetaId = metabot.globalmetaid?.trim() || '';
    const uri = buildBotPageBrowserUri(globalMetaId);
    const actorId = buildLocalMetabotActorId(metabot.id);
    if (!uri || !actorId) {
      showToast('This Bot does not have a valid GlobalMetaID.');
      return;
    }
    if (!await showBrowser()) return;
    openUriWhenBrowserReady({ uri, actorId });
  }, [openUriWhenBrowserReady, showBrowser, showToast]);

  const openRemoteBot = useCallback(async (target: { globalMetaId: string }) => {
    const uri = buildBotPageBrowserUri(target.globalMetaId);
    if (!uri) {
      showToast('Remote Bot GlobalMetaID is missing.');
      return;
    }
    if (!await showBrowser()) return;
    openUriWhenBrowserReady({ uri });
  }, [openUriWhenBrowserReady, showBrowser, showToast]);

  const openMetaApp = useCallback(async (app: MetaAppRecord): Promise<boolean> => {
    if (!canOpenMetaAppInBrowser(app)) {
      return false;
    }

    const uri = buildMetaAppBrowserUri(app);
    if (!uri) {
      return false;
    }

    if (!await showBrowser()) return false;
    openUriWhenBrowserReady({ uri });
    return true;
  }, [openUriWhenBrowserReady, showBrowser]);

  const switchToHome = useCallback(() => {
    setSurfaceMode('home');
  }, []);

  return {
    browserRef,
    surfaceMode,
    hasMountedBrowser,
    onBrowserReady,
    openBrowserHome,
    openLocalMetabot,
    openRemoteBot,
    openMetaApp,
    switchToHome,
  };
}
