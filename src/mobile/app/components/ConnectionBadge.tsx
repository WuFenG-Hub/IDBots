import { t } from '../../i18n';
import type { ConnectionState } from '../../bridge/types';
import { useConnectionState } from '../hooks/useConnectionState';
import { getAppBridge } from '../appBridge';

const STATE_LABEL_KEY: Record<ConnectionState, string> = {
  connecting: 'mobile.connection.connecting',
  online: 'mobile.connection.online',
  reconnecting: 'mobile.connection.reconnecting',
  offline: 'mobile.connection.offline',
  upgrading: 'mobile.connection.upgrading',
};

const STATE_DOT_CLASS: Record<ConnectionState, string> = {
  connecting: 'bg-amber-400',
  online: 'bg-emerald-500',
  reconnecting: 'bg-amber-400 animate-pulse',
  offline: 'bg-red-500',
  upgrading: 'bg-sky-500 animate-pulse',
};

export function ConnectionBadge(): JSX.Element {
  const state = useConnectionState();
  return (
    <div className="flex items-center gap-2">
      <span className={`inline-block h-2.5 w-2.5 rounded-full ${STATE_DOT_CLASS[state]}`} />
      <span className="text-sm text-[var(--text-secondary)]">{t(STATE_LABEL_KEY[state])}</span>
      <button
        type="button"
        onClick={() => getAppBridge().control.simulateReconnect()}
        className="rounded-full border border-[var(--border-color)] px-3 py-1 text-xs text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
      >
        {t('mobile.demo.reconnectButton')}
      </button>
    </div>
  );
}
