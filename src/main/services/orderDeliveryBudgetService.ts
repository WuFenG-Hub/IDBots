/**
 * Order delivery funding budget (seller side).
 *
 * A paid order whose expected output is a file (image/video/audio/file) is not
 * complete until the artifact is pinned on-chain, and that upload is paid from
 * the provider bot's own MVC wallet (direct pin <= 5MB, chunked upload above).
 * Historically the order executor only learned about the 50MB hard cap, so it
 * happily generated multi-MB videos that the wallet could not afford to upload
 * — the skill run succeeded, delivery failed, and the order was refunded.
 *
 * This service measures the wallet's delivery capacity when the order is
 * accepted, turns it into concrete prompt guidance (so the executor sizes the
 * artifact to fit the budget), and flags orders that cannot possibly be
 * delivered so they are rejected before any skill work is burned.
 */

import type { MetabotStore } from '../metabotStore';
import {
  CHUNKED_UPLOAD_CHUNK_OVERHEAD_BYTES,
  CHUNKED_UPLOAD_CHUNK_SIZE_BYTES,
  CHUNKED_UPLOAD_FIXED_OVERHEAD_BYTES,
} from '../libs/uploadLargeFileFunding';
import { getRate as getGlobalFeeRate } from './feeRateStore';
import { getConfiguredTrafficPinMode } from './trafficAccountService';
import { getWalletBalanceSnapshot } from './walletQueryService';

/** Must stay in sync with DEFAULT_CHUNK_THRESHOLD_BYTES in metaFileUploadShared.js. */
export const DIRECT_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
/** Must stay in sync with DEFAULT_MAX_FILE_SIZE_BYTES in metaFileUploadShared.js. */
export const ORDER_DELIVERY_HARD_MAX_BYTES = 50 * 1024 * 1024;
/** Keep a safety margin between the measured capacity and the prompt target. */
export const DELIVERY_BUDGET_HEADROOM_RATIO = 0.8;
/** Reserve kept in the wallet for order status pins and merge-tx fees. */
export const DELIVERY_WALLET_RESERVE_SATS = 20_000;
/** Below this capacity even a minimal artifact cannot be uploaded; reject early. */
export const MIN_SELFPAID_DELIVERABLE_BYTES = 256 * 1024;
/** Keep in sync with MVC_SPONSOR_UPLOAD_ENABLED_KEY in metaFileUploadService.ts. */
const MVC_SPONSOR_UPLOAD_ENABLED_KEY = 'chain.mvcSponsorUploadEnabled';

export interface OrderDeliveryBudget {
  sponsorCoversDirectUpload: boolean;
  spendableSats: number;
  feeRate: number;
  /** Max file size (bytes) the wallet can fund for on-chain upload right now. */
  fundableBytes: number;
  /** Prompt target: stay under this size so delivery fits the wallet. */
  recommendedMaxBytes: number;
  /** True when the wallet cannot fund even a minimal artifact upload. */
  shouldRejectOrder: boolean;
}

export interface ResolveOrderDeliveryBudgetDeps {
  metabotStore: MetabotStore;
  metabotId: number;
  mvcAddress?: string | null;
  outputType?: string | null;
  fetchSpendableSats?: (address: string) => Promise<number>;
  getFeeRate?: (chain: string) => number;
  getTrafficPinMode?: () => string;
  isSponsorUploadEnabledForMetabot?: (metabotStore: MetabotStore, metabotId: number) => boolean;
}

export function isSponsorUploadEnabledForMetabot(metabotStore: MetabotStore, metabotId: number): boolean {
  const raw = metabotStore.getMetabotSetting(metabotId, MVC_SPONSOR_UPLOAD_ENABLED_KEY);
  if (raw === null || raw === undefined) return true;
  const normalized = String(raw).trim().toLowerCase();
  return normalized !== 'false' && normalized !== '0';
}

export function computeFundableDeliveryBytes(spendableSats: number, feeRate: number): number {
  const rate = Math.max(1, Math.floor(Number(feeRate) || 0));
  const budgetSats = Math.max(0, Math.floor(Number(spendableSats) || 0) - DELIVERY_WALLET_RESERVE_SATS);
  if (budgetSats <= 0) return 0;
  // Invert estimateChunkedUploadFundingSats: cost ≈ (size + ceil(size/chunkSize)
  // * CHUNK_OVERHEAD + FIXED_OVERHEAD) * rate. The closed form below drops the
  // ceil and subtracts one extra chunk overhead to stay conservative.
  const virtualBytes = Math.floor(
    budgetSats / rate
    - CHUNKED_UPLOAD_FIXED_OVERHEAD_BYTES
    - CHUNKED_UPLOAD_CHUNK_OVERHEAD_BYTES,
  );
  if (virtualBytes <= 0) return 0;
  return Math.floor(
    (virtualBytes * CHUNKED_UPLOAD_CHUNK_SIZE_BYTES)
    / (CHUNKED_UPLOAD_CHUNK_SIZE_BYTES + CHUNKED_UPLOAD_CHUNK_OVERHEAD_BYTES),
  );
}

export function buildOrderDeliveryBudget(input: {
  sponsorCoversDirectUpload: boolean;
  spendableSats: number;
  feeRate: number;
}): OrderDeliveryBudget {
  const fundableBytes = computeFundableDeliveryBytes(input.spendableSats, input.feeRate);
  const headroomBytes = Math.floor(fundableBytes * DELIVERY_BUDGET_HEADROOM_RATIO);
  const recommendedMaxBytes = input.sponsorCoversDirectUpload
    // Platform covers direct pins; the wallet only pays above the threshold.
    ? Math.max(Math.floor(DIRECT_UPLOAD_MAX_BYTES * DELIVERY_BUDGET_HEADROOM_RATIO), Math.min(headroomBytes, ORDER_DELIVERY_HARD_MAX_BYTES))
    : Math.min(headroomBytes, ORDER_DELIVERY_HARD_MAX_BYTES);
  return {
    sponsorCoversDirectUpload: input.sponsorCoversDirectUpload,
    spendableSats: Math.max(0, Math.floor(Number(input.spendableSats) || 0)),
    feeRate: Math.max(1, Math.floor(Number(input.feeRate) || 0)),
    fundableBytes,
    recommendedMaxBytes,
    shouldRejectOrder: !input.sponsorCoversDirectUpload && fundableBytes < MIN_SELFPAID_DELIVERABLE_BYTES,
  };
}

/**
 * Resolve the delivery budget for an incoming seller order. Returns null when
 * the order has no file deliverable (text output) or when the balance query
 * fails — the caller must treat null as "no budget known" and let the order
 * proceed without guidance (fail open; never block orders on a flaky API).
 */
export async function resolveOrderDeliveryBudget(
  deps: ResolveOrderDeliveryBudgetDeps,
): Promise<OrderDeliveryBudget | null> {
  const outputType = String(deps.outputType || '').trim().toLowerCase();
  if (!outputType || outputType === 'text') return null;
  const address = String(deps.mvcAddress || '').trim();
  if (!address) return null;

  const fetchSpendableSats = deps.fetchSpendableSats ?? (async (target: string) => {
    const snapshot = await getWalletBalanceSnapshot('mvc', target);
    // Spendable = confirmed + unconfirmed: the chunked-upload worker funds
    // from any UTXO regardless of confirmation height.
    return snapshot.total_sats;
  });
  let spendableSats: number;
  try {
    spendableSats = await fetchSpendableSats(address);
  } catch {
    return null;
  }
  if (!Number.isFinite(spendableSats) || spendableSats < 0) return null;

  const getFeeRate = deps.getFeeRate ?? getGlobalFeeRate;
  const getPinMode = deps.getTrafficPinMode ?? getConfiguredTrafficPinMode;
  const sponsorEnabled = deps.isSponsorUploadEnabledForMetabot ?? isSponsorUploadEnabledForMetabot;
  const sponsorCoversDirectUpload = getPinMode() === 'traffic' && sponsorEnabled(deps.metabotStore, deps.metabotId);

  return buildOrderDeliveryBudget({
    sponsorCoversDirectUpload,
    spendableSats,
    feeRate: getFeeRate('mvc'),
  });
}
