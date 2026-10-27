import type { BundlePlan } from '../../bridge/types';

export interface RechargeOrderView {
  orderId: string;
  qrCode: string;
  plan: BundlePlan;
  expiresAt: number;
  status: number;
  createdAtMs: number;
}

export interface RechargeCreationAttempt {
  planId: string;
  startedAtMs: number;
  retryAfterMs: number;
}

export interface RechargeRecoveryState {
  order: RechargeOrderView | null;
  creationAttempt: RechargeCreationAttempt | null;
}

const ORDER_KEY = 'idbots.mobile.bundleOrder.v1';
const CREATE_ATTEMPT_KEY = 'idbots.mobile.bundleCreateAttempt.v1';
export const UNCERTAIN_CREATE_RETRY_MS = 24 * 60 * 60 * 1000;

export function isOrderExpired(expiresAt: number, nowMs: number = Date.now()): boolean {
  return !Number.isFinite(expiresAt) || expiresAt <= 0 || nowMs > expiresAt * 1000;
}

export function isActiveOrder(order: RechargeOrderView | null, nowMs: number = Date.now()): boolean {
  return Boolean(order && (order.status === 1 || order.status === 2) && !isOrderExpired(order.expiresAt, nowMs));
}

export function isUncertainCreateBlocked(attempt: RechargeCreationAttempt | null, nowMs: number = Date.now()): boolean {
  return Boolean(attempt && nowMs < attempt.retryAfterMs);
}

export const BUNDLE_ORDER_CREATION_REJECTED = 'BUNDLE_ORDER_REJECTED';

export function isDefinitiveCreateRejection(result: { errorCode?: string } | null | undefined): boolean {
  return result?.errorCode === BUNDLE_ORDER_CREATION_REJECTED;
}

export function isCurrentOrderOperation(
  current: RechargeOrderView | null,
  currentGeneration: number,
  expectedOrderId: string,
  expectedGeneration: number,
): boolean {
  return current?.orderId === expectedOrderId && currentGeneration === expectedGeneration;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizePlan(value: unknown): BundlePlan | null {
  if (!isRecord(value)) return null;
  const stringKeys = ['planId', 'name', 'nameEn', 'payCurrency', 'payAmount', 'llmQuotaUnit', 'remark'] as const;
  const numberKeys = ['trafficBytes', 'llmQuota', 'status', 'sort'] as const;
  if (stringKeys.some((key) => typeof value[key] !== 'string')) return null;
  if (numberKeys.some((key) => typeof value[key] !== 'number' || !Number.isFinite(value[key]))) return null;
  return value as unknown as BundlePlan;
}

function normalizeOrder(value: unknown): RechargeOrderView | null {
  if (!isRecord(value)) return null;
  if (typeof value.orderId !== 'string' || !value.orderId.trim()) return null;
  if (typeof value.qrCode !== 'string') return null;
  if (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || value.expiresAt <= 0) return null;
  if (typeof value.createdAtMs !== 'number' || !Number.isFinite(value.createdAtMs) || value.createdAtMs <= 0) return null;
  if (![1, 2, 3, 4].includes(Number(value.status))) return null;
  const plan = normalizePlan(value.plan);
  if (!plan) return null;
  return {
    orderId: value.orderId,
    qrCode: value.qrCode,
    plan,
    expiresAt: value.expiresAt,
    status: Number(value.status),
    createdAtMs: value.createdAtMs,
  };
}

function normalizeAttempt(value: unknown): RechargeCreationAttempt | null {
  if (!isRecord(value)) return null;
  if (typeof value.planId !== 'string' || !value.planId.trim()) return null;
  if (typeof value.startedAtMs !== 'number' || !Number.isFinite(value.startedAtMs) || value.startedAtMs <= 0) return null;
  if (typeof value.retryAfterMs !== 'number' || !Number.isFinite(value.retryAfterMs)) return null;
  return { planId: value.planId, startedAtMs: value.startedAtMs, retryAfterMs: value.retryAfterMs };
}

function readJson(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.warn(`[mobile-recharge] could not read ${key}`, error);
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn(`[mobile-recharge] could not persist ${key}`, error);
  }
}

export function loadRechargeRecovery(): RechargeRecoveryState {
  return {
    order: normalizeOrder(readJson(ORDER_KEY)),
    creationAttempt: normalizeAttempt(readJson(CREATE_ATTEMPT_KEY)),
  };
}

export function persistRechargeOrder(order: RechargeOrderView): void {
  writeJson(ORDER_KEY, order);
}

export function persistCreationAttempt(attempt: RechargeCreationAttempt | null): void {
  try {
    if (attempt) window.localStorage.setItem(CREATE_ATTEMPT_KEY, JSON.stringify(attempt));
    else window.localStorage.removeItem(CREATE_ATTEMPT_KEY);
  } catch (error) {
    console.warn('[mobile-recharge] could not update creation attempt', error);
  }
}

export function makeCreationAttempt(planId: string, nowMs: number = Date.now()): RechargeCreationAttempt {
  return {
    planId,
    startedAtMs: nowMs,
    retryAfterMs: nowMs + UNCERTAIN_CREATE_RETRY_MS,
  };
}
