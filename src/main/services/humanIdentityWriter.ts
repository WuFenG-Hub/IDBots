import type { CreatePinWorkerSuccess, MetaidDataPayload, MvcCreatePinSessionSnapshot } from './metaidCore';
import type { UserIdentityStore } from '../userIdentityStore';

/**
 * Human (user_identity) pin signing shared by every human-identity writer.
 *
 * `createPinForIdentity` bypasses the per-MetaBot MVC spend coordinator, so
 * the human wallet needs its own serialization: one queue and one UTXO
 * session snapshot per process. The browser bridge (MetaApp writes signed as
 * the local human) and the sealed preference writer must share this single
 * instance instead of each running a second UTXO queue over the same wallet.
 */
export type IdentityCreatePin = (params: {
  mnemonic: string;
  path?: string;
  metaidData: MetaidDataPayload;
  options?: { feeRate?: number };
  sessionSnapshot?: MvcCreatePinSessionSnapshot;
}) => Promise<CreatePinWorkerSuccess>;

export type HumanIdentityWriterError = 'USER_IDENTITY_MISSING' | 'SUBSIDY_NOT_CLAIMED';

export class HumanIdentitySignerError extends Error {
  readonly code: HumanIdentityWriterError;

  constructor(code: HumanIdentityWriterError) {
    super(code);
    this.name = 'HumanIdentitySignerError';
    this.code = code;
  }
}

export interface HumanIdentityWriterDeps {
  createPin: IdentityCreatePin;
  feeRate: () => number;
}

export interface HumanIdentityWriteResult {
  pinId: string;
  txids: string[];
}

export interface HumanIdentityWriter {
  /**
   * Readiness of the human signer right now (identity registered with a
   * globalMetaId, gas subsidy claimed). Callers re-check at resolution time;
   * `write` re-checks again at execution time.
   */
  check(): HumanIdentityWriterError | null;
  /** Serialized human pin write; re-reads the identity at execution time. */
  write(metaidData: MetaidDataPayload): Promise<HumanIdentityWriteResult>;
}

export function createHumanIdentityWriter(
  userStore: Pick<UserIdentityStore, 'get'>,
  deps: HumanIdentityWriterDeps,
): HumanIdentityWriter {
  let queue: Promise<unknown> = Promise.resolve();
  const sessionSnapshot: MvcCreatePinSessionSnapshot = { excludeOutpoints: [], preferredFundingUtxos: [] };

  const check = (): HumanIdentityWriterError | null => {
    const identity = userStore.get();
    if (!identity || !identity.globalmetaid) return 'USER_IDENTITY_MISSING';
    if (
      identity.subsidy_state === 'failed'
      || (!identity.subsidy_state && !identity.chat_public_key_pin_id)
    ) {
      return 'SUBSIDY_NOT_CLAIMED';
    }
    return null;
  };

  const write = (metaidData: MetaidDataPayload): Promise<HumanIdentityWriteResult> => {
    const run = async (): Promise<HumanIdentityWriteResult> => {
      // Re-read the actual identity at execution time: identity replacement
      // or removal must never sign with the identity seen at request time.
      const error = check();
      if (error) throw new HumanIdentitySignerError(error);
      const current = userStore.get();
      if (!current) throw new HumanIdentitySignerError('USER_IDENTITY_MISSING');
      const result = await deps.createPin({
        mnemonic: current.mnemonic,
        path: current.path,
        metaidData,
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

  return { check, write };
}
