import type { CreatePinWorkerSuccess, MetaidDataPayload, MvcCreatePinSessionSnapshot } from '../metaidCore';
import type { UserIdentityStore } from '../../userIdentityStore';
import { PREFERENCE_PIN_VERSION, preferencePoolPath, type PreferenceSegment } from './constants';
import { createHumanIdentityPinWriter, type HumanIdentityPinWriter } from '../humanIdentityPinWriter';
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
  /**
   * Shared serialized human-identity PIN writer. When omitted (tests, isolated
   * callers) a private writer with its own queue is created; when supplied
   * (main process) the sealed preference writer and the generic Browser
   * metaid.pin.write path share one queue and one UTXO session snapshot
   * instead of racing each other for the same wallet's funding.
   */
  pinWriter?: HumanIdentityPinWriter;
}

export { createHumanIdentityPinWriter };

/**
 * Sealed preference writer for the local human identity. Delegates signing to
 * the human PIN writer (createPinForIdentity bypasses the per-MetaBot spend
 * coordinator, so that writer owns wallet serialization); only the sealed
 * /protocols/preference segment paths are fixed here.
 */
export function createUserPreferenceWriter(
  userStore: Pick<UserIdentityStore, 'get'>,
  deps: UserPreferenceWriterDeps,
): () => PreferenceWriterResolution {
  const writePin: HumanIdentityPinWriter = deps.pinWriter ?? createHumanIdentityPinWriter(userStore, {
    createPin: deps.createPin,
    feeRate: deps.feeRate,
  });

  // resolve() captures the identity it resolved to; every write then carries
  // it as expectedGlobalMetaId so the shared writer re-checks at dequeue
  // time. A round/commit/reveal/lesson write queued behind another one can
  // therefore never be signed by a replacement identity.
  const resolve = (): PreferenceWriterResolution => {
    const identity = userStore.get();
    if (!identity || !identity.globalmetaid) return { error: 'USER_IDENTITY_MISSING' };
    if (identity.subsidy_state === 'failed' || (!identity.subsidy_state && !identity.chat_public_key_pin_id)) {
      return { error: 'SUBSIDY_NOT_CLAIMED' };
    }
    const resolvedGlobalMetaId = identity.globalmetaid;
    const write = (segment: PreferenceSegment, payload: object): Promise<PreferencePinWriteResult> => {
      const metaidData: MetaidDataPayload = {
        operation: 'create',
        path: preferencePoolPath(segment),
        encryption: '0',
        version: PREFERENCE_PIN_VERSION,
        contentType: 'application/json',
        payload: JSON.stringify(payload),
      };
      return writePin(metaidData, { expectedGlobalMetaId: resolvedGlobalMetaId }).then(
        (outcome): PreferencePinWriteResult => {
          if (outcome.ok === false) {
            // Keep the pre-refactor error surface: gate failures throw, and
            // the sentinel codes ride along for callers that inspect them.
            const error = new Error(outcome.error) as Error & { code?: string };
            error.code = outcome.error;
            throw error;
          }
          return { pinId: outcome.pinId, txids: outcome.txids };
        },
      );
    };
    return { globalMetaId: resolvedGlobalMetaId, write };
  };

  return resolve;
}
