/**
 * Address Balance Service
 * Fetches balance for MVC, BTC, or DOGE addresses via Metalet public API.
 * For use by other features or Skills.
 */

import { fetchBtcBalance } from '../libs/btcApi';
import { freshGetUrlAndInit } from './freshFetch';

const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';
const SATOSHI_PER_UNIT = 100_000_000; // 1 unit = 10^8 satoshis
const DEFAULT_BALANCE_FETCH_TIMEOUT_MS = 3_000;

export type BalanceChain = 'mvc' | 'btc' | 'doge';

export interface AddressBalanceResult {
  chain: BalanceChain;
  address: string;
  /** Confirmed satoshis only. */
  satoshis: number;
  /**
   * Mempool (0-conf) satoshis. On MVC these funds are spendable right away —
   * the gas-subsidy payouts to fresh bot wallets land and stay unconfirmed,
   * so spend-availability checks must use satoshis + unconfirmedSatoshis.
   */
  unconfirmedSatoshis: number;
  unit: string; // 'SPACE' | 'BTC' | 'DOGE'
  value: number; // human-readable, e.g. 6.18325658 SPACE (confirmed only)
}

export interface AddressBalanceOptions {
  timeoutMs?: number;
}

interface MetaletResponse<T> {
  code: number;
  message?: string;
  data: T;
}

function satoshiToUnit(satoshis: number): number {
  return satoshis / SATOSHI_PER_UNIT;
}

async function fetchMetaletJson<T>(
  url: string,
  fallbackMessage: string,
  timeoutMs: number,
): Promise<MetaletResponse<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    const freshRequest = freshGetUrlAndInit(url, { signal: controller.signal });
    const res = await fetch(freshRequest.url, freshRequest.init);
    if (!res.ok) {
      throw new Error(`${fallbackMessage} (${res.status})`);
    }
    return (await res.json()) as MetaletResponse<T>;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${fallbackMessage}: timeout`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Get balance for an address by chain type.
 *
 * @param chain - 'mvc' | 'btc' | 'doge'
 * @param address - Blockchain address
 * @returns Balance in satoshis and human-readable unit, or throws on API error
 */
export async function getAddressBalance(
  chain: BalanceChain,
  address: string,
  options: AddressBalanceOptions = {},
): Promise<AddressBalanceResult> {
  if (!address || typeof address !== 'string') {
    throw new Error('address is required');
  }

  const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
    ? Math.floor(options.timeoutMs as number)
    : DEFAULT_BALANCE_FETCH_TIMEOUT_MS;

  switch (chain) {
    case 'mvc':
      return getMvcBalance(address, timeoutMs);
    case 'btc':
      return getBtcBalance(address, timeoutMs);
    case 'doge':
      return getDogeBalance(address, timeoutMs);
    default:
      throw new Error(`Unsupported chain: ${chain}`);
  }
}

/** MVC: confirmed satoshis in `satoshis`, mempool satoshis in `unconfirmedSatoshis` (satoshi -> SPACE) */
async function getMvcBalance(address: string, timeoutMs: number): Promise<AddressBalanceResult> {
  const url = `${METALET_HOST}/wallet-api/v4/mvc/address/balance-info?net=${NET}&address=${encodeURIComponent(address)}`;
  const json = await fetchMetaletJson<{
    address: string;
    confirmed: number;
    unconfirmed: number;
    utxoCount: number;
  }>(url, 'Failed to fetch MVC balance', timeoutMs);
  if (json.code !== 0) {
    throw new Error(json.message || 'Failed to fetch MVC balance');
  }
  const satoshis = json.data?.confirmed ?? 0;
  const unconfirmedSatoshis = json.data?.unconfirmed ?? 0;
  return {
    chain: 'mvc',
    address,
    satoshis,
    unconfirmedSatoshis,
    unit: 'SPACE',
    value: satoshiToUnit(satoshis),
  };
}

/** BTC: total (confirmed + unconfirmed) in `satoshis`, mempool-only in `unconfirmedSatoshis` */
async function getBtcBalance(address: string, timeoutMs: number): Promise<AddressBalanceResult> {
  const snapshot = await fetchBtcBalance(address, { timeoutMs: Math.min(timeoutMs, 1_500) });
  const satoshis = snapshot.totalSatoshis;
  return {
    chain: 'btc',
    address,
    satoshis,
    unconfirmedSatoshis: snapshot.unconfirmedSatoshis,
    unit: 'BTC',
    value: satoshiToUnit(satoshis),
  };
}

/** DOGE: confirmed satoshis in `satoshis`, mempool satoshis in `unconfirmedSatoshis` (satoshi -> DOGE) */
async function getDogeBalance(address: string, timeoutMs: number): Promise<AddressBalanceResult> {
  const url = `${METALET_HOST}/wallet-api/v4/doge/address/balance-info?net=${NET}&address=${encodeURIComponent(address)}`;
  const json = await fetchMetaletJson<{
    address: string;
    confirmed: number;
    unconfirmed: number;
    utxoCount: number;
  }>(url, 'Failed to fetch DOGE balance', timeoutMs);
  if (json.code !== 0) {
    throw new Error(json.message || 'Failed to fetch DOGE balance');
  }
  const satoshis = json.data?.confirmed ?? 0;
  const unconfirmedSatoshis = json.data?.unconfirmed ?? 0;
  return {
    chain: 'doge',
    address,
    satoshis,
    unconfirmedSatoshis,
    unit: 'DOGE',
    value: satoshiToUnit(satoshis),
  };
}
