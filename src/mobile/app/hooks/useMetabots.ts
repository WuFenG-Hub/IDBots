import { useCallback, useEffect, useState } from 'react';
import type { MockMetabot } from '../../bridge/types';
import { getMobileElectron, hasAppBridge } from '../appBridge';

/** MetaBot roster for the chat switcher and the Me screen management list. */
export function useMetabots(): {
  bots: MockMetabot[];
  reload: () => Promise<void>;
  createBot: (input: { name: string; role: string; soul: string; bio: string }) => Promise<boolean>;
  updateBot: (
    id: number,
    input: { name: string; role: string; soul: string; bio: string },
  ) => Promise<boolean>;
} {
  const [bots, setBots] = useState<MockMetabot[]>([]);

  const reload = useCallback(async () => {
    if (!hasAppBridge()) return;
    const result = await getMobileElectron().metabot.list();
    if (result?.success && Array.isArray(result.list)) {
      setBots(result.list);
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

  return { bots, reload, createBot, updateBot };
}
