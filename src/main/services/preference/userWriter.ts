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

  const write = (segment: PreferenceSegment, payload: object): Promise<PreferencePinWriteResult> => {
    const metaidData: MetaidDataPayload = {
      operation: 'create',
      path: preferencePoolPath(segment),
      encryption: '0',
      version: PREFERENCE_PIN_VERSION,
      contentType: 'application/json',
      payload: JSON.stringify(payload),
    };
    return writePin(metaidData).then((outcome): PreferencePinWriteResult => {
      if (outcome.ok === false) {
        // Keep the pre-refactor error surface: gate failures throw, and the
        // sentinel codes ride along for callers that inspect them.
        const error = new Error(outcome.error) as Error & { code?: string };
        error.code = outcome.error;
        throw error;
      }
      return { pinId: outcome.pinId, txids: outcome.txids };
    });
  };

  // The shared writer re-gates on identity+subsidy at execution time;
  // resolve() keeps the earlier resolve-time gate so sealed callers see the
  // same error resolution before any payload is built.
  return () => {
    const identity = userStore.get();
    if (!identity || !identity.globalmetaid) return { error: 'USER_IDENTITY_MISSING' };
    if (identity.subsidy_state === 'failed' || (!identity.subsidy_state && !identity.chat_public_key_pin_id)) {
      return { error: 'SUBSIDY_NOT_CLAIMED' };
    }
    return { globalMetaId: identity.globalmetaid, write };
  };
}
