import React, { useEffect, useState } from 'react';
import Tooltip from './ui/Tooltip';

interface SleepGuardState {
  active: boolean;
  sources: string[];
  engaged: boolean;
}

const SOURCE_LABELS: Record<string, string> = {
  cowork: '活跃会话',
  scheduledTask: '定时任务',
  dream: '夜间梦境',
};

/**
 * Sidebar badge shown while the sleep guard is engaged (IDBots is working and
 * the host device is being kept awake). Hidden when idle.
 */
export const SleepGuardBadge: React.FC = () => {
  const [state, setState] = useState<SleepGuardState>({ active: false, sources: [], engaged: false });

  useEffect(() => {
    window.electron.powerGuard.getStatus().then((s) => setState(s as SleepGuardState));
    const unsubscribe = window.electron.powerGuard.onChanged((s) => setState(s as SleepGuardState));
    return () => unsubscribe();
  }, []);

  if (!state.active || !state.engaged) {
    return null;
  }

  const labels = state.sources.map((source) => SOURCE_LABELS[source] ?? source);
  const tooltip = `IDBots 正在工作，已阻止设备休眠（${labels.join(' / ')}）`;

  return (
    <Tooltip content={tooltip} position='top'>
      <span className='inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-300 cursor-default'>
        <span className='w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse' />
        防休眠中
      </span>
    </Tooltip>
  );
};
