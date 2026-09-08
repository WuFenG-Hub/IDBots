/**
 * Sponsored (traffic-mode) MVC createPin orchestration.
 * Runs the generic sponsor v2 protocol (mvcSponsorClient) for any MetaID pin:
 * unsigned worker draft -> quota preflight -> challenge -> pre -> sign user
 * inputs -> commit, then maintains the MVC spend session state exactly like
 * the broadcast path. Fallback semantics for the createPin main path
 * (2026-09-08 owner rule: a sponsor outage or error must never block the
 * write — auto-switch to the bot's own wallet with an explicit trace):
 * ANY sponsor failure — service_unavailable / no_user_utxo /
 * insufficient_quota / insufficient_traffic / pre_rejected / commit_failed —
 * falls back to the regular self-paid broadcast (fallbackPolicy 'selfpay',
 * tagged with feeAssist metadata) or throws a TrafficInsufficientError
 * ('strict'). Commit-stage failures reconcile the sponsor order first: an
 * order that actually broadcast resolves as sponsored success, a
 * terminal-dead order falls back safely, and an order still reconciling past
 * the bounded wait budget falls back too (WARN log + feeAssist carry the
 * orderId and order outcome; the residual duplicate-ping risk of a late
 * sponsor recovery is accepted and traceable).
 */

import {
  createMvcSponsorV2Client,
  getErrorMessage,
  getMvcSponsorCommitMessage,
  isNoUserUtxoDraftError,
  reconcileSponsorOrderAfterCommitFailure,
  signMvcAddressMessage,
  signMvcPreparedUserInputs,
  trafficBalanceBytesOf,
  type MvcSponsorAddressInfo,
  type MvcSponsorTrafficAccount,
  type MvcSponsorV2Client,
} from './mvcSponsorClient';
import { appendMetaidLog } from './metaidLog';
import { recordLocalTrafficSpend } from './trafficAccountService';
import type {
  MvcSponsorFeeAssistMetadata,
  MvcSponsorFeeAssistReason,
  MvcSponsorFeeAssistStage,
} from './mvcSponsorUpload';
import type { CreatePinWorkerSuccess } from './metaidCore';
import type { MvcCachedFundingUtxo } from './mvcSpendSessionState';
import type { TrafficFallbackPolicy } from './trafficSettings';

type SponsorChallenge = Awaited<ReturnType<MvcSponsorV2Client['getChallenge']>>;
type SponsorPreResult = Awaited<ReturnType<MvcSponsorV2Client['preSponsor']>>;
type SponsorCommitResult = Awaited<ReturnType<MvcSponsorV2Client['commitSponsor']>>;

/**
 * Reasons that route a sponsored createPin to the self-paid fallback. Every
 * sponsor failure qualifies (2026-09-08 owner rule: sponsor outage or error
 * auto-switches to the bot's own wallet); commit_failed additionally
 * reconciles the order first so an already-broadcast tx never double-writes.
 */
export type MvcSponsorCreatePinFallbackReason = MvcSponsorFeeAssistReason;

/** feeAssist metadata attached to sponsored/fallback createPin results. */
export interface CreatePinFeeAssistMetadata extends MvcSponsorFeeAssistMetadata {
  txSize?: number;
}

export interface MvcSponsorCreatePinResult extends CreatePinWorkerSuccess {
  feeAssist: CreatePinFeeAssistMetadata;
}

export class TrafficInsufficientError extends Error {
  readonly code = 'mvc_traffic_insufficient';
  readonly reason: MvcSponsorCreatePinFallbackReason;
  readonly stage: MvcSponsorFeeAssistStage;
  readonly orderId?: string;
  readonly feeAssist: CreatePinFeeAssistMetadata;

  constructor(input: {
    message?: string;
    reason: MvcSponsorCreatePinFallbackReason;
    stage: MvcSponsorFeeAssistStage;
    orderId?: string;
    feeAssist: CreatePinFeeAssistMetadata;
  }) {
    super(input.message || `MVC traffic sponsor cannot cover this pin (${input.reason}).`);
    this.name = 'TrafficInsufficientError';
    this.reason = input.reason;
    this.stage = input.stage;
    if (input.orderId !== undefined) this.orderId = input.orderId;
    this.feeAssist = input.feeAssist;
  }
}

export interface MvcSponsorCreatePinInput {
  metabotId: number;
  mnemonic: string;
  walletPath: string;
  mvcAddress: string;
  feeRate: number;
  fallbackPolicy: TrafficFallbackPolicy;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Reserved pass-through for traffic-account billing (backend not yet live). */
  trafficAccount?: MvcSponsorTrafficAccount;
  /** MetaID pin path (e.g. /protocols/simplemsg), journaled as the spend kind. */
  journalKind?: string;
  /** Order-reconciliation timing after a failed commit (tests override; defaults 5s/30s). */
  commitReconcilePollIntervalMs?: number;
  commitReconcileMaxWaitMs?: number;
}

export interface MvcSponsorCreatePinDeps {
  /** Draft-mode worker run; the caller wraps it with the standard stale-funding session recovery. */
  runDraftWorker: () => Promise<CreatePinWorkerSuccess>;
  /** Regular self-paid broadcast path, used by the 'selfpay' fallback policy. */
  runBroadcastWorker: () => Promise<CreatePinWorkerSuccess>;
  recordSpentOutpoints: (outpoints: string[]) => void;
  replacePendingFundingUtxos: (utxo: MvcCachedFundingUtxo | null) => void;
  /**
   * Optional trafficAccount resolver invoked between challenge and pre
   * (wired to trafficAccountService in production). When it returns
   * undefined — or is not provided — the pre goes out without a
   * trafficAccount and stays on the legacy quota path.
   */
  resolveTrafficAccount?: (ctx: { challengeId: string }) => Promise<MvcSponsorTrafficAccount | undefined>;
}

function normalizeSponsorReason(value: unknown, fallback: MvcSponsorFeeAssistReason): MvcSponsorFeeAssistReason {
  return value === 'insufficient_quota'
    || value === 'insufficient_traffic'
    || value === 'service_unavailable'
    || value === 'commit_failed'
    || value === 'pre_rejected'
    || value === 'no_user_utxo'
    ? value
    : fallback;
}

function isNoUserUtxoDraftFailure(error: unknown): boolean {
  const message = getErrorMessage(error, '');
  return isNoUserUtxoDraftError(error)
    || /not enough balance|余额不足/i.test(message)
    || message.includes('所有已知 MVC 手续费输入都已失效');
}

export async function runMvcSponsorCreatePin(
  input: MvcSponsorCreatePinInput,
  deps: MvcSponsorCreatePinDeps,
): Promise<MvcSponsorCreatePinResult> {
  const sponsorClient = createMvcSponsorV2Client({ baseUrl: input.baseUrl, fetchImpl: input.fetchImpl });

  const fallbackToSelfPaid = async (params: {
    reason: MvcSponsorCreatePinFallbackReason;
    stage: MvcSponsorFeeAssistStage;
    orderId?: string;
    quotaBefore?: MvcSponsorAddressInfo;
    advisoryFeeEstimate?: number;
    /** Sponsor-order outcome observed while reconciling a failed commit. */
    commitOrderOutcome?: 'failed' | 'pending' | 'unknown';
  }): Promise<MvcSponsorCreatePinResult> => {
    const feeAssist: CreatePinFeeAssistMetadata = {
      attempted: true,
      used: false,
      mode: 'self_paid',
      sponsor: 'mvc_sponsor_v2',
      reason: params.reason,
      stage: params.stage,
      orderId: params.orderId,
      commitOrderOutcome: params.commitOrderOutcome,
      quotaBefore: params.quotaBefore,
      advisoryFeeEstimate: params.advisoryFeeEstimate,
    };
    // Self-pay spends the bot's own wallet — never let that happen silently
    // (the 2026-09-07 outage: exhausted legacy quota forced every traffic-mode
    // pin to self-pay with no trace of why). The WARN log + feeAssist trace
    // keep every fallback visible; the 2026-09-08 hard-fail regression
    // (SPONSOR_BROADCAST_PENDING blocking all writes) is why commit-stage
    // failures now land here too.
    appendMetaidLog('WARN', 'Sponsored MVC createPin falling back to self-paid', {
      metabotId: input.metabotId,
      mvcAddress: input.mvcAddress,
      reason: params.reason,
      stage: params.stage,
      orderId: params.orderId,
      commitOrderOutcome: params.commitOrderOutcome,
      fallbackPolicy: input.fallbackPolicy,
    });
    if (input.fallbackPolicy === 'strict') {
      throw new TrafficInsufficientError({ reason: params.reason, stage: params.stage, feeAssist });
    }
    const broadcastResult = await deps.runBroadcastWorker();
    return { ...broadcastResult, feeAssist };
  };

  if (!input.mvcAddress) {
    return fallbackToSelfPaid({ reason: 'service_unavailable', stage: 'address_info' });
  }

  let quotaBefore: MvcSponsorAddressInfo;
  try {
    quotaBefore = await sponsorClient.getAddressInfo({ address: input.mvcAddress });
  } catch {
    return fallbackToSelfPaid({ reason: 'service_unavailable', stage: 'address_info' });
  }

  let draft: NonNullable<CreatePinWorkerSuccess['draft']>;
  let draftSpentOutpoints: string[];
  try {
    const draftResult = await deps.runDraftWorker();
    if (!draftResult.draft || !draftResult.draft.unsignedTxHex) {
      throw new Error('createPin worker did not return an unsigned draft transaction.');
    }
    draft = draftResult.draft;
    draftSpentOutpoints = Array.isArray(draftResult.spentOutpoints)
      ? draftResult.spentOutpoints
      : draft.userInputs.map((utxo) => `${utxo.txId}:${utxo.outputIndex}`);
  } catch (error) {
    return fallbackToSelfPaid({
      reason: isNoUserUtxoDraftFailure(error) ? 'no_user_utxo' : 'service_unavailable',
      stage: 'address_info',
      quotaBefore,
    });
  }

  const advisoryFeeEstimate = Math.ceil(draft.estimatedTxSize * input.feeRate);

  let challenge: SponsorChallenge;
  try {
    challenge = await sponsorClient.getChallenge();
  } catch (error) {
    // Every sponsor failure falls back under the 'selfpay' policy (nothing
    // has been broadcast at this stage, so the fallback is always safe).
    const reason = normalizeSponsorReason((error as { reason?: unknown })?.reason, 'service_unavailable');
    return fallbackToSelfPaid({ reason, stage: 'challenge', quotaBefore, advisoryFeeEstimate });
  }

  const challengeSignature = await signMvcAddressMessage({
    mnemonic: input.mnemonic,
    path: input.walletPath,
    message: challenge.message,
  });

  const trafficAccount = input.trafficAccount
    ?? await deps.resolveTrafficAccount?.({ challengeId: challenge.challengeId });

  // Balance preflight, gated on the billing account the pre will actually use.
  // With a traffic account the pin bills account bytes, so the legacy sponsor
  // quota (availableAmount) is irrelevant — gating on it silently self-paid
  // every traffic-mode pin once a bot's legacy quota ran out (2026-09-07).
  if (trafficAccount) {
    const trafficBalanceBytes = trafficBalanceBytesOf(quotaBefore);
    if (trafficBalanceBytes !== undefined && draft.estimatedTxSize > 0 && trafficBalanceBytes < draft.estimatedTxSize) {
      return fallbackToSelfPaid({
        reason: 'insufficient_traffic',
        stage: 'address_info',
        quotaBefore,
        advisoryFeeEstimate,
      });
    }
  } else if (advisoryFeeEstimate > 0 && quotaBefore.availableAmount < advisoryFeeEstimate) {
    return fallbackToSelfPaid({
      reason: 'insufficient_quota',
      stage: 'address_info',
      quotaBefore,
      advisoryFeeEstimate,
    });
  }

  let pre: SponsorPreResult;
  try {
    pre = await sponsorClient.preSponsor({
      address: input.mvcAddress,
      txHex: draft.unsignedTxHex,
      challengeId: challenge.challengeId,
      publicKey: challengeSignature.publicKey,
      signature: challengeSignature.signature,
      trafficAccount,
    });
  } catch (error) {
    // pre_rejected now falls back too: the sponsor refused the draft but
    // nothing was broadcast, so the bot's own wallet can still deliver.
    const reason = normalizeSponsorReason((error as { reason?: unknown })?.reason, 'pre_rejected');
    return fallbackToSelfPaid({ reason, stage: 'pre', quotaBefore, advisoryFeeEstimate });
  }

  let signedTxHex: string;
  try {
    signedTxHex = (await signMvcPreparedUserInputs({
      mnemonic: input.mnemonic,
      walletPath: input.walletPath,
      mvcAddress: input.mvcAddress,
      preparedTxHex: pre.preparedTxHex,
      userInputs: draft.userInputs,
      userInputIndexes: pre.userInputIndexes,
    })).txHex;
  } catch (error) {
    // Local signing failure: the sponsor never received a signed tx, so the
    // order can never be committed — falling back is double-write-safe.
    appendMetaidLog('WARN', 'Sponsored MVC createPin user-input signing failed — falling back to self-paid', {
      metabotId: input.metabotId,
      orderId: pre.orderId,
      error: getErrorMessage(error, 'user-input signing failed'),
    });
    return fallbackToSelfPaid({
      reason: 'pre_rejected',
      stage: 'commit',
      orderId: pre.orderId,
      quotaBefore,
      advisoryFeeEstimate,
    });
  }

  const commitMessage = getMvcSponsorCommitMessage({ orderId: pre.orderId, signedTxHex });
  const commitSignature = await signMvcAddressMessage({
    mnemonic: input.mnemonic,
    path: input.walletPath,
    message: commitMessage,
  });

  let commitRecovered = false;
  let commit: SponsorCommitResult;
  try {
    commit = await sponsorClient.commitSponsor({
      orderId: pre.orderId,
      signedTxHex,
      publicKey: commitSignature.publicKey,
      signature: commitSignature.signature,
    });
  } catch (error) {
    // The sponsor already holds our signed tx — reconcile the order before
    // any fallback so a broadcast that merely lost its response resolves as
    // success instead of double-writing. This is the 2026-09-08 outage fix:
    // sponsor-side broadcast failures ([-25]Missing inputs /
    // SPONSOR_BROADCAST_PENDING) used to hard-fail every traffic-mode write.
    const reconciliation = await reconcileSponsorOrderAfterCommitFailure({
      orderId: pre.orderId,
      client: sponsorClient,
      pollIntervalMs: input.commitReconcilePollIntervalMs,
      maxWaitMs: input.commitReconcileMaxWaitMs,
    });
    if (reconciliation.outcome === 'broadcasted' && reconciliation.txId) {
      appendMetaidLog('WARN', 'Sponsored MVC createPin commit failed its response but the order broadcast — resolving as sponsored success', {
        metabotId: input.metabotId,
        orderId: pre.orderId,
        txId: reconciliation.txId,
        commitError: getErrorMessage(error, 'commit failed'),
      });
      commit = {
        txId: reconciliation.txId,
        txSize: reconciliation.txSize,
        minerFee: reconciliation.minerFee,
        raw: { commitRecovered: true },
      };
      commitRecovered = true;
    } else {
      // A still-pending order is abandoned deliberately: the self-paid tx
      // draws from the same address, so the two transactions usually conflict
      // and at most one lands; a duplicate is possible only if the sponsor
      // recovers inside the race window, and the trace below pinpoints it.
      appendMetaidLog('WARN', 'Sponsored MVC createPin commit failed — falling back to self-paid', {
        metabotId: input.metabotId,
        mvcAddress: input.mvcAddress,
        orderId: pre.orderId,
        commitOrderOutcome: reconciliation.outcome,
        orderStatus: reconciliation.status,
        orderFailureReason: reconciliation.failureReason,
        commitError: getErrorMessage(error, 'commit failed'),
        fallbackPolicy: input.fallbackPolicy,
      });
      return fallbackToSelfPaid({
        reason: 'commit_failed',
        stage: 'commit',
        orderId: pre.orderId,
        quotaBefore,
        advisoryFeeEstimate,
        commitOrderOutcome: reconciliation.outcome === 'failed' || reconciliation.outcome === 'pending' || reconciliation.outcome === 'unknown'
          ? reconciliation.outcome
          : undefined,
      });
    }
  }

  const sponsoredMinerFee = commit.minerFee ?? pre.minerFee;
  deps.recordSpentOutpoints(draftSpentOutpoints);
  // Local spend journal + balance-cache deduction (best-effort, never throws).
  recordLocalTrafficSpend({
    txId: commit.txId,
    botAddress: input.mvcAddress,
    orderId: pre.orderId,
    txSize: commit.txSize,
    sponsoredMinerFee,
    savedFee: sponsoredMinerFee,
    billedBy: trafficAccount ? 'traffic' : 'quota',
    kind: input.journalKind,
  });
  const changeUtxo: MvcCachedFundingUtxo | null = draft.changeOutput
    ? {
      txId: commit.txId,
      outputIndex: draft.changeOutput.outputIndex,
      satoshis: draft.changeOutput.satoshis,
      address: input.mvcAddress,
      height: -1,
    }
    : null;
  deps.replacePendingFundingUtxos(changeUtxo);

  let quotaAfter: MvcSponsorAddressInfo | undefined;
  try {
    quotaAfter = await sponsorClient.getAddressInfo({ address: input.mvcAddress });
  } catch {
    quotaAfter = undefined;
  }

  return {
    txids: [commit.txId],
    pinId: `${commit.txId}i0`,
    totalCost: sponsoredMinerFee,
    spentOutpoints: draftSpentOutpoints,
    changeUtxo,
    feeAssist: {
      attempted: true,
      used: true,
      mode: 'mvc_sponsor_v2',
      sponsor: 'mvc_sponsor_v2',
      stage: 'done',
      orderId: pre.orderId,
      commitRecovered: commitRecovered || undefined,
      quotaBefore,
      quotaAfter,
      advisoryFeeEstimate,
      sponsoredMinerFee,
      savedFee: sponsoredMinerFee,
      txSize: commit.txSize,
    },
  };
}
