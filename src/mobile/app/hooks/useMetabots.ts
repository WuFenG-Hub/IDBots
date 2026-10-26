import { useCallback, useEffect, useState } from 'react';
import type { MockMetabot } from '../../bridge/types';
import { getMobileElectron, hasAppBridge } from '../appBridge';
import { t } from '../../i18n';

/** MetaBot roster for the chat switcher and the Me screen management list. */
export function useMetabots(): {
  bots: MockMetabot[];
  error: string | null;
  reload: () => Promise<void>;
  createBot: (input: { name: string; role: string; soul: string; bio: string }) => Promise<boolean>;
  updateBot: (
    id: number,
    input: { name: string; role: string; soul: string; bio: string },
  ) => Promise<boolean>;
} {
  const [bots, setBots] = useState<MockMetabot[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!hasAppBridge()) {
      setError(t('mobile.chat.rosterUnavailable'));
      return;
    }
    try {
      const result = await getMobileElectron().metabot.list();
      if (result?.success && Array.isArray(result.list)) {
        setBots(result.list);
        setError(null);
      } else {
        setError(t('mobile.chat.rosterUnavailable'));
      }
    } catch {
      setError(t('mobile.chat.rosterUnavailable'));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const createBot = useCallback(
    async (input: { name: string; role: string; soul: string; bio: string }) => {
      if (!hasAppBridge()) return false;
      const result = await getMobileElectron().metabot.create({
        name: input.name,
        metabot_type: 'worker',
        role: input.role,
        soul: input.soul,
        bio: input.bio,
      });
      if (!result?.success) return false;
      await reload();
      return true;
    },
    [reload],
  );

  const updateBot = useCallback(
    async (id: number, input: { name: string; role: string; soul: string; bio: string }) => {
      if (!hasAppBridge()) return false;
      const result = await getMobileElectron().metabot.update(id, input);
      if (!result?.success) return false;
      await reload();
      return true;
    },
    [reload],
  );

  return { bots, error, reload, createBot, updateBot };
}
