import { useCallback, useEffect, useState } from 'react';
import { getMobileElectron } from '../appBridge';

/** Full public identity row (derived, never hand-copied — see bridge/types.ts). */
export type MobileUserIdentity = NonNullable<
  Awaited<ReturnType<Window['electron']['userIdentity']['get']>>['identity']
>;

/**
 * Public identity for the Me screen (user card + profile page).
 * A6 note: now returns the FULL identity row — the user card needs the
 * avatar + sync badge (IA-PLAN §2.2) and the profile page needs the
 * read-only identity fields + retry channels (§4.3).
 */
export function useIdentity(resyncCounter = 0): {
  identity: MobileUserIdentity | null;
  name: string | null;
  globalMetaId: string | null;
  reload: () => Promise<void>;
} {
  const [identity, setIdentity] = useState<MobileUserIdentity | null>(null);

  const reload = useCallback(async () => {
    const result = await getMobileElectron().userIdentity.get();
    if (result?.success && result.identity) {
      setIdentity(result.identity);
    }
  }, []);

  useEffect(() => {
    void reload();
    // resyncCounter: REQ-E-5 reconnect resync re-pulls identity after every reconnect.
  }, [reload, resyncCounter]);

  return {
    identity,
    name: identity?.name ?? null,
    globalMetaId: identity?.globalmetaid ?? null,
    reload,
  };
}
