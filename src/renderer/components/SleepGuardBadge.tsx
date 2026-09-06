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
 * Sidebar dot shown while the sleep guard is engaged (IDBots is working and
 * the host device is being kept awake). Dot-only on purpose: the guard is an
 * automatic side effect of running work, so a quiet breathing dot plus the
 * hover tooltip is all the affordance it needs — the text badge read like a
 * stuck status the user could not dismiss. Hidden when idle.
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
      <span className='inline-flex items-center justify-center p-1 cursor-default' role='status' aria-label={tooltip}>
        <span className='w-2 h-2 rounded-full bg-amber-500 animate-pulse' />
      </span>
    </Tooltip>
  );
};
