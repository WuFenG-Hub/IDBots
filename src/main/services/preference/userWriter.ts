import type { CreatePinWorkerSuccess, MetaidDataPayload, MvcCreatePinSessionSnapshot } from '../metaidCore';
import type { UserIdentityStore } from '../../userIdentityStore';
import { PREFERENCE_PIN_VERSION, preferencePoolPath, type PreferenceSegment } from './constants';
import type { PreferencePinWriteResult, PreferenceWriterResolution } from './service';

export type IdentityCreatePin = (params: {
  mnemonic: string;
  path?: string;
  metaidData: MetaidDataPayload;
  options?: { feeRate?: number };
  sessionSnapshot?: MvcCreatePinSessionSnapshot;
}) => Promise<CreatePinWorkerSuccess>;

export interface UserPreferenceWriterDeps {
  createPin: IdentityCreatePin;
  feeRate: () => number;
}

/**
 * createPinForIdentity bypasses the per-MetaBot spend coordinator, so this
 * writer owns serialization for the human wallet: one queue, one snapshot.
 */
export function createUserPreferenceWriter(
  userStore: Pick<UserIdentityStore, 'get'>,
  deps: UserPreferenceWriterDeps,
): () => PreferenceWriterResolution {
  let queue: Promise<unknown> = Promise.resolve();
  const sessionSnapshot: MvcCreatePinSessionSnapshot = { excludeOutpoints: [], preferredFundingUtxos: [] };

  return () => {
    const identity = userStore.get();
    if (!identity || !identity.globalmetaid) return { error: 'USER_IDENTITY_MISSING' };
    if (identity.subsidy_state === 'failed' || (!identity.subsidy_state && !identity.chat_public_key_pin_id)) {
      return { error: 'SUBSIDY_NOT_CLAIMED' };
    }
    const write = (segment: PreferenceSegment, payload: object): Promise<PreferencePinWriteResult> => {
      const run = async (): Promise<PreferencePinWriteResult> => {
        const current = userStore.get() ?? identity;
        const result = await deps.createPin({
          mnemonic: current.mnemonic,
          path: current.path,
          metaidData: {
            operation: 'create',
            path: preferencePoolPath(segment),
            encryption: '0',
            version: PREFERENCE_PIN_VERSION,
            contentType: 'application/json',
            payload: JSON.stringify(payload),
          },
          options: { feeRate: deps.feeRate() },
          sessionSnapshot,
        });
        if (Array.isArray(result.spentOutpoints) && result.spentOutpoints.length > 0) {
          sessionSnapshot.excludeOutpoints.push(...result.spentOutpoints);
        }
        sessionSnapshot.preferredFundingUtxos = result.changeUtxo ? [result.changeUtxo] : [];
        const txid = result.txids[0] ?? '';
        return { pinId: result.pinId || `${txid}i0`, txids: result.txids };
      };
      const next = queue.then(run, run);
      queue = next.catch(() => undefined);
      return next;
    };
    return { globalMetaId: identity.globalmetaid, write };
  };
}
