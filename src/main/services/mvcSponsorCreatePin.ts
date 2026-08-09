/**
 * Sponsored (traffic-mode) MVC createPin orchestration.
 * Runs the generic sponsor v2 protocol (mvcSponsorClient) for any MetaID pin:
 * unsigned worker draft -> quota preflight -> challenge -> pre -> sign user
 * inputs -> commit, then maintains the MVC spend session state exactly like
 * the broadcast path. Fallback semantics for the createPin main path:
 * service_unavailable / no_user_utxo / insufficient_quota /
 * insufficient_traffic fall back to the regular self-paid broadcast
 * (fallbackPolicy 'selfpay', tagged with feeAssist metadata) or throw a
 * TrafficInsufficientError ('strict'); pre_rejected / commit_failed are hard
 * failures carrying feeAssist diagnostics.
 */

import {
  createMvcSponsorV2Client,
  getErrorMessage,
  getMvcSponsorCommitMessage,
  isNoUserUtxoDraftError,
  signMvcAddressMessage,
  signMvcPreparedUserInputs,
  type MvcSponsorAddressInfo,
  type MvcSponsorTrafficAccount,
  type MvcSponsorV2Client,
} from './mvcSponsorClient';
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

export type MvcSponsorCreatePinFallbackReason =
  | 'service_unavailable'
  | 'no_user_utxo'
  | 'insufficient_quota'
  | 'insufficient_traffic';

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
}

export interface MvcSponsorCreatePinDeps {
  /** Draft-mode worker run; the caller wraps it with the standard stale-funding session recovery. */
  runDraftWorker: () => Promise<CreatePinWorkerSuccess>;
  /** Regular self-paid broadcast path, used by the 'selfpay' fallback policy. */
  runBroadcastWorker: () => Promise<CreatePinWorkerSuccess>;
  recordSpentOutpoints: (outpoints: string[]) => void;
  replacePendingFundingUtxos: (utxo: MvcCachedFundingUtxo | null) => void;
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

function isFallbackReason(reason: MvcSponsorFeeAssistReason): reason is MvcSponsorCreatePinFallbackReason {
  return reason === 'service_unavailable'
    || reason === 'no_user_utxo'
    || reason === 'insufficient_quota'
    || reason === 'insufficient_traffic';
}

function isNoUserUtxoDraftFailure(error: unknown): boolean {
  const message = getErrorMessage(error, '');
  return isNoUserUtxoDraftError(error)
    || /not enough balance|余额不足/i.test(message)
    || message.includes('所有已知 MVC 手续费输入都已失效');
}

function getStableErrorCode(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && code.trim() ? code.trim() : fallback;
}

function attachFeeAssistError(input: {
  error: unknown;
  fallbackCode: string;
  fallbackReason: MvcSponsorFeeAssistReason;
  stage: MvcSponsorFeeAssistStage;
  orderId?: string;
  quotaBefore?: MvcSponsorAddressInfo;
  advisoryFeeEstimate?: number;
  sponsoredMinerFee?: number;
}): never {
  const error = input.error instanceof Error
    ? input.error as Error & { code?: string; data?: Record<string, unknown>; reason?: MvcSponsorFeeAssistReason }
    : new Error(getErrorMessage(input.error, `MVC sponsor ${input.stage} failed.`)) as Error & { code?: string; data?: Record<string, unknown> };
  error.code = getStableErrorCode(error, input.fallbackCode);
  const existingData = error.data && typeof error.data === 'object' ? error.data : {};
  error.data = {
    ...existingData,
    feeAssist: {
      attempted: true,
      used: false,
      mode: 'mvc_sponsor_v2',
      sponsor: 'mvc_sponsor_v2',
      reason: normalizeSponsorReason((error as { reason?: unknown }).reason, input.fallbackReason),
      stage: input.stage,
      orderId: input.orderId,
      quotaBefore: input.quotaBefore,
      advisoryFeeEstimate: input.advisoryFeeEstimate,
      sponsoredMinerFee: input.sponsoredMinerFee,
      savedFee: input.sponsoredMinerFee,
    } satisfies MvcSponsorFeeAssistMetadata,
  };
  throw error;
}

export async function runMvcSponsorCreatePin(
  input: MvcSponsorCreatePinInput,
  deps: MvcSponsorCreatePinDeps,
): Promise<MvcSponsorCreatePinResult> {
  const sponsorClient = createMvcSponsorV2Client({ baseUrl: input.baseUrl, fetchImpl: input.fetchImpl });

  const fallbackToSelfPaid = async (params: {
    reason: MvcSponsorCreatePinFallbackReason;
    stage: MvcSponsorFeeAssistStage;
    quotaBefore?: MvcSponsorAddressInfo;
    advisoryFeeEstimate?: number;
  }): Promise<MvcSponsorCreatePinResult> => {
    const feeAssist: CreatePinFeeAssistMetadata = {
      attempted: true,
      used: false,
      mode: 'self_paid',
      sponsor: 'mvc_sponsor_v2',
      reason: params.reason,
      stage: params.stage,
      quotaBefore: params.quotaBefore,
      advisoryFeeEstimate: params.advisoryFeeEstimate,
    };
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
  if (advisoryFeeEstimate > 0 && quotaBefore.availableAmount < advisoryFeeEstimate) {
    return fallbackToSelfPaid({
      reason: 'insufficient_quota',
      stage: 'address_info',
      quotaBefore,
      advisoryFeeEstimate,
    });
  }

  let challenge: SponsorChallenge;
  try {
    challenge = await sponsorClient.getChallenge();
  } catch (error) {
    const reason = normalizeSponsorReason((error as { reason?: unknown })?.reason, 'service_unavailable');
    if (isFallbackReason(reason)) {
      return fallbackToSelfPaid({ reason, stage: 'challenge', quotaBefore, advisoryFeeEstimate });
    }
    attachFeeAssistError({
      error,
      fallbackCode: 'mvc_fee_assist_challenge_failed',
      fallbackReason: 'service_unavailable',
      stage: 'challenge',
      quotaBefore,
      advisoryFeeEstimate,
    });
  }

  const challengeSignature = await signMvcAddressMessage({
    mnemonic: input.mnemonic,
    path: input.walletPath,
    message: challenge.message,
  });

  let pre: SponsorPreResult;
  try {
    pre = await sponsorClient.preSponsor({
      address: input.mvcAddress,
      txHex: draft.unsignedTxHex,
      challengeId: challenge.challengeId,
      publicKey: challengeSignature.publicKey,
      signature: challengeSignature.signature,
      trafficAccount: input.trafficAccount,
    });
  } catch (error) {
    const reason = normalizeSponsorReason((error as { reason?: unknown })?.reason, 'pre_rejected');
    if (isFallbackReason(reason)) {
      return fallbackToSelfPaid({ reason, stage: 'pre', quotaBefore, advisoryFeeEstimate });
    }
    attachFeeAssistError({
      error,
      fallbackCode: 'mvc_fee_assist_pre_failed',
      fallbackReason: 'pre_rejected',
      stage: 'pre',
      quotaBefore,
      advisoryFeeEstimate,
    });
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
    attachFeeAssistError({
      error,
      fallbackCode: 'mvc_fee_assist_commit_failed',
      fallbackReason: 'pre_rejected',
      stage: 'commit',
      orderId: pre.orderId,
      quotaBefore,
      advisoryFeeEstimate,
      sponsoredMinerFee: pre.minerFee,
    });
  }

  const commitMessage = getMvcSponsorCommitMessage({ orderId: pre.orderId, signedTxHex });
  const commitSignature = await signMvcAddressMessage({
    mnemonic: input.mnemonic,
    path: input.walletPath,
    message: commitMessage,
  });

  let commit: SponsorCommitResult;
  try {
    commit = await sponsorClient.commitSponsor({
      orderId: pre.orderId,
      signedTxHex,
      publicKey: commitSignature.publicKey,
      signature: commitSignature.signature,
    });
  } catch (error) {
    attachFeeAssistError({
      error,
      fallbackCode: 'mvc_fee_assist_commit_failed',
      fallbackReason: 'commit_failed',
      stage: 'commit',
      orderId: pre.orderId,
      quotaBefore,
      advisoryFeeEstimate,
      sponsoredMinerFee: pre.minerFee,
    });
  }

  const sponsoredMinerFee = commit.minerFee ?? pre.minerFee;
  deps.recordSpentOutpoints(draftSpentOutpoints);
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
      quotaBefore,
      quotaAfter,
      advisoryFeeEstimate,
      sponsoredMinerFee,
      savedFee: sponsoredMinerFee,
      txSize: commit.txSize,
    },
  };
}
