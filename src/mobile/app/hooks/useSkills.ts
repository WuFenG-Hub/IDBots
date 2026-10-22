import { useCallback, useEffect, useState } from 'react';
import type { MockSkill } from '../../bridge/types';
import { getMobileElectron } from '../appBridge';

/** Skill roster with enable/disable; refreshes on the bridge's changed event. */
export function useSkills(): {
  skills: MockSkill[];
  setEnabled: (id: string, enabled: boolean) => Promise<boolean>;
} {
  const [skills, setSkills] = useState<MockSkill[]>([]);

  const reload = useCallback(async () => {
    const result = await getMobileElectron().skills.list();
    if (result?.success && Array.isArray(result.skills)) {
      setSkills(result.skills);
    }
  }, []);

  useEffect(() => {
    void reload();
    const off = getMobileElectron().skills.onChanged(() => {
      void reload();
    });
    return off;
  }, [reload]);

  const setEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      const result = await getMobileElectron().skills.setEnabled({ id, enabled });
      if (!result?.success) return false;
      await reload();
      return true;
    },
    [reload],
  );

  return { skills, setEnabled };
}
