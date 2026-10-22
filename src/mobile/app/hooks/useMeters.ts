import { useCallback, useEffect, useState } from 'react';
import type { BundleMeters } from '../../bridge/types';
import { getMobileElectron } from '../appBridge';

/** Identity-bound traffic + LLM meters behind the balance card. */
export function useMeters(): {
  meters: BundleMeters | null;
  reload: () => Promise<void>;
} {
  const [meters, setMeters] = useState<BundleMeters | null>(null);

  const reload = useCallback(async () => {
    const result = await getMobileElectron().bundle.getMeters();
    if (result?.success && result.meters) {
      setMeters(result.meters);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { meters, reload };
}
