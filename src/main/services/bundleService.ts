/**
 * Metaso bundle service (REQ-A-24, C4 "Metaso bundle API").
 *
 * Client for the C4 bundle endpoints: plan catalog, bundle orders (Alipay QR
 * flow), and the combined meters read the mobile UI shows on its recharge
 * screen. Follows the traffic API conventions exactly — envelope
 * `{ code: 0, message, data }`, identity headers X-Identity-Address /
 * X-Timestamp (unix seconds, ±300s) / X-Signature (BTC signed message,
 * base64, key m/44'/10001'/0'/0/0) — and resolves the Metaso base URL the
 * same way trafficAccountService does, with the C1 `IDBOTS_METASO_API_BASE`
 * environment override taking precedence (server-mode tenants set it; the
 * kvStore traffic.apiBase setting remains the desktop override).
 *
 * Local stub (development without the WS-D backend): enabled by
 * `IDBOTS_BUNDLE_STUB=1` or an apiBase of `stub://local`. Serves two fixed
 * plans, mints fake Alipay QR orders, credits an order on its first status
 * poll, and keeps the LLM meter in memory.
 *
 * `getMeters` is the only meter aggregation and it never exposes an API key:
 * the traffic side returns the public account record and the LLM side is a
 * field-by-field rebuild of the C4 quota shape (no apiKey/keyPrefix/baseUrl
 * passthrough).
 *
 * Electron-free (store/identity/fetch are injected) so plain node:test
 * coverage works, mirroring trafficAccountService/llmRelayService.
 */

import { randomBytes } from 'node:crypto';
import { signMvcAddressMessage } from './mvcSponsorClient';
import { getConfiguredTrafficApiBase, getTrafficBalance, type TrafficAccountRecord } from './trafficAccountService';
import { TRAFFIC_API_BASE_KEY } from './trafficSettings';
import type { SqliteStore } from '../sqliteStore';
import type { UserIdentityStore } from '../userIdentityStore';

const DEFAULT_METASO_API_BASE_URL = 'https://www.metaso.network/assist-open-api';
const DEFAULT_WALLET_PATH = "m/44'/10001'/0'/0/0";
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;

/** C4 order lifecycle, same codes as traffic recharge orders. */
export const BUNDLE_ORDER_STATUS = {
  CREATED: 1,
  PAID: 2,
  CREDITED: 3,
  CLOSED: 4,
} as const;

// ---------------------------------------------------------------------------
// Types + typed error
// ---------------------------------------------------------------------------

export type BundleApiStage = 'plans' | 'orders' | 'order' | 'quota';

export class BundleApiError extends Error {
  readonly code: string;
  readonly stage: BundleApiStage;
  readonly status?: number;
  readonly serviceMessage: string;

  constructor(input: { stage: BundleApiStage; message: string; status?: number }) {
    super(input.message);
    this.name = 'BundleApiError';
    this.code = `bundle_${input.stage}_failed`;
    this.stage = input.stage;
    if (input.status !== undefined) this.status = input.status;
    this.serviceMessage = input.message;
  }
}

export const BUNDLE_ORDER_CREATION_REJECTED = 'BUNDLE_ORDER_REJECTED';
export const BUNDLE_ORDER_OUTCOME_UNCERTAIN = 'BUNDLE_ORDER_OUTCOME_UNCERTAIN';

export class BundleOrderCreationRejectedError extends BundleApiError {
  constructor(message: string) {
    super({ stage: 'orders', message });
    this.name = 'BundleOrderCreationRejectedError';
  }
}

/** C4 plan row; `payAmount` is a decimal string (C4: "Amounts are decimal strings"). */
export interface BundlePlan {
  planId: string;
  name: string;
  nameEn: string;
  payCurrency: string;
  payAmount: string;
  trafficBytes: number;
  llmQuota: number;
  llmQuotaUnit: string;
  status: number;
  sort: number;
  remark: string;
}

/** C4 create-order response. */
export interface BundleOrder {
  orderId: string;
  planId: string;
  payAmount: string;
  payCurrency: string;
  trafficBytes: number;
  llmQuota: number;
  gatewayParams: { qrCode?: string; alipayOutTradeNo?: string } & Record<string, unknown>;
  expiresAt: number;
}

/** C4 order-status response (same shape as the traffic recharge status). */
export interface BundleOrderStatus {
  orderId: string;
  planId: string;
  status: number;
  payAmount: string;
  payCurrency: string;
  trafficBytes: number;
  llmQuota: number;
  paidAt?: number;
  creditedAt?: number;
}

/**
 * C4 identity-bound quota shape (`GET /v2/assist/llm/quota`). Rebuilt
 * field-by-field from the backend payload so no relay credential field can
 * leak through.
 */
export interface BundleLlmQuota {
  quotaTotal: number;
  quotaUsed: number;
  quotaRemaining: number;
  quotaFree: number;
  quotaPurchased: number;
  unit: string;
}

export interface BundleMeters {
  /** Public traffic account record, or null when unavailable/offline. */
  traffic: TrafficAccountRecord | null;
  llm: BundleLlmQuota;
}

// ---------------------------------------------------------------------------
// Module state + init
// ---------------------------------------------------------------------------

export interface BundleServiceDeps {
  getStore: () => SqliteStore | null;
  getUserIdentityStore: () => UserIdentityStore;
  fetchImpl?: typeof fetch;
  /** Overrides every other base-URL source (mainly tests). */
  baseUrl?: string;
  /** Test seam for the traffic half of getMeters. */
  getTrafficBalanceImpl?: (options?: { forceRefresh?: boolean }) => Promise<TrafficAccountRecord>;
}

let depsRef: BundleServiceDeps | null = null;

export function initBundleService(deps: BundleServiceDeps): void {
  depsRef = deps;
}

export function resetBundleServiceForTests(): void {
  depsRef = null;
  stubState.orders.clear();
  stubState.quota = { ...STUB_INITIAL_QUOTA };
}

function getDeps(): BundleServiceDeps {
  if (!depsRef) {
    throw new BundleApiError({ stage: 'plans', message: 'bundle service not initialized' });
  }
  return depsRef;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickText(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = normalizeText(record[key]);
    if (value) return value;
  }
  return '';
}

function toNumber(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/**
 * The raw (unvalidated) traffic.apiBase kv value, or ''. Unlike
 * readTrafficApiBase this keeps non-http(s) values such as `stub://local`,
 * which the bundle service treats as the local-stub signal.
 */
function readRawTrafficApiBase(): string {
  try {
    return normalizeText(depsRef?.getStore()?.get(TRAFFIC_API_BASE_KEY));
  } catch {
    return '';
  }
}

/**
 * Metaso assist-open-api base URL. Precedence: the C1 `IDBOTS_METASO_API_BASE`
 * environment override (server mode), the injected test override, the kvStore
 * traffic.apiBase setting (desktop override; may be `stub://local`), then the
 * production default.
 */
export function resolveBundleApiBaseUrl(): string {
  const envBase = normalizeText(process.env.IDBOTS_METASO_API_BASE);
  if (envBase) return envBase.replace(/\/+$/, '');
  if (depsRef?.baseUrl && normalizeText(depsRef.baseUrl)) {
    return normalizeText(depsRef.baseUrl).replace(/\/+$/, '');
  }
  const rawConfigured = readRawTrafficApiBase();
  if (rawConfigured) return rawConfigured;
  const configured = getConfiguredTrafficApiBase();
  if (configured) return configured;
  return DEFAULT_METASO_API_BASE_URL;
}

/** Local-stub mode: explicit env flag or a `stub://local` base URL. */
export function isBundleStubMode(): boolean {
  if (normalizeText(process.env.IDBOTS_BUNDLE_STUB) === '1') return true;
  return resolveBundleApiBaseUrl() === 'stub://local';
}

// Canonical request strings (C4 "New: Bundle Orders"; same pattern as
// traffic-recharge:<accountId>:<planId>:<timestamp>).
function buildBundleOrderMessage(accountId: string, planId: string, timestamp: number): string {
  return `bundle-order:${accountId}:${planId}:${timestamp}`;
}

// Identity-signed LLM quota read. C4 documents identity-header signing for the
// sibling ledger endpoint (`llm-relay-ledger:<identityAddress>:<timestamp>`)
// and leaves the quota endpoint's identity message unstated; this follows the
// same llm-relay-<purpose> convention — confirm against the WS-D deployment
// before pointing real tenants at a backend that enforces it.
function buildLlmRelayQuotaMessage(identityAddress: string, timestamp: number): string {
  return `llm-relay-quota:${identityAddress}:${timestamp}`;
}

// ---------------------------------------------------------------------------
// Identity + signing (same machinery as trafficAccountService)
// ---------------------------------------------------------------------------

function requireIdentity(): { mnemonic: string; path: string; mvcAddress: string; globalMetaId: string } {
  const identity = getDeps().getUserIdentityStore().get();
  if (!identity) {
    throw new BundleApiError({ stage: 'orders', message: 'local user identity is missing' });
  }
  const globalMetaId = normalizeText(identity.globalmetaid);
  const mvcAddress = normalizeText(identity.mvc_address);
  if (!identity.mnemonic?.trim() || !globalMetaId || !mvcAddress) {
    throw new BundleApiError({
      stage: 'orders',
      message: 'local user identity is incomplete (mnemonic/mvc address/globalmetaid required)',
    });
  }
  return {
    mnemonic: identity.mnemonic.trim(),
    path: identity.path || DEFAULT_WALLET_PATH,
    mvcAddress,
    globalMetaId,
  };
}

// ---------------------------------------------------------------------------
// HTTP layer (same {code, message, data} envelope as the traffic API)
// ---------------------------------------------------------------------------

async function bundleRequestJson(input: {
  stage: BundleApiStage;
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
  identity?: { address: string; timestamp: number; signature: string };
}): Promise<Record<string, unknown> | unknown[]> {
  const deps = getDeps();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `${resolveBundleApiBaseUrl()}${input.path}`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (input.body) {
    headers['content-type'] = 'application/json';
  }
  if (input.identity) {
    headers['X-Identity-Address'] = input.identity.address;
    headers['X-Timestamp'] = String(input.identity.timestamp);
    headers['X-Signature'] = input.identity.signature;
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: input.method,
      headers,
      body: input.body ? JSON.stringify(input.body) : undefined,
      signal: controller.signal,
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new BundleApiError({
        stage: input.stage,
        message: `Bundle service returned invalid JSON (HTTP ${response.status}).`,
        status: response.status,
      });
    }
    if (!response.ok) {
      const bodyRecord = readObject(body);
      const errorRecord = readObject(bodyRecord?.error);
      throw new BundleApiError({
        stage: input.stage,
        message: pickText(errorRecord ?? bodyRecord ?? {}, 'message', 'msg', 'error')
          || `Bundle service request failed with HTTP ${response.status}.`,
        status: response.status,
      });
    }
    const record = readObject(body);
    if (!record) {
      throw new BundleApiError({ stage: input.stage, message: 'Bundle service returned a non-object response.' });
    }
    const code = Number(record.code);
    if (Number.isFinite(code) && code === 0) {
      if (Array.isArray(record.data)) return record.data;
      const data = readObject(record.data);
      if (!data) {
        throw new BundleApiError({ stage: input.stage, message: 'Bundle service returned an empty data payload.' });
      }
      return data;
    }
    throw new BundleApiError({
      stage: input.stage,
      message: pickText(record, 'message', 'msg', 'error')
        || `Bundle service returned code ${normalizeText(record.code) || 'unknown'}.`,
    });
  } catch (error) {
    if (error instanceof BundleApiError) throw error;
    if (controller.signal.aborted) {
      throw new BundleApiError({
        stage: input.stage,
        message: `Bundle service request timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms.`,
      });
    }
    throw new BundleApiError({
      stage: input.stage,
      message: error instanceof Error && error.message ? error.message : 'Bundle service request failed.',
    });
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// ---------------------------------------------------------------------------
// Payload normalization (field-by-field; never a credential passthrough)
// ---------------------------------------------------------------------------

function normalizeBundlePlan(data: Record<string, unknown>): BundlePlan {
  return {
    planId: pickText(data, 'planId', 'plan_id'),
    name: pickText(data, 'name'),
    nameEn: pickText(data, 'nameEn', 'name_en'),
    payCurrency: pickText(data, 'payCurrency', 'pay_currency'),
    payAmount: pickText(data, 'payAmount', 'pay_amount'),
    trafficBytes: toNumber(data.trafficBytes ?? data.traffic_bytes),
    llmQuota: toNumber(data.llmQuota ?? data.llm_quota),
    llmQuotaUnit: pickText(data, 'llmQuotaUnit', 'llm_quota_unit') || 'tokens',
    status: toNumber(data.status),
    sort: toNumber(data.sort),
    remark: pickText(data, 'remark'),
  };
}

function normalizeBundleOrder(data: Record<string, unknown>): BundleOrder {
  const orderId = pickText(data, 'orderId', 'order_id');
  if (!orderId) {
    throw new BundleApiError({ stage: 'orders', message: 'Bundle order response is missing orderId.' });
  }
  const gatewayParams = readObject(data.gatewayParams ?? data.gateway_params) ?? {};
  return {
    orderId,
    planId: pickText(data, 'planId', 'plan_id'),
    payAmount: pickText(data, 'payAmount', 'pay_amount'),
    payCurrency: pickText(data, 'payCurrency', 'pay_currency'),
    trafficBytes: toNumber(data.trafficBytes ?? data.traffic_bytes),
    llmQuota: toNumber(data.llmQuota ?? data.llm_quota),
    gatewayParams,
    expiresAt: toNumber(data.expiresAt ?? data.expires_at),
  };
}

function normalizeBundleOrderStatus(data: Record<string, unknown>): BundleOrderStatus {
  const orderId = pickText(data, 'orderId', 'order_id');
  if (!orderId) {
    throw new BundleApiError({ stage: 'order', message: 'Bundle order status response is missing orderId.' });
  }
  const status: BundleOrderStatus = {
    orderId,
    planId: pickText(data, 'planId', 'plan_id'),
    status: toNumber(data.status),
    payAmount: pickText(data, 'payAmount', 'pay_amount'),
    payCurrency: pickText(data, 'payCurrency', 'pay_currency'),
    trafficBytes: toNumber(data.trafficBytes ?? data.traffic_bytes),
    llmQuota: toNumber(data.llmQuota ?? data.llm_quota),
  };
  const paidAt = toNumber(data.paidAt ?? data.paid_at);
  const creditedAt = toNumber(data.creditedAt ?? data.credited_at);
  if (paidAt > 0) status.paidAt = paidAt;
  if (creditedAt > 0) status.creditedAt = creditedAt;
  return status;
}

/**
 * Rebuild the C4 quota shape field-by-field. Explicitly NOT a passthrough: a
 * relay apiKey/keyPrefix/baseUrl in the payload can never reach the caller.
 */
function normalizeBundleLlmQuota(data: Record<string, unknown>): BundleLlmQuota {
  return {
    quotaTotal: toNumber(data.quotaTotal ?? data.quota_total),
    quotaUsed: toNumber(data.quotaUsed ?? data.quota_used),
    quotaRemaining: toNumber(data.quotaRemaining ?? data.quota_remaining),
    quotaFree: toNumber(data.quotaFree ?? data.quota_free),
    quotaPurchased: toNumber(data.quotaPurchased ?? data.quota_purchased),
    unit: pickText(data, 'unit') || 'tokens',
  };
}

// ---------------------------------------------------------------------------
// Local stub (IDBOTS_BUNDLE_STUB=1 or stub://local)
// ---------------------------------------------------------------------------

interface StubOrder extends BundleOrderStatus {
  polls: number;
}

const STUB_INITIAL_QUOTA: BundleLlmQuota = {
  quotaTotal: 100_000,
  quotaUsed: 0,
  quotaRemaining: 100_000,
  quotaFree: 100_000,
  quotaPurchased: 0,
  unit: 'tokens',
};

const stubState: { orders: Map<string, StubOrder>; quota: BundleLlmQuota } = {
  orders: new Map(),
  quota: { ...STUB_INITIAL_QUOTA },
};

// The basic plan mirrors the C4 example exactly; the test plan is a minimal
// ¥0.01 fixture for the payment flow (sizes chosen for the stub, not the
// contract — C4 pins only bundle_basic_cny's fields).
const STUB_PLANS: BundlePlan[] = [
  {
    planId: 'bundle_test_cny',
    name: '测试包',
    nameEn: 'Test',
    payCurrency: 'CNY',
    payAmount: '0.01',
    trafficBytes: 1_048_576,
    llmQuota: 100_000,
    llmQuotaUnit: 'tokens',
    status: 1,
    sort: 1,
    remark: 'local stub',
  },
  {
    planId: 'bundle_basic_cny',
    name: '基础包',
    nameEn: 'Basic',
    payCurrency: 'CNY',
    payAmount: '19.90',
    trafficBytes: 104_857_600,
    llmQuota: 2_000_000,
    llmQuotaUnit: 'tokens',
    status: 1,
    sort: 10,
    remark: '',
  },
];

function syncStubQuotaDerived(): void {
  stubState.quota.quotaTotal = stubState.quota.quotaFree + stubState.quota.quotaPurchased;
  stubState.quota.quotaRemaining = Math.max(0, stubState.quota.quotaTotal - stubState.quota.quotaUsed);
}

function stubCreateOrder(planId: string): BundleOrder {
  const plan = STUB_PLANS.find((entry) => entry.planId === planId && entry.status === 1);
  if (!plan) {
    throw new BundleOrderCreationRejectedError(`Unknown or off-sale bundle plan: ${planId || '(empty)'}`);
  }
  const orderId = `bo_stub_${randomBytes(8).toString('hex')}`;
  const now = nowSeconds();
  stubState.orders.set(orderId, {
    orderId,
    planId: plan.planId,
    status: BUNDLE_ORDER_STATUS.CREATED,
    payAmount: plan.payAmount,
    payCurrency: plan.payCurrency,
    trafficBytes: plan.trafficBytes,
    llmQuota: plan.llmQuota,
    polls: 0,
  });
  return {
    orderId,
    planId: plan.planId,
    payAmount: plan.payAmount,
    payCurrency: plan.payCurrency,
    trafficBytes: plan.trafficBytes,
    llmQuota: plan.llmQuota,
    // Fake QR: nothing behind the URL, the first status poll credits the order.
    gatewayParams: {
      qrCode: `https://qr.alipay.com/stub-${orderId}`,
      alipayOutTradeNo: `stub-${orderId}`,
    },
    expiresAt: now + 900,
  };
}

function stubGetOrder(orderId: string): BundleOrderStatus {
  const order = stubState.orders.get(orderId);
  if (!order) {
    throw new BundleApiError({ stage: 'order', message: `Unknown bundle order: ${orderId || '(empty)'}` });
  }
  order.polls += 1;
  // Stub payment confirms on the first poll: flip created → credited and add
  // the plan's LLM quota to the stub pool, so getMeters reflects "purchases".
  if (order.status === BUNDLE_ORDER_STATUS.CREATED) {
    const now = nowSeconds();
    order.status = BUNDLE_ORDER_STATUS.CREDITED;
    order.paidAt = now;
    order.creditedAt = now;
    stubState.quota.quotaPurchased += order.llmQuota;
    syncStubQuotaDerived();
  }
  const { polls: _polls, ...status } = order;
  return { ...status };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** C4 plan catalog (`GET /v1/bundle/plans`, no signature). */
export async function getBundlePlans(): Promise<BundlePlan[]> {
  if (isBundleStubMode()) {
    return STUB_PLANS.map((plan) => ({ ...plan }));
  }
  const data = await bundleRequestJson({ stage: 'plans', method: 'GET', path: '/v1/bundle/plans' });
  const rows = Array.isArray(data) ? data : [];
  return rows.flatMap((item) => {
    const row = readObject(item);
    return row ? [normalizeBundlePlan(row)] : [];
  });
}

/**
 * Create a bundle order for the local identity's traffic account (C4
 * `POST /v1/bundle/orders`, signed `bundle-order:<accountId>:<planId>:<ts>`).
 * The gateway defaults to Alipay: every C4 plan is CNY, and `mock` exists only
 * on backends with mock_payment_enabled (the local stub covers dev).
 */
export async function createBundleOrder(input: { planId?: unknown; gateway?: unknown }): Promise<BundleOrder> {
  const planId = normalizeText(input?.planId);
  if (!planId) {
    throw new BundleOrderCreationRejectedError('planId is required');
  }
  const gateway = normalizeText(input?.gateway) || 'alipay';
  if (isBundleStubMode()) {
    return stubCreateOrder(planId);
  }
  const identity = requireIdentity();
  // The account id is the identity's GlobalMetaID, same convention the
  // traffic recharge flow signs with (the backend resolves the account from
  // the identity headers and treats the body accountId as that same id).
  const timestamp = nowSeconds();
  const message = buildBundleOrderMessage(identity.globalMetaId, planId, timestamp);
  const { signature } = await signMvcAddressMessage({
    mnemonic: identity.mnemonic,
    path: identity.path,
    message,
  });
  const data = await bundleRequestJson({
    stage: 'orders',
    method: 'POST',
    path: '/v1/bundle/orders',
    body: { planId, gateway },
    identity: { address: identity.mvcAddress, timestamp, signature },
  });
  return normalizeBundleOrder(data as Record<string, unknown>);
}

/** Poll one bundle order (C4 `GET /v1/bundle/orders/{orderId}`, no signature). */
export async function getBundleOrder(input: { orderId?: unknown }): Promise<BundleOrderStatus> {
  const orderId = normalizeText(input?.orderId);
  if (!orderId) {
    throw new BundleApiError({ stage: 'order', message: 'orderId is required' });
  }
  if (isBundleStubMode()) {
    return stubGetOrder(orderId);
  }
  const data = await bundleRequestJson({
    stage: 'order',
    method: 'GET',
    path: `/v1/bundle/orders/${encodeURIComponent(orderId)}`,
  });
  return normalizeBundleOrderStatus(data as Record<string, unknown>);
}

/**
 * Combined meters for the mobile recharge screen: the public traffic account
 * record (null when the traffic service is unavailable) plus the identity's
 * C4 LLM quota. Both halves bypass cached snapshots so a credited order is
 * visible immediately. The traffic half degrades to null instead of failing
 * the whole read; the LLM half is stubbed in stub mode.
 */
export async function getBundleMeters(): Promise<BundleMeters> {
  const deps = getDeps();
  let traffic: TrafficAccountRecord | null = null;
  try {
    const readTraffic = deps.getTrafficBalanceImpl ?? getTrafficBalance;
    traffic = await readTraffic({ forceRefresh: true });
  } catch {
    traffic = null;
  }

  let llm: BundleLlmQuota;
  if (isBundleStubMode()) {
    syncStubQuotaDerived();
    llm = { ...stubState.quota };
  } else {
    const identity = requireIdentity();
    const timestamp = nowSeconds();
    const message = buildLlmRelayQuotaMessage(identity.mvcAddress, timestamp);
    const { signature } = await signMvcAddressMessage({
      mnemonic: identity.mnemonic,
      path: identity.path,
      message,
    });
    const data = await bundleRequestJson({
      stage: 'quota',
      method: 'GET',
      path: '/v2/assist/llm/quota',
      identity: { address: identity.mvcAddress, timestamp, signature },
    });
    llm = normalizeBundleLlmQuota(data as Record<string, unknown>);
  }
  return { traffic, llm };
}

// ---------------------------------------------------------------------------
// IPC surface
// ---------------------------------------------------------------------------

type RegisterIpcHandlerFn = (channel: string, handler: (event: any, ...args: any[]) => any) => void;

export function registerBundleIpcHandlers(deps: { registerIpcHandler: RegisterIpcHandlerFn }): void {
  const { registerIpcHandler } = deps;
  registerIpcHandler('bundle:getPlans', async () => {
    try {
      return { success: true, plans: await getBundlePlans() };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });
  registerIpcHandler('bundle:createOrder', async (_event, input: { planId?: unknown; gateway?: unknown }) => {
    try {
      return { success: true, order: await createBundleOrder(input ?? {}) };
    } catch (error) {
      return {
        success: false,
        error: getErrorMessage(error),
        errorCode: error instanceof BundleOrderCreationRejectedError
          ? BUNDLE_ORDER_CREATION_REJECTED
          : BUNDLE_ORDER_OUTCOME_UNCERTAIN,
      };
    }
  });
  registerIpcHandler('bundle:getOrder', async (_event, input: { orderId?: unknown }) => {
    try {
      return { success: true, order: await getBundleOrder(input ?? {}) };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });
  registerIpcHandler('bundle:getMeters', async () => {
    try {
      return { success: true, meters: await getBundleMeters() };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });
}
