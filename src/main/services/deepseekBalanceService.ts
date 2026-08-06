/**
 * DeepSeek account balance service.
 *
 * Fetches the wallet balance from DeepSeek's /user/balance endpoint so the UI
 * can show remaining quota alongside token usage. Mirrors the approach used by
 * Reasonix (internal/billing/balance.go): a single GET with Bearer auth, a
 * short timeout, and a normalized result shape.
 *
 * Endpoint docs: GET https://api.deepseek.com/user/balance
 * Response: { is_available, balance_infos: [{ currency, total_balance,
 *            granted_balance, topped_up_balance }] }
 */

import { net } from 'electron';
import { getDeepSeekProviderConfig } from '../libs/claudeSettings';

/** Single currency balance entry as returned by DeepSeek. */
export interface DeepSeekBalanceInfo {
  currency: string;
  totalBalance: number;
  grantedBalance: number;
  toppedUpBalance: number;
}

/** Normalized balance result. `available` mirrors DeepSeek's is_available flag. */
export interface DeepSeekBalanceResult {
  available: boolean;
  infos: DeepSeekBalanceInfo[];
  /** Best-effort display string (CNY-first, then first entry), e.g. "¥110.00". */
  display: string;
}

export type DeepSeekBalanceResponse =
  | { success: true; balance: DeepSeekBalanceResult }
  | { success: false; error: string };

/** Response shape from the DeepSeek /user/balance endpoint. */
type DeepSeekBalanceRaw = {
  is_available?: boolean;
  balance_infos?: Array<{
    currency?: string;
    total_balance?: string;
    granted_balance?: string;
    topped_up_balance?: string;
  }>;
};

const BALANCE_TIMEOUT_MS = 12_000;
const MAX_BODY_BYTES = 65_536;

function parseAmount(value: string | undefined): number {
  if (value == null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildDisplay(infos: DeepSeekBalanceInfo[]): string {
  if (infos.length === 0) return '-';
  // Prefer CNY (DeepSeek's primary billing currency), else the first entry.
  const preferred = infos.find((info) => info.currency === 'CNY') ?? infos[0];
  const symbol = preferred.currency === 'CNY' ? '¥'
    : preferred.currency === 'USD' ? '$'
    : '';
  return `${symbol}${preferred.totalBalance.toFixed(2)}`;
}

function normalizeBalance(raw: DeepSeekBalanceRaw): DeepSeekBalanceResult {
  const infos: DeepSeekBalanceInfo[] = (raw.balance_infos ?? []).map((entry) => ({
    currency: (entry.currency ?? '').trim() || 'CNY',
    totalBalance: parseAmount(entry.total_balance),
    grantedBalance: parseAmount(entry.granted_balance),
    toppedUpBalance: parseAmount(entry.topped_up_balance),
  }));
  return {
    available: raw.is_available ?? true,
    infos,
    display: buildDisplay(infos),
  };
}

/**
 * Fetch the DeepSeek account balance. Returns a discriminated union so callers
 * can distinguish "not configured" / "network error" from a successful read.
 * Uses Electron's net module so the request respects proxy/session settings.
 */
export async function fetchDeepSeekBalance(): Promise<DeepSeekBalanceResponse> {
  const providerConfig = getDeepSeekProviderConfig();
  if (!providerConfig) {
    return { success: false, error: 'DeepSeek provider is not configured.' };
  }

  // The balance endpoint lives at the host root; strip any /anthropic or /v1 suffix.
  const base = providerConfig.baseUrl.replace(/\/+$/, '').replace(/\/anthropic$/, '').replace(/\/v1$/, '');
  const url = `${base}/user/balance`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BALANCE_TIMEOUT_MS);

  try {
    const response = await net.fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${providerConfig.apiKey}`,
      },
      signal: controller.signal,
    });

    const text = await response.text();
    // Guard against unexpectedly large responses.
    if (text.length > MAX_BODY_BYTES) {
      return { success: false, error: 'Balance response exceeded size limit.' };
    }

    if (!response.ok) {
      const snippet = text.slice(0, 200);
      return { success: false, error: `DeepSeek balance request failed (${response.status}): ${snippet}` };
    }

    let raw: DeepSeekBalanceRaw;
    try {
      raw = JSON.parse(text) as DeepSeekBalanceRaw;
    } catch {
      return { success: false, error: 'DeepSeek balance response was not valid JSON.' };
    }

    return { success: true, balance: normalizeBalance(raw) };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Network error';
    return { success: false, error: message };
  } finally {
    clearTimeout(timeout);
  }
}
