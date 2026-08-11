/**
 * MVC sponsor v2 direct file upload (fee assistance).
 * Ported from open-agent-connect:
 * - src/core/subsidy/mvcSponsorV2Client.ts (API client)
 * - src/core/files/mvcSponsorDirectUpload.ts (direct-upload orchestration)
 * - src/core/chain/mvcFileInscriptionDraft.ts (unsigned draft + user-input signing)
 *
 * Flow: address info -> unsigned /file inscription draft -> quota check ->
 * challenge -> pre (sponsor prepares tx) -> sign user-owned inputs ->
 * commit (sponsor broadcasts). Self-paid fallback semantics preserved:
 * service_unavailable / no_user_utxo / insufficient_quota fall back to a
 * regular self-paid direct upload; pre_rejected / commit_failed are hard
 * failures carrying feeAssist diagnostics.
 *
 * The sponsor protocol itself (API client, message signing, UTXO fetch,
 * size/fee estimation, user-input signing) lives in mvcSponsorClient.ts;
 * this file keeps the /file inscription draft and the upload orchestration.
 *
 * Deviation note: open-agent-connect also tracks pending UTXOs after a
 * sponsor commit; IDBots instead relies on its existing MVC spend
 * coordinator and stale-input retry machinery.
 */

import fs from 'fs';
import { TxComposer, mvc } from 'meta-contract';
import {
  createMvcSponsorV2Client,
  estimateDraftMinerFee,
  fetchMvcAddressUtxos,
  getErrorMessage,
  getEstimatedBaseTxSize,
  getOpReturnScriptSize,
  isNoUserUtxoDraftError,
  pickUtxos,
  signMvcAddressMessage,
  signMvcPreparedUserInputs,
  type MvcSponsorAddressInfo,
  type MvcSponsorDraft,
  type SponsorMvcUtxo,
} from './mvcSponsorClient';
import { recordLocalTrafficSpend, resolveSponsorTrafficAccount } from './trafficAccountService';

export {
  createMvcSponsorV2Client,
  fetchMvcAddressUtxos,
  signMvcPreparedUserInputs,
} from './mvcSponsorClient';
export type {
  MvcSponsorAddressInfo,
  MvcSponsorDraft,
  MvcSponsorV2Client,
  SponsorMvcUtxo,
} from './mvcSponsorClient';

export type MvcSponsorFeeAssistMode = 'mvc_sponsor_v2' | 'self_paid';
export type MvcSponsorFeeAssistReason =
  | 'service_unavailable'
  | 'no_user_utxo'
  | 'insufficient_quota'
  | 'insufficient_traffic'
  | 'pre_rejected'
  | 'commit_failed';
export type MvcSponsorFeeAssistStage =
  | 'address_info'
  | 'challenge'
  | 'pre'
  | 'commit'
  | 'done';

export interface MvcSponsorFeeAssistMetadata {
  attempted: boolean;
  used: boolean;
  mode: MvcSponsorFeeAssistMode;
  sponsor: 'mvc_sponsor_v2';
  reason?: MvcSponsorFeeAssistReason;
  stage?: MvcSponsorFeeAssistStage;
  orderId?: string;
  quotaBefore?: MvcSponsorAddressInfo;
  quotaAfter?: MvcSponsorAddressInfo;
  advisoryFeeEstimate?: number;
  sponsoredMinerFee?: number;
  savedFee?: number;
}

export interface MvcSponsorDirectUploadInput {
  filePath: string;
  fileName: string;
  contentType: string;
  bytes: number;
  extension: string;
  mnemonic: string;
  walletPath: string;
  mvcAddress: string;
  globalMetaId?: string;
  /** Performs the regular direct upload used by the self-paid fallback paths. */
  selfPaidUpload: (
    feeAssist: MvcSponsorFeeAssistMetadata,
  ) => Promise<Record<string, unknown>>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  fetchUtxos?: (address: string) => Promise<SponsorMvcUtxo[]>;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function getStableErrorCode(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && code.trim() ? code.trim() : fallback;
}

// ---------------------------------------------------------------------------
// Unsigned /file inscription draft
// ---------------------------------------------------------------------------

function buildOpReturnParts(input: {
  operation: string;
  path: string;
  encryption: string;
  version: string;
  contentType: string;
  payload: Buffer;
}): Array<string | Buffer> {
  const parts: Array<string | Buffer> = ['metaid', input.operation];
  if (input.operation !== 'init') {
    parts.push(input.path.toLowerCase());
    parts.push(input.encryption);
    parts.push(input.version);
    parts.push(input.contentType);
    parts.push(input.payload);
  }
  return parts;
}

export function buildMvcFileInscriptionDraft(input: {
  mnemonic: string;
  walletPath: string;
  mvcAddress: string;
  request: {
    operation: string;
    path: string;
    encryption: string;
    version: string;
    contentType: string;
    payload: Buffer;
  };
  utxos: SponsorMvcUtxo[];
  feeRate?: number;
  deductMinerFeeFromChange?: boolean;
}): Promise<MvcSponsorDraft> {
  const feeRate = Number.isFinite(input.feeRate) && Number(input.feeRate) > 0 ? Number(input.feeRate) : 1;
  const deductMinerFeeFromChange = input.deductMinerFeeFromChange !== false;
  const addressObject = new mvc.Address(input.mvcAddress, mvc.Networks.livenet as never);

  const txComposer = new TxComposer();
  txComposer.appendP2PKHOutput({ address: addressObject, satoshis: 1 });
  txComposer.appendOpReturnOutput(buildOpReturnParts(input.request));

  const totalOutput = txComposer.tx.outputs.reduce((sum, output) => sum + Number(output.satoshis || 0), 0);
  const opReturnParts = buildOpReturnParts(input.request);
  const picked = pickUtxos(
    input.utxos,
    totalOutput,
    deductMinerFeeFromChange ? feeRate : 0,
    getEstimatedBaseTxSize(getOpReturnScriptSize(opReturnParts)),
  );
  for (const utxo of picked) {
    txComposer.appendP2PKHInput({
      address: addressObject,
      txId: utxo.txId,
      outputIndex: utxo.outputIndex,
      satoshis: utxo.satoshis,
    });
  }
  if (deductMinerFeeFromChange) {
    txComposer.appendChangeOutput(addressObject, feeRate);
  } else {
    const changeAmount = picked.reduce((sum, utxo) => sum + utxo.satoshis, 0) - totalOutput;
    if (changeAmount > 0) {
      txComposer.appendP2PKHOutput({ address: addressObject, satoshis: changeAmount });
    }
  }

  return Promise.resolve({
    address: input.mvcAddress,
    privateKey: null,
    userInputs: picked,
    unsignedTxHex: txComposer.getRawHex(),
  });
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

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

async function fallbackSelfPaidForSponsorError(input: {
  error: unknown;
  selfPaidUpload: MvcSponsorDirectUploadInput['selfPaidUpload'];
  fallbackReason: MvcSponsorFeeAssistReason;
  stage: MvcSponsorFeeAssistStage;
  quotaBefore?: MvcSponsorAddressInfo;
  advisoryFeeEstimate?: number;
}): Promise<Record<string, unknown>> {
  return input.selfPaidUpload({
    attempted: true,
    used: false,
    mode: 'self_paid',
    sponsor: 'mvc_sponsor_v2',
    reason: normalizeSponsorReason((input.error as { reason?: unknown })?.reason, input.fallbackReason),
    stage: input.stage,
    quotaBefore: input.quotaBefore,
    advisoryFeeEstimate: input.advisoryFeeEstimate,
  });
}

export async function uploadMvcSponsorDirectFile(
  input: MvcSponsorDirectUploadInput,
): Promise<Record<string, unknown>> {
  const data = await fs.promises.readFile(input.filePath);
  const request = {
    operation: 'create',
    path: '/file',
    encryption: '0',
    version: '1.0',
    contentType: input.contentType,
    payload: data,
  };

  const sponsorClient = createMvcSponsorV2Client({ baseUrl: input.baseUrl, fetchImpl: input.fetchImpl });

  let quotaBefore: MvcSponsorAddressInfo;
  try {
    quotaBefore = await sponsorClient.getAddressInfo({ address: input.mvcAddress });
  } catch (error) {
    return fallbackSelfPaidForSponsorError({
      error,
      selfPaidUpload: input.selfPaidUpload,
      fallbackReason: 'service_unavailable',
      stage: 'address_info',
    });
  }

  let draft: MvcSponsorDraft;
  let estimatedMinerFee = 0;
  try {
    const utxos = input.fetchUtxos
      ? await input.fetchUtxos(input.mvcAddress)
      : await fetchMvcAddressUtxos(input.mvcAddress);
    draft = await buildMvcFileInscriptionDraft({
      mnemonic: input.mnemonic,
      walletPath: input.walletPath,
      mvcAddress: input.mvcAddress,
      request,
      utxos,
      feeRate: 1,
      deductMinerFeeFromChange: false,
    });
    estimatedMinerFee = estimateDraftMinerFee({
      unsignedTxHex: draft.unsignedTxHex,
      userInputTotal: draft.userInputs.reduce((sum, utxo) => sum + utxo.satoshis, 0),
    });
  } catch (error) {
    if (!isNoUserUtxoDraftError(error)) {
      attachFeeAssistError({
        error,
        fallbackCode: 'mvc_fee_assist_address_info_failed',
        fallbackReason: 'service_unavailable',
        stage: 'address_info',
        quotaBefore,
      });
    }
    return fallbackSelfPaidForSponsorError({
      error,
      selfPaidUpload: input.selfPaidUpload,
      fallbackReason: 'no_user_utxo',
      stage: 'address_info',
      quotaBefore,
    });
  }

  if (estimatedMinerFee > 0 && quotaBefore.availableAmount < estimatedMinerFee) {
    return fallbackSelfPaidForSponsorError({
      error: { reason: 'insufficient_quota' },
      selfPaidUpload: input.selfPaidUpload,
      fallbackReason: 'insufficient_quota',
      stage: 'address_info',
      quotaBefore,
      advisoryFeeEstimate: estimatedMinerFee,
    });
  }

  let challenge: { challengeId: string; message: string; expiresAt?: string; raw: Record<string, unknown> };
  try {
    challenge = await sponsorClient.getChallenge();
  } catch (error) {
    if (normalizeSponsorReason((error as { reason?: unknown })?.reason, 'service_unavailable') === 'service_unavailable') {
      return fallbackSelfPaidForSponsorError({
        error,
        selfPaidUpload: input.selfPaidUpload,
        fallbackReason: 'service_unavailable',
        stage: 'challenge',
        quotaBefore,
        advisoryFeeEstimate: estimatedMinerFee,
      });
    }
    attachFeeAssistError({
      error,
      fallbackCode: 'mvc_fee_assist_challenge_failed',
      fallbackReason: 'service_unavailable',
      stage: 'challenge',
      quotaBefore,
      advisoryFeeEstimate: estimatedMinerFee,
    });
  }

  const challengeSignature = await signMvcAddressMessage({
    mnemonic: input.mnemonic,
    path: input.walletPath,
    message: challenge.message,
  });

  // Traffic-account billing (Phase D): undefined keeps the legacy quota path
  // (feature off, no account, unbound bot, or backend 404).
  const trafficAccount = await resolveSponsorTrafficAccount({
    botAddress: input.mvcAddress,
    challengeId: challenge.challengeId,
    botMnemonic: input.mnemonic,
    botWalletPath: input.walletPath,
  });

  let pre: {
    preparedTxHex: string;
    orderId: string;
    minerFee: number;
    userInputIndexes: number[];
    expiresAt?: string;
    raw: Record<string, unknown>;
  };
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
    const reason = normalizeSponsorReason((error as { reason?: unknown })?.reason, 'pre_rejected');
    if (reason === 'service_unavailable') {
      return fallbackSelfPaidForSponsorError({
        error,
        selfPaidUpload: input.selfPaidUpload,
        fallbackReason: 'service_unavailable',
        stage: 'pre',
        quotaBefore,
        advisoryFeeEstimate: estimatedMinerFee,
      });
    }
    attachFeeAssistError({
      error,
      fallbackCode: 'mvc_fee_assist_pre_failed',
      fallbackReason: reason === 'insufficient_quota' || reason === 'insufficient_traffic' ? reason : 'pre_rejected',
      stage: 'pre',
      quotaBefore,
      advisoryFeeEstimate: estimatedMinerFee,
    });
  }
  const advisoryFeeEstimate = estimatedMinerFee > 0 ? estimatedMinerFee : pre.minerFee;

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

  const signedTxHash = new mvc.Transaction(signedTxHex).id;
  const commitMessage = `assist-sponsor-commit:${pre.orderId}:${signedTxHash}`;
  const commitSignature = await signMvcAddressMessage({
    mnemonic: input.mnemonic,
    path: input.walletPath,
    message: commitMessage,
  });

  let commit: { txId: string; txSize?: number; minerFee?: number; raw: Record<string, unknown> };
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
  // Local spend journal + balance-cache deduction (best-effort, never throws).
  recordLocalTrafficSpend({
    txId: commit.txId,
    botAddress: input.mvcAddress,
    orderId: pre.orderId,
    txSize: commit.txSize,
    sponsoredMinerFee,
    savedFee: sponsoredMinerFee,
    billedBy: trafficAccount ? 'traffic' : 'quota',
    kind: request.path,
  });
  let quotaAfter: MvcSponsorAddressInfo | undefined;
  try {
    quotaAfter = await sponsorClient.getAddressInfo({ address: input.mvcAddress });
  } catch {
    quotaAfter = undefined;
  }
  const pinId = `${commit.txId}i0`;
  return {
    pinId,
    txids: [commit.txId],
    totalCost: sponsoredMinerFee,
    network: 'mvc',
    fileName: input.fileName,
    bytes: input.bytes,
    contentType: input.contentType,
    globalMetaId: input.globalMetaId,
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
    } satisfies MvcSponsorFeeAssistMetadata,
  };
}
