import React, { useEffect, useState } from 'react';
import Tooltip from './ui/Tooltip';
import { i18nService } from '../services/i18n';

interface SleepGuardState {
  active: boolean;
  sources: string[];
  engaged: boolean;
}

const SOURCE_LABEL_KEYS: Record<string, string> = {
  cowork: 'sleepGuardSourceCowork',
  scheduledTask: 'sleepGuardSourceScheduledTask',
  dream: 'sleepGuardSourceDream',
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

  const labels = state.sources.map((source) =>
    SOURCE_LABEL_KEYS[source] ? i18nService.t(SOURCE_LABEL_KEYS[source]) : source
  );
  const separator = i18nService.getLanguage() === 'zh' ? ' / ' : ', ';
  const tooltip = i18nService.t('sleepGuardBadgeTooltip').replace('{sources}', labels.join(separator));

  return (
    <Tooltip content={tooltip} position='top'>
      <span className='inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-300 cursor-default'>
        <span className='w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse' />
        {i18nService.t('sleepGuardBadgeText')}
      </span>
    </Tooltip>
  );
};
