import type { MetaidDataPayload } from '../metaidCore';
import {
  HumanIdentitySignerError,
  createHumanIdentityWriter,
  type HumanIdentityWriter,
  type IdentityCreatePin,
} from '../humanIdentityWriter';
import type { UserIdentityStore } from '../../userIdentityStore';
import { PREFERENCE_PIN_VERSION, preferencePoolPath, type PreferenceSegment } from './constants';
import type { PreferencePinWriteResult, PreferenceWriterResolution } from './service';

export type { IdentityCreatePin };

export interface UserPreferenceWriterDeps {
  createPin: IdentityCreatePin;
  feeRate: () => number;
  /**
   * Shared process-wide human writer. When omitted (tests), a private writer
   * is built from createPin/feeRate with the same queue + UTXO snapshot
   * semantics the preference writer has always owned.
   */
  writer?: HumanIdentityWriter;
}

/**
 * Sealed-preference writes signed by the local human identity. Serialization
 * and UTXO threading live in the shared `HumanIdentityWriter` so preference
 * and browser-bridge writes never race the same wallet with second queues.
 */
export function createUserPreferenceWriter(
  userStore: Pick<UserIdentityStore, 'get'>,
  deps: UserPreferenceWriterDeps,
): () => PreferenceWriterResolution {
  const writer = deps.writer ?? createHumanIdentityWriter(userStore, deps);

  return () => {
    const error = writer.check();
    if (error) return { error };
    const identity = userStore.get();
    if (!identity?.globalmetaid) return { error: 'USER_IDENTITY_MISSING' };
    const write = (segment: PreferenceSegment, payload: object): Promise<PreferencePinWriteResult> => {
      const metaidData: MetaidDataPayload = {
        operation: 'create',
        path: preferencePoolPath(segment),
        encryption: '0',
        version: PREFERENCE_PIN_VERSION,
        contentType: 'application/json',
        payload: JSON.stringify(payload),
      };
      return writer.write(metaidData).catch((writeError) => {
        if (writeError instanceof HumanIdentitySignerError) {
          throw new Error(writeError.code);
        }
        throw writeError;
      });
    };
    return { globalMetaId: identity.globalmetaid, write };
  };
}
