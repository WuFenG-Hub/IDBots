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
  fallbackOpenMetaApp: (app: MetaAppRecord) => Promise<void>;
}

export function useBotBrowserShell(input: UseBotBrowserShellInput) {
  const { showToast, fallbackOpenMetaApp } = input;
  const browserRef = useRef<BotBrowserSurfaceHandle | null>(null);
  const pendingOpenUriRef = useRef<BotBrowserOpenUriInput | null>(null);
  const [surfaceMode, setSurfaceMode] = useState<BotBrowserSurfaceMode>('home');
  const [hasMountedBrowser, setHasMountedBrowser] = useState(false);

  const ensureLocalBot = useCallback(async (): Promise<boolean> => {
    let count = 0;
    try {
      const result = await window.electron.metabot.list();
      count = result?.success && Array.isArray(result.list) ? result.list.length : 0;
    } catch {
      count = 0;
    }

    if (count > 0) return true;
    showToast('No local Bot. Please create a Bot first.');
    return false;
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
      await fallbackOpenMetaApp(app);
      return false;
    }

    const uri = buildMetaAppBrowserUri(app);
    if (!uri) {
      await fallbackOpenMetaApp(app);
      return false;
    }

    if (!await showBrowser()) return false;
    openUriWhenBrowserReady({ uri });
    return true;
  }, [fallbackOpenMetaApp, openUriWhenBrowserReady, showBrowser]);

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
