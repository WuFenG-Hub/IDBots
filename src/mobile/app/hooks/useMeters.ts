import { useCallback, useEffect, useState } from 'react';
import type { BundleMeters } from '../../bridge/types';
import { getMobileElectron } from '../appBridge';

/** Identity-bound traffic + LLM meters behind the balance card. */
export function useMeters(resyncCounter = 0): {
  meters: BundleMeters | null;
  loading: boolean;
  error: boolean;
  reload: () => Promise<void>;
} {
  const [meters, setMeters] = useState<BundleMeters | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getMobileElectron().bundle.getMeters();
      if (!result?.success || !result.meters) throw new Error('meters unavailable');
      setMeters(result.meters);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    // resyncCounter: REQ-E-5 reconnect resync re-pulls meters after every reconnect.
  }, [reload, resyncCounter]);

  return { meters, loading, error, reload };
}
