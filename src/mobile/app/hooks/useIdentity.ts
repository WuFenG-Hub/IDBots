import { useCallback, useEffect, useState } from 'react';
import { getMobileElectron } from '../appBridge';

/** Public identity for the Me screen header. */
export function useIdentity(resyncCounter = 0): { name: string | null; globalMetaId: string | null; reload: () => Promise<void> } {
  const [name, setName] = useState<string | null>(null);
  const [globalMetaId, setGlobalMetaId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const result = await getMobileElectron().userIdentity.get();
    if (result?.success && result.identity) {
      setName(result.identity.name ?? null);
      setGlobalMetaId(result.identity.globalmetaid ?? null);
    }
  }, []);

  useEffect(() => {
    void reload();
    // resyncCounter: REQ-E-5 reconnect resync re-pulls identity after every reconnect.
  }, [reload, resyncCounter]);

  return { name, globalMetaId, reload };
}
