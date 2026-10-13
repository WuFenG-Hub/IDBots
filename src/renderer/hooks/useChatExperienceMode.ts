import { useEffect, useState } from 'react';
import { configService } from '../services/config';
import { localStore } from '../services/store';
import { CONFIG_KEYS, type AppConfig, type ChatExperienceMode } from '../config';

/**
 * Chat experience mode (Settings > General), reactive across windows.
 * 'assistant' hides raw thinking and tool-call chrome (the model's narration
 * arrives as ordinary chat bubbles); 'professional' keeps the full transcript
 * chrome. Kept reactive through the app_config store-changed broadcast (fired
 * for every store:set, including writes from the Settings window) so flipping
 * the mode re-renders without a reload. One subscription per consumer — the
 * session list mounts it once and passes a plain boolean down to its
 * memoized rows.
 */
export function useChatExperienceMode(): ChatExperienceMode {
  const [chatExperienceMode, setChatExperienceMode] = useState<ChatExperienceMode>(
    () => configService.getConfig().chatExperienceMode ?? 'assistant',
  );

  useEffect(() => {
    const unsubscribe = localStore.onChanged(({ key }) => {
      if (key !== CONFIG_KEYS.APP_CONFIG) return;
      // The write may come from another window, so re-read the persisted
      // config instead of trusting this window's in-memory copy.
      void localStore.getItem<AppConfig>(CONFIG_KEYS.APP_CONFIG).then((stored) => {
        setChatExperienceMode(stored?.chatExperienceMode ?? 'assistant');
      });
    });
    return unsubscribe;
  }, []);

  return chatExperienceMode;
}
