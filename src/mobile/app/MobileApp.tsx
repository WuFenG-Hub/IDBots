import { lazy, Suspense, useEffect, useState } from 'react';
import { t } from '../i18n';
import { hasAppBridge } from './appBridge';
import { useChat } from './hooks/useChat';
import { useMetabots } from './hooks/useMetabots';
import { useResync } from './hooks/useResync';
import { useTerminalBridgeState } from './hooks/useTerminalBridgeState';
import { BridgeUnavailable } from './components/BridgeUnavailable';
import { ConnectionBanner } from './components/ConnectionBanner';
import {
  TenantUnavailableScreen,
  TooManyDevicesScreen,
  VersionMismatchScreen,
} from './components/GatewayTerminalScreens';
import { TabBar } from './components/TabBar';
import type { MobileTab } from './components/TabBar';

/**
 * App shell (REQ-E-11): connection banner on top, three lazy-loaded tabs,
 * bottom tab bar with safe-area padding, and the recharge page pushed as a
 * full-screen overlay. No router dependency: simple state navigation.
 */

const ChatScreen = lazy(() => import('./screens/ChatScreen'));
const TasksScreen = lazy(() => import('./screens/TasksScreen'));
const MeScreen = lazy(() => import('./screens/MeScreen'));
const RechargeScreen = lazy(() => import('./screens/RechargeScreen'));

function TabFallback(): JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center py-16 text-sm text-[var(--text-secondary)]">
      {t('mobile.common.loading')}
    </div>
  );
}

export default function MobileApp(): JSX.Element {
  const [tab, setTab] = useState<MobileTab>('chat');
  const [rechargeOpen, setRechargeOpen] = useState(false);
  // Chat state lives at the shell level so switching tabs keeps the stream.
  const chat = useChat();
  const { bots } = useMetabots();
  // Terminal gateway states (REQ-E-2 close codes) replace the whole shell.
  const { terminal, versionMismatch } = useTerminalBridgeState();
  // Reconnect resync (REQ-E-5): refresh on every (re)connect, whichever
  // bridge is active; the counter drives the tasks/meters/me list refresh.
  const resyncCounter = useResync(
    { getOpenSessionId: chat.getOpenSessionId, getStreamingMessage: chat.getStreamingMessage },
    chat.applyResync,
  );

  // 4001/4003 unauthorized: the session is no longer valid — sign in again.
  useEffect(() => {
    if (terminal === 'unauthorized') {
      window.location.assign('/login');
    }
  }, [terminal]);

  if (!hasAppBridge()) {
    return <BridgeUnavailable />;
  }

  if (terminal === 'unauthorized') {
    // Navigating away in the effect above; render nothing meanwhile.
    return <div className="hidden" data-testid="gateway-unauthorized" />;
  }
  if (terminal === 'tenant-unavailable') {
    return <TenantUnavailableScreen />;
  }
  if (terminal === 'too-many-devices') {
    return <TooManyDevicesScreen />;
  }
  if (terminal === 'version-mismatch') {
    return <VersionMismatchScreen mismatch={versionMismatch} />;
  }

  return (
    <div
      className="flex h-[100dvh] flex-col bg-[var(--bg-main)] text-[var(--text-primary)]"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <ConnectionBanner />
      <div className="flex min-h-0 flex-1 flex-col">
        {tab === 'chat' ? (
          <Suspense fallback={<TabFallback />}>
            <ChatScreen chat={chat} bots={bots} onOpenRecharge={() => setRechargeOpen(true)} />
          </Suspense>
        ) : null}
        {tab === 'tasks' ? (
          <Suspense fallback={<TabFallback />}>
            <TasksScreen resyncCounter={resyncCounter} />
          </Suspense>
        ) : null}
        {tab === 'me' ? (
          <Suspense fallback={<TabFallback />}>
            <MeScreen resyncCounter={resyncCounter} onOpenRecharge={() => setRechargeOpen(true)} />
          </Suspense>
        ) : null}
      </div>
      <TabBar active={tab} onSelect={setTab} />
      {rechargeOpen ? (
        <div className="fixed inset-0 z-50">
          <Suspense fallback={<TabFallback />}>
            <RechargeScreen onClose={() => setRechargeOpen(false)} />
          </Suspense>
        </div>
      ) : null}
    </div>
  );
}
