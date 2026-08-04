import React, { useEffect, useState } from 'react';
import { getP2PStatusBadgeView } from './p2pStatusBadgeState.js';
import Tooltip from '../ui/Tooltip';

interface P2PStatus {
  running?: boolean;
  peerCount?: number;
  storageLimitReached?: boolean;
  storageUsedBytes?: number;
  dataSource?: string;
  syncMode?: string;
  runtimeMode?: string;
  peerId?: string;
  listenAddrs?: string[];
  error?: string;
}

export const P2PStatusBadge: React.FC = () => {
  const [status, setStatus] = useState<P2PStatus>({});

  useEffect(() => {
    // Initial fetch
    window.electron.p2p.getStatus().then(s => setStatus(s as P2PStatus));

    // Push updates from main process
    const unsubscribe = window.electron.p2p.onStatusUpdate((s) => setStatus(s as P2PStatus));

    // Polling fallback every 30s
    const interval = setInterval(async () => {
      const s = await window.electron.p2p.getStatus();
      setStatus(s as P2PStatus);
    }, 30_000);

    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, []);

  const renderDot = (colorClass: string, animate?: boolean) => (
    <div
      className={`w-2 h-2 rounded-full ${colorClass}${animate ? ' animate-pulse' : ''}`}
    />
  );

  const renderDataSourceBadge = (dataSource: string) => (
    <span className='text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'>
      {dataSource}
    </span>
  );

  const renderModeBadge = (label: string) => (
    <span className='text-xs px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300'>
      {label}
    </span>
  );

  const view = getP2PStatusBadgeView(status);

  // Extra detail (mode / data-source) that used to render inline and caused
  // multi-line wrapping in the narrow sidebar. Shown only inside the hover
  // tooltip so the compact row stays on a single line.
  const detailBadges = (
    <span className='inline-flex items-center gap-1.5'>
      {status.runtimeMode && renderModeBadge(status.runtimeMode)}
      {status.dataSource && renderDataSourceBadge(status.dataSource)}
    </span>
  );
  const hasDetail = Boolean(status.runtimeMode) || Boolean(status.dataSource);

  if (status.storageLimitReached) {
    return (
      <Tooltip content={detailBadges} disabled={!hasDetail} position='top'>
        <span className='inline-flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400 cursor-default'>
          {renderDot(view.dotColorClass, view.animate)}
          {view.label}
        </span>
      </Tooltip>
    );
  }

  if (!status.running) {
    return (
      <Tooltip
        content={
          <span className='inline-flex flex-col gap-1'>
            <span className='inline-flex items-center gap-1.5'>
              {renderDot('bg-gray-400')}
              P2P offline
            </span>
            {status.runtimeMode && renderModeBadge(status.runtimeMode)}
            {status.dataSource && renderDataSourceBadge(status.dataSource)}
            {status.error ? <span className='text-xs text-red-400'>{status.error}</span> : null}
          </span>
        }
        position='top'
      >
        <span className='inline-flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400 cursor-default'>
          {renderDot('bg-gray-400')}
          P2P offline
        </span>
      </Tooltip>
    );
  }

  if (status.peerCount === 0 || status.peerCount === undefined) {
    return (
      <Tooltip content={detailBadges} disabled={!hasDetail} position='top'>
        <span className='inline-flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400 cursor-default'>
          {renderDot(view.dotColorClass, view.animate)}
          {view.label}
        </span>
      </Tooltip>
    );
  }

  return (
    <Tooltip content={detailBadges} disabled={!hasDetail} position='top'>
      <span className='inline-flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400 cursor-default'>
        {renderDot(view.dotColorClass, view.animate)}
        {view.label}
      </span>
    </Tooltip>
  );
};

export default P2PStatusBadge;
