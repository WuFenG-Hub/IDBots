/**
 * MVC sponsor v2 protocol client (fee assistance).
 * Extracted from mvcSponsorUpload.ts so any pin type can run the
 * address-info -> challenge -> pre -> sign -> commit flow against the
 * sponsor service; /file inscription draft building and upload
 * orchestration stay in mvcSponsorUpload.ts.
 *
 * Error taxonomy: service_unavailable / no_user_utxo / insufficient_quota /
 * pre_rejected / commit_failed. insufficient_traffic is reserved for the
 * backend TRAFFIC_INSUFFICIENT error code (traffic-account billing, not yet
 * live); preSponsor accepts an optional trafficAccount pass-through so the
 * backend can switch an order to traffic billing once it ships.
 */

import { TxComposer, mvc } from 'meta-contract';
import { AddressType, BtcWallet, CoinType } from '@metalet/utxo-wallet-service';

const DEFAULT_ASSIST_OPEN_API_BASE_URL = 'https://www.metaso.network/assist-open-api';
const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';
const P2PKH_INPUT_SIZE = 148;
const MIN_MVC_UTXO_SATS = 600;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_RETRY_DELAYS_MS = [250, 750] as const;
const TRAFFIC_INSUFFICIENT_ERROR_CODE = 'TRAFFIC_INSUFFICIENT';

export interface MvcSponsorAddressInfo {
  exists: boolean;
  balance: number;
  grantedAmount: number;
  reservedAmount: number;
  spentAmount: number;
  availableAmount: number;
  status: string;
  raw: Record<string, unknown>;
}

export interface MvcSponsorTrafficAccount {
  accountId: string;
  authSignature: string;
  timestamp: number;
}

export interface SponsorMvcUtxo {
  txId: string;
  outputIndex: number;
  satoshis: number;
  address: string;
  height: number;
}

export interface MvcSponsorDraft {
  address: string;
  privateKey: unknown;
  userInputs: SponsorMvcUtxo[];
  unsignedTxHex: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalizeBaseUrl(value: unknown): string {
  const text = normalizeText(value);
  return (text || DEFAULT_ASSIST_OPEN_API_BASE_URL).replace(/\/+$/, '');
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickText(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = normalizeText(record[key]);
    if (value) {
      return value;
    }
  }
  return '';
}

function toFiniteNumber(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function normalizeBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return null;
}

export function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function isNoUserUtxoDraftError(error: unknown): boolean {
  return /MetaBot balance is insufficient for this chain write\./i.test(getErrorMessage(error, ''));
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 504);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseAddressIndexFromPath(pathStr: string): number {
  if (!pathStr || typeof pathStr !== 'string') return 0;
  const m = pathStr.match(/\/0\/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

// ---------------------------------------------------------------------------
// Sponsor v2 API client
// ---------------------------------------------------------------------------

export type SponsorStage = 'address_info' | 'challenge' | 'pre' | 'commit';
export type SponsorReason =
  | 'insufficient_quota'
  | 'insufficient_traffic'
  | 'service_unavailable'
  | 'commit_failed'
  | 'pre_rejected'
  | 'invalid_request';

export interface SponsorClientError extends Error {
  code: string;
  stage: SponsorStage;
  reason: SponsorReason;
  serviceMessage: string;
  status?: number;
  data?: unknown;
  retryable?: boolean;
}

function normalizeReason(stage: SponsorStage, message: string): SponsorReason {
  if (/TRAFFIC_INSUFFICIENT/i.test(message)) {
    return 'insufficient_traffic';
  }
  if (/available amount not enough|quota not granted|insufficient quota|insufficient balance/i.test(message)) {
    return 'insufficient_quota';
  }
  if (stage === 'pre' && /\b(address not match|txin empty|tx in empty|rejected|invalid tx|invalid transaction|first input)\b/i.test(message)) {
    return 'pre_rejected';
  }
  if (stage === 'commit' || /commit/i.test(message)) {
    return 'commit_failed';
  }
  return 'service_unavailable';
}

function normalizeErrorCodeReason(code: unknown): SponsorReason | undefined {
  return normalizeText(code).toUpperCase() === TRAFFIC_INSUFFICIENT_ERROR_CODE
    ? 'insufficient_traffic'
    : undefined;
}

function createSponsorError(
  stage: SponsorStage,
  message: string,
  extra: { status?: number; data?: unknown; reason?: SponsorReason; retryable?: boolean } = {},
): SponsorClientError {
  const serviceMessage = normalizeText(message) || `MVC sponsor ${stage} failed.`;
  const error = new Error(serviceMessage) as SponsorClientError;
  error.code = `mvc_fee_assist_${stage}_failed`;
  error.stage = stage;
  error.reason = extra.reason ?? normalizeReason(stage, serviceMessage);
  error.serviceMessage = serviceMessage;
  if (extra.status !== undefined) error.status = extra.status;
  if (extra.data !== undefined) error.data = extra.data;
  if (extra.retryable !== undefined) error.retryable = extra.retryable;
  return error;
}

export function isSponsorClientError(error: unknown): error is SponsorClientError {
  return typeof (error as { code?: unknown } | undefined)?.code === 'string'
    && (error as { code: string }).code.startsWith('mvc_fee_assist_');
}

function isRetryableSponsorError(error: unknown): boolean {
  return (error as { retryable?: unknown } | undefined)?.retryable === true;
}

function unwrapEnvelope(body: unknown, stage: SponsorStage): Record<string, unknown> {
  const record = readObject(body);
  if (!record) {
    throw createSponsorError(stage, 'Sponsor service returned a non-object response.');
  }
  if (!('code' in record)) {
    return record;
  }
  const code = Number(record.code);
  if (Number.isFinite(code) && code === 0) {
    const data = readObject(record.data);
    if (!data) {
      throw createSponsorError(stage, 'Sponsor service returned an empty data payload.', {
        data: record.data,
      });
    }
    return data;
  }
  throw createSponsorError(
    stage,
    pickText(record, 'message', 'msg', 'error') || `Sponsor service returned code ${normalizeText(record.code) || 'unknown'}.`,
    {
      data: record.data,
      reason: normalizeErrorCodeReason(record.code),
      retryable: normalizeBoolean(readObject(record.data)?.retryable) === true,
    },
  );
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  stage: SponsorStage,
  retry: boolean,
): Promise<Record<string, unknown>> {
  const timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  const retryDelaysMs = retry ? DEFAULT_RETRY_DELAYS_MS : [];
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw createSponsorError(
          stage,
          `Sponsor service returned invalid JSON${response.status ? ` (HTTP ${response.status})` : ''}.`,
          { status: response.status, retryable: isRetryableHttpStatus(response.status) },
        );
      }
      if (!response.ok) {
        const record = readObject(body);
        throw createSponsorError(
          stage,
          record
            ? pickText(record, 'message', 'msg', 'error') || `Sponsor service request failed with HTTP ${response.status}.`
            : `Sponsor service request failed with HTTP ${response.status}.`,
          {
            status: response.status,
            data: record?.data,
            reason: normalizeErrorCodeReason(record?.code),
            retryable: isRetryableHttpStatus(response.status),
          },
        );
      }
      return unwrapEnvelope(body, stage);
    } catch (error) {
      if (controller.signal.aborted) {
        const err = createSponsorError(stage, `Sponsor service request timed out after ${timeoutMs}ms.`, {
          retryable: true,
        });
        if (isRetryableSponsorError(err) && attempt < retryDelaysMs.length) {
          await delay(retryDelaysMs[attempt]);
          continue;
        }
        throw err;
      }
      if (isSponsorClientError(error)) {
        if (isRetryableSponsorError(error) && attempt < retryDelaysMs.length) {
          await delay(retryDelaysMs[attempt]);
          continue;
        }
        throw error;
      }
      const err = createSponsorError(stage, getErrorMessage(error, 'Sponsor service request failed.'), {
        retryable: true,
      });
      if (isRetryableSponsorError(err) && attempt < retryDelaysMs.length) {
        await delay(retryDelaysMs[attempt]);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}

function normalizeRequiredNumber(stage: SponsorStage, record: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === 'string' && !raw.trim()) continue;
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : Number.NaN;
    if (Number.isFinite(value)) return value;
  }
  throw createSponsorError(stage, `Sponsor ${stage} response is missing required fields.`, {
    data: record,
    reason: stage === 'commit' ? 'commit_failed' : stage === 'pre' ? 'pre_rejected' : 'service_unavailable',
  });
}

function normalizeOptionalNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === 'string' && !raw.trim()) continue;
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : Number.NaN;
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

function normalizeUserInputIndexes(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('missing');
  }
  const result: number[] = [];
  for (const item of value) {
    if (typeof item === 'string' && !item.trim()) throw new Error('invalid');
    const numeric = Number(item);
    if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric < 0) {
      throw new Error('invalid');
    }
    result.push(numeric);
  }
  return result;
}

function normalizeAddressInfo(record: Record<string, unknown>): MvcSponsorAddressInfo {
  const exists = normalizeBoolean(record.exists);
  const status = pickText(record, 'status');
  if (exists === null || !status) {
    throw createSponsorError('address_info', 'Sponsor address info response is missing required fields.', {
      data: record,
    });
  }
  return {
    exists,
    balance: normalizeRequiredNumber('address_info', record, 'balance'),
    grantedAmount: normalizeRequiredNumber('address_info', record, 'grantedAmount', 'granted_amount'),
    reservedAmount: normalizeRequiredNumber('address_info', record, 'reservedAmount', 'reserved_amount'),
    spentAmount: normalizeRequiredNumber('address_info', record, 'spentAmount', 'spent_amount'),
    availableAmount: normalizeRequiredNumber('address_info', record, 'availableAmount', 'available_amount'),
    status,
    raw: record,
  };
}

function normalizeChallenge(record: Record<string, unknown>): {
  challengeId: string;
  message: string;
  expiresAt?: string;
  raw: Record<string, unknown>;
} {
  const challengeId = pickText(record, 'challengeId', 'challenge_id');
  const message = pickText(record, 'message');
  if (!challengeId || !message) {
    throw createSponsorError('challenge', 'Sponsor challenge response is missing required fields.', {
      data: record,
    });
  }
  const expiresAt = pickText(record, 'expiresAt', 'expires_at');
  return { challengeId, message, expiresAt: expiresAt || undefined, raw: record };
}

function normalizePreResult(record: Record<string, unknown>): {
  preparedTxHex: string;
  orderId: string;
  minerFee: number;
  userInputIndexes: number[];
  expiresAt?: string;
  raw: Record<string, unknown>;
} {
  const preparedTxHex = pickText(record, 'preparedTxHex', 'prepared_tx_hex');
  const orderId = pickText(record, 'orderId', 'order_id');
  if (!preparedTxHex || !orderId) {
    throw createSponsorError('pre', 'Sponsor pre response is missing required fields.', {
      data: record,
      reason: 'pre_rejected',
    });
  }
  let userInputIndexes: number[];
  try {
    userInputIndexes = normalizeUserInputIndexes(record.userInputIndexes ?? record.user_input_indexes);
  } catch {
    throw createSponsorError('pre', 'Sponsor pre response is missing required fields.', {
      data: record,
      reason: 'pre_rejected',
    });
  }
  const expiresAt = pickText(record, 'expiresAt', 'expires_at');
  return {
    preparedTxHex,
    orderId,
    minerFee: normalizeRequiredNumber('pre', record, 'minerFee', 'miner_fee'),
    userInputIndexes,
    expiresAt: expiresAt || undefined,
    raw: record,
  };
}

function normalizeCommitResult(record: Record<string, unknown>): {
  txId: string;
  txSize?: number;
  minerFee?: number;
  raw: Record<string, unknown>;
} {
  const txId = pickText(record, 'txId', 'txid');
  if (!txId) {
    throw createSponsorError('commit', 'Sponsor commit response is missing required fields.', {
      data: record,
      reason: 'commit_failed',
    });
  }
  const result: { txId: string; txSize?: number; minerFee?: number; raw: Record<string, unknown> } = {
    txId,
    raw: record,
  };
  const txSize = normalizeOptionalNumber(record, 'txSize', 'tx_size');
  const minerFee = normalizeOptionalNumber(record, 'minerFee', 'miner_fee');
  if (txSize !== undefined) result.txSize = txSize;
  if (minerFee !== undefined) result.minerFee = minerFee;
  return result;
}

function normalizeSponsorOrder(record: Record<string, unknown>): {
  orderId: string;
  status: string;
  txId?: string;
  txSize: number;
  minerFee: number;
  pending: boolean;
  final: boolean;
  failureReason?: string;
  raw: Record<string, unknown>;
} {
  const orderId = pickText(record, 'orderId', 'order_id');
  const status = pickText(record, 'status');
  const pending = normalizeBoolean(record.pending);
  const final = normalizeBoolean(record.final);
  if (!orderId || !status || pending === null || final === null) {
    throw createSponsorError('commit', 'Sponsor order response is missing required fields.', {
      data: record,
      reason: 'commit_failed',
    });
  }
  const txId = pickText(record, 'txId', 'txid');
  const failureReason = pickText(record, 'failureReason', 'failure_reason');
  return {
    orderId,
    status,
    txId: txId || undefined,
    txSize: normalizeRequiredNumber('commit', record, 'txSize', 'tx_size'),
    minerFee: normalizeRequiredNumber('commit', record, 'minerFee', 'miner_fee'),
    pending,
    final,
    failureReason: failureReason || undefined,
    raw: record,
  };
}

function requireText(stage: SponsorStage, field: string, value: unknown): string {
  const normalized = normalizeText(value);
  if (normalized) return normalized;
  throw createSponsorError(stage, `${field} is required`, {
    reason: stage === 'commit' ? 'commit_failed' : stage === 'pre' ? 'pre_rejected' : 'invalid_request',
  });
}

function normalizeTrafficAccount(value: unknown): MvcSponsorTrafficAccount | undefined {
  const record = readObject(value);
  if (!record) {
    return undefined;
  }
  const timestamp = toFiniteNumber(record.timestamp);
  if (timestamp <= 0) {
    throw createSponsorError('pre', 'trafficAccount.timestamp is required', { reason: 'invalid_request' });
  }
  return {
    accountId: requireText('pre', 'trafficAccount.accountId', record.accountId),
    authSignature: requireText('pre', 'trafficAccount.authSignature', record.authSignature),
    timestamp,
  };
}

export interface MvcSponsorV2Client {
  baseUrl: string;
  getAddressInfo(payload: { address: string }): Promise<MvcSponsorAddressInfo>;
  getChallenge(): Promise<{
    challengeId: string;
    message: string;
    expiresAt?: string;
    raw: Record<string, unknown>;
  }>;
  preSponsor(payload: {
    address: string;
    txHex: string;
    challengeId: string;
    publicKey: string;
    signature: string;
    /** Reserved pass-through for traffic-account billing (backend not yet live). */
    trafficAccount?: MvcSponsorTrafficAccount;
  }): Promise<{
    preparedTxHex: string;
    orderId: string;
    minerFee: number;
    userInputIndexes: number[];
    expiresAt?: string;
    raw: Record<string, unknown>;
  }>;
  commitSponsor(payload: {
    orderId: string;
    signedTxHex: string;
    publicKey: string;
    signature: string;
  }): Promise<{
    txId: string;
    txSize?: number;
    minerFee?: number;
    raw: Record<string, unknown>;
  }>;
  getSponsorOrder(orderId: string): Promise<{
    orderId: string;
    status: string;
    txId?: string;
    txSize: number;
    minerFee: number;
    pending: boolean;
    final: boolean;
    failureReason?: string;
    raw: Record<string, unknown>;
  }>;
}

export function createMvcSponsorV2Client(input: {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
} = {}): MvcSponsorV2Client {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const fetchImpl = input.fetchImpl ?? fetch;

  async function getSponsorOrder(orderIdValue: unknown): Promise<{
    orderId: string;
    status: string;
    txId?: string;
    txSize: number;
    minerFee: number;
    pending: boolean;
    final: boolean;
    failureReason?: string;
    raw: Record<string, unknown>;
  }> {
    const orderId = requireText('commit', 'orderId', orderIdValue);
    const record = await requestJson(
      fetchImpl,
      `${baseUrl}/v2/assist/gas/mvc/order/${encodeURIComponent(orderId)}`,
      { method: 'GET', headers: { accept: 'application/json' } },
      'commit',
      true,
    );
    return normalizeSponsorOrder(record);
  }

  return {
    baseUrl,
    async getAddressInfo(payload: { address: string }) {
      const address = requireText('address_info', 'address', payload?.address);
      const url = new URL(`${baseUrl}/v2/assist/gas/address/info`);
      url.searchParams.set('address', address);
      url.searchParams.set('gasChain', 'mvc');
      const record = await requestJson(
        fetchImpl,
        url.toString(),
        { method: 'GET', headers: { accept: 'application/json' } },
        'address_info',
        true,
      );
      return normalizeAddressInfo(record);
    },
    async getChallenge() {
      const record = await requestJson(
        fetchImpl,
        `${baseUrl}/v2/assist/gas/mvc/challenge`,
        { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({}) },
        'challenge',
        true,
      );
      return normalizeChallenge(record);
    },
    async preSponsor(payload) {
      const trafficAccount = normalizeTrafficAccount(payload?.trafficAccount);
      const record = await requestJson(
        fetchImpl,
        `${baseUrl}/v2/assist/gas/mvc/pre`,
        {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({
            address: requireText('pre', 'address', payload?.address),
            txHex: requireText('pre', 'txHex', payload?.txHex),
            challengeId: requireText('pre', 'challengeId', payload?.challengeId),
            publicKey: requireText('pre', 'publicKey', payload?.publicKey),
            signature: requireText('pre', 'signature', payload?.signature),
            ...(trafficAccount ? { trafficAccount } : {}),
          }),
        },
        'pre',
        false,
      );
      return normalizePreResult(record);
    },
    async commitSponsor(payload) {
      const orderId = requireText('commit', 'orderId', payload?.orderId);
      try {
        const record = await requestJson(
          fetchImpl,
          `${baseUrl}/v2/assist/gas/mvc/commit`,
          {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({
              orderId,
              signedTxHex: requireText('commit', 'signedTxHex', payload?.signedTxHex),
              publicKey: requireText('commit', 'publicKey', payload?.publicKey),
              signature: requireText('commit', 'signature', payload?.signature),
            }),
          },
          'commit',
          true,
        );
        return normalizeCommitResult(record);
      } catch (error) {
        if (!isRetryableSponsorError(error)) {
          throw error;
        }
        try {
          const order = await getSponsorOrder(orderId);
          if (order.final && order.status === 'broadcasted' && order.txId) {
            return { txId: order.txId, txSize: order.txSize, minerFee: order.minerFee, raw: order.raw };
          }
          const sponsorError = error as SponsorClientError;
          sponsorError.data = { transportError: sponsorError.data, order: order.raw };
        } catch {
          // Preserve the original commit failure when status recovery is unavailable.
        }
        throw error;
      }
    },
    getSponsorOrder,
  };
}

// ---------------------------------------------------------------------------
// Message signing (challenge + commit proof)
// ---------------------------------------------------------------------------

export async function signMvcAddressMessage(input: {
  mnemonic: string;
  path: string;
  message: string;
}): Promise<{ signature: string; publicKey: string }> {
  const addressIndex = parseAddressIndexFromPath(input.path);
  const wallet = new BtcWallet({
    coinType: CoinType.MVC,
    addressType: AddressType.SameAsMvc,
    addressIndex,
    network: NET as never,
    mnemonic: input.mnemonic,
  });
  return {
    signature: wallet.signMessage(input.message, 'base64'),
    publicKey: wallet.getPublicKey().toString('hex'),
  };
}

// ---------------------------------------------------------------------------
// UTXO fetch (Metalet wallet-api, same source as createPinWorker)
// ---------------------------------------------------------------------------

async function fetchJsonWithRetry<T>(
  url: string,
  options: { init?: RequestInit } = {},
): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, options.init);
      const json = (await response.json()) as T;
      return json;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await delay(750);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function fetchMvcAddressUtxos(address: string): Promise<SponsorMvcUtxo[]> {
  const all: SponsorMvcUtxo[] = [];
  let flag: string | undefined;
  while (true) {
    const params = new URLSearchParams({ address, net: NET, ...(flag ? { flag } : {}) });
    const json = await fetchJsonWithRetry<{
      data?: { list?: Array<{ txid: string; outIndex: number; value: number; height: number; flag?: string }> };
    }>(`${METALET_HOST}/wallet-api/v4/mvc/address/utxo-list?${params}`);
    const list = json?.data?.list ?? [];
    if (!list.length) break;
    all.push(
      ...list
        .filter((u) => u.value >= MIN_MVC_UTXO_SATS)
        .map((u) => ({
          txId: String(u.txid).trim().toLowerCase(),
          outputIndex: Number(u.outIndex),
          satoshis: Number(u.value),
          address,
          height: Number(u.height),
        })),
    );
    flag = list[list.length - 1]?.flag;
    if (!flag) break;
  }
  return all;
}

// ---------------------------------------------------------------------------
// Size/fee estimation + user-input signing
// ---------------------------------------------------------------------------

export function getOpReturnScriptSize(parts: Array<string | Buffer>): number {
  let size = 1;
  for (const part of parts) {
    const length = Buffer.isBuffer(part) ? part.length : Buffer.byteLength(part, 'utf8');
    if (length < 76) size += 1 + length;
    else if (length <= 0xff) size += 2 + length;
    else if (length <= 0xffff) size += 3 + length;
    else size += 5 + length;
  }
  return size;
}

export function getEstimatedBaseTxSize(opReturnScriptSize: number): number {
  return 4 + 1 + 1 + 43 + (9 + opReturnScriptSize) + 4;
}

export function pickUtxos(
  utxos: SponsorMvcUtxo[],
  totalOutput: number,
  feeRate: number,
  estimatedTxSizeWithoutInputs: number,
): SponsorMvcUtxo[] {
  const confirmed = utxos.filter((utxo) => utxo.height > 0).sort(() => Math.random() - 0.5);
  const unconfirmed = utxos.filter((utxo) => utxo.height <= 0).sort(() => Math.random() - 0.5);
  const ordered = [...confirmed, ...unconfirmed];
  let current = 0;
  const picked: SponsorMvcUtxo[] = [];
  for (const utxo of ordered) {
    current += utxo.satoshis;
    picked.push(utxo);
    const estimatedTxSize = estimatedTxSizeWithoutInputs + picked.length * P2PKH_INPUT_SIZE;
    const requiredAmount = totalOutput + Math.ceil(estimatedTxSize * feeRate);
    if (current >= requiredAmount) return picked;
  }
  throw new Error('MetaBot balance is insufficient for this chain write.');
}

export function estimateDraftMinerFee(input: { unsignedTxHex: string; userInputTotal: number }): number {
  const tx = new mvc.Transaction(input.unsignedTxHex);
  const outputTotal = tx.outputs.reduce((sum: number, output: { satoshis?: number }) => sum + Number(output.satoshis || 0), 0);
  return Math.max(0, input.userInputTotal - outputTotal);
}

export async function signMvcPreparedUserInputs(input: {
  mnemonic: string;
  walletPath: string;
  mvcAddress: string;
  preparedTxHex: string;
  userInputs: SponsorMvcUtxo[];
  userInputIndexes: number[];
}): Promise<{ txHex: string }> {
  const addressIndex = parseAddressIndexFromPath(input.walletPath);
  const network = mvc.Networks.livenet;
  const mnemonicObject = mvc.Mnemonic.fromString(input.mnemonic);
  const hdPrivateKey = mnemonicObject.toHDPrivateKey('', network as never);
  const childPrivateKey = hdPrivateKey.deriveChild(`m/44'/10001'/0'/0/${addressIndex}`);
  const privateKey = childPrivateKey.privateKey;

  const txComposer = new TxComposer(new mvc.Transaction(input.preparedTxHex));
  for (const [userInputOffset, inputIndex] of input.userInputIndexes.entries()) {
    const utxo = input.userInputs[userInputOffset];
    if (!utxo) {
      throw new Error(`Missing user-owned MVC UTXO descriptor for prepared input index ${inputIndex}.`);
    }
    txComposer.tx.inputs[inputIndex].output = new mvc.Transaction.Output({
      script: mvc.Script.buildPublicKeyHashOut(new mvc.Address(utxo.address, mvc.Networks.livenet as never)),
      satoshis: utxo.satoshis,
    });
    txComposer.unlockP2PKHInput(privateKey as never, inputIndex);
  }
  return { txHex: txComposer.getRawHex() };
}
