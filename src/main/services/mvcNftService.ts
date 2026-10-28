import type { MetabotStore } from '../metabotStore';
import { buildMvcNftTransferRawTx } from './walletRawTxService';
import { isRetryableMvcBroadcastError, resolveBroadcastTxResult } from '../libs/mvcSpend';
import { freshGetUrlAndInit } from './freshFetch';

const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';
const RETRYABLE_MVC_NFT_BUILD_ATTEMPTS = 3;
const RETRYABLE_MVC_NFT_BROADCAST_DELAY_MS = 750;

export interface MvcNftItem {
  tokenIndex: string;
  name: string;
  satoshi: number;
  txId: string;
  outputIndex: number;
  height: number;
  icon?: string;
  metaTxId?: string;
}

export interface MvcNftCollection {
  genesis: string;
  codeHash: string;
  sensibleId?: string;
  seriesName: string;
  tokenSupply?: number;
  count: number;
  items: MvcNftItem[];
}

export interface MvcNftBalance {
  address: string;
  count: number;
  collections: MvcNftCollection[];
}

interface RawMvcNftSummaryRow {
  codeHash?: string;
  genesis?: string;
  sensibleId?: string;
  tokenSupply?: number | string;
  count?: number | string;
  seriesName?: string;
}

interface RawMvcNftUtxoRow {
  address?: string;
  txId?: string;
  txIndex?: number | string;
  codeHash?: string;
  genesis?: string;
  sensibleId?: string;
  height?: number | string;
  metaTxId?: string;
  tokenSupply?: number | string;
  tokenIndex?: number | string;
  satoshi?: number | string;
  satoshiString?: string;
  flag?: string;
  name?: string;
  icon?: string;
  seriesName?: string;
}

interface MvcNftServiceDeps {
  fetchCount: (address: string) => Promise<number>;
  fetchSummaryList: (address: string) => Promise<RawMvcNftSummaryRow[]>;
  fetchUtxoList: (address: string) => Promise<RawMvcNftUtxoRow[]>;
  buildRawTx: typeof buildMvcNftTransferRawTx;
  broadcastTx: (rawTx: string) => Promise<string>;
}

function normalizeCount(value: unknown): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) return 0;
  return count;
}

function normalizeTokenIndex(value: unknown): string {
  const text = String(value ?? '').trim();
  return /^\d+$/.test(text) ? text : '';
}

function normalizeOutpointIndex(value: unknown): number {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0) return 0;
  return index;
}

function normalizeHeight(value: unknown): number {
  const height = Number(value);
  if (!Number.isInteger(height) || height < 0) return 0;
  return height;
}

function normalizeSatoshi(value: unknown): number {
  const satoshis = Number(value);
  if (!Number.isFinite(satoshis) || satoshis < 0) return 0;
  return Math.round(satoshis);
}

function normalizeIcon(value: unknown): string | undefined {
  const icon = String(value ?? '').trim();
  return icon || undefined;
}

async function fetchJson<T>(url: string): Promise<T> {
  const freshRequest = freshGetUrlAndInit(url);
  const response = await fetch(freshRequest.url, freshRequest.init);
  const json = await response.json() as { code?: number; message?: string; data?: T };
  if (json.code !== 0 && json.code !== undefined) {
    throw new Error(json.message || 'API request failed');
  }
  return (json.data ?? json) as T;
}

function getErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof (error as Error).message === 'string') {
    return (error as Error).message;
  }
  return String(error ?? '');
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const defaultDeps: MvcNftServiceDeps = {
  fetchCount: async (address) => {
    const response = await fetchJson<{ count?: number | string }>(
      `${METALET_HOST}/wallet-api/v4/mvc/address/contract/nft/count?net=${NET}&address=${encodeURIComponent(address)}`,
    );
    return normalizeCount(response?.count);
  },
  fetchSummaryList: async (address) => {
    const response = await fetchJson<{ list?: RawMvcNftSummaryRow[] }>(
      `${METALET_HOST}/wallet-api/v4/mvc/address/contract/nft/summary-list?net=${NET}&address=${encodeURIComponent(address)}`,
    );
    return Array.isArray(response?.list) ? response.list : [];
  },
  fetchUtxoList: async (address) => {
    const all: RawMvcNftUtxoRow[] = [];
    let flag: string | undefined;
    while (true) {
      const params = new URLSearchParams({ net: NET, address });
      if (flag) params.set('flag', flag);
      const response = await fetchJson<{ list?: RawMvcNftUtxoRow[] }>(
        `${METALET_HOST}/wallet-api/v4/mvc/address/contract/nft/utxo-list?${params}`,
      );
      const list = Array.isArray(response?.list) ? response.list : [];
      if (!list.length) break;
      all.push(...list);
      flag = typeof list[list.length - 1]?.flag === 'string' ? String(list[list.length - 1].flag) : undefined;
      if (!flag) break;
    }
    return all;
  },
  buildRawTx: buildMvcNftTransferRawTx,
  broadcastTx: async (rawTx) => {
    const response = await fetch(`${METALET_HOST}/wallet-api/v3/tx/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chain: 'mvc',
        net: NET,
        rawTx,
      }),
    });
    const json = await response.json() as { code?: number; message?: string; data?: string };
    return resolveBroadcastTxResult(rawTx, json);
  },
}

/**
 * Aggregate one address's NFT holdings from the wallet-api read endpoints:
 * utxo-list carries per-item facts (tokenIndex/name/satoshi), summary-list
 * carries series facts (seriesName/tokenSupply per genesis) — summary-list is
 * NOT filtered by genesis on the wire, so group by genesis locally. The count
 * endpoint is the address-level total used for cross-checking the grouped sum.
 */
export async function getMvcNftBalance(
  address: string,
  deps: Pick<MvcNftServiceDeps, 'fetchCount' | 'fetchSummaryList' | 'fetchUtxoList'> = defaultDeps,
): Promise<MvcNftBalance> {
  if (!address || typeof address !== 'string') throw new Error('address is required');
  const [count, summaries, utxoRows] = await Promise.all([
    deps.fetchCount(address),
    deps.fetchSummaryList(address),
    deps.fetchUtxoList(address),
  ]);

  const summaryByGenesis = new Map<string, RawMvcNftSummaryRow>();
  for (const row of summaries) {
    const genesis = String(row.genesis || '').trim();
    if (genesis) summaryByGenesis.set(genesis, row);
  }

  const groups = new Map<string, MvcNftCollection>();
  for (const row of utxoRows) {
    const genesis = String(row.genesis || '').trim();
    const codeHash = String(row.codeHash || '').trim();
    const tokenIndex = normalizeTokenIndex(row.tokenIndex);
    if (!genesis || !tokenIndex) continue;
    const summary = summaryByGenesis.get(genesis);
    let collection = groups.get(genesis);
    if (!collection) {
      collection = {
        genesis,
        codeHash: codeHash || String(summary?.codeHash || ''),
        sensibleId: (row.sensibleId || summary?.sensibleId) ? String(row.sensibleId || summary?.sensibleId) : undefined,
        seriesName: String(summary?.seriesName || row.seriesName || ''),
        tokenSupply: summary?.tokenSupply != null ? normalizeCount(summary.tokenSupply) : undefined,
        count: 0,
        items: [],
      };
      groups.set(genesis, collection);
    }
    if (!collection.codeHash && codeHash) collection.codeHash = codeHash;
    if (!collection.seriesName && row.seriesName) collection.seriesName = String(row.seriesName);
    collection.items.push({
      tokenIndex,
      name: String(row.name || ''),
      satoshi: normalizeSatoshi(row.satoshi ?? row.satoshiString),
      txId: String(row.txId || ''),
      outputIndex: normalizeOutpointIndex(row.txIndex),
      height: normalizeHeight(row.height),
      icon: normalizeIcon(row.icon),
      metaTxId: row.metaTxId ? String(row.metaTxId) : undefined,
    });
  }

  const collections = Array.from(groups.values()).map((collection) => {
    collection.items.sort((a, b) => (Number(a.tokenIndex) || 0) - (Number(b.tokenIndex) || 0));
    collection.count = collection.items.length;
    return collection;
  }).sort((a, b) => a.genesis.localeCompare(b.genesis));

  return {
    address,
    count: count > 0 ? count : collections.reduce((total, collection) => total + collection.count, 0),
    collections,
  };
}

export async function executeMvcNftTransfer(
  store: MetabotStore,
  input: {
    metabotId: number;
    genesis: string;
    codehash: string;
    tokenIndex: string;
    toAddress: string;
    feeRate: number;
  },
  deps: MvcNftServiceDeps = defaultDeps,
): Promise<{ txId: string; rawTx: string }> {
  if (!Number.isInteger(input?.metabotId) || input.metabotId <= 0) {
    throw new Error('metabotId must be a positive integer');
  }
  if (!input?.genesis?.trim() || !input?.codehash?.trim()) {
    throw new Error('genesis and codehash are required');
  }
  const tokenIndex = normalizeTokenIndex(input.tokenIndex);
  if (!tokenIndex) throw new Error('tokenIndex must be a positive integer string');
  if (!input?.toAddress?.trim()) throw new Error('toAddress is required');
  if (!Number.isFinite(input?.feeRate) || input.feeRate <= 0) throw new Error('feeRate must be positive');

  const excludedOutpoints = new Set<string>();
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= RETRYABLE_MVC_NFT_BUILD_ATTEMPTS; attempt += 1) {
    const raw = await deps.buildRawTx(store, {
      metabotId: input.metabotId,
      genesis: input.genesis.trim(),
      codehash: input.codehash.trim(),
      tokenIndex,
      toAddress: input.toAddress.trim(),
      feeRate: input.feeRate,
      excludeOutpoints: Array.from(excludedOutpoints),
    });

    try {
      const txId = await deps.broadcastTx(raw.raw_tx);
      return { txId, rawTx: raw.raw_tx };
    } catch (error) {
      lastError = error;
      const message = getErrorMessage(error);
      if (attempt < RETRYABLE_MVC_NFT_BUILD_ATTEMPTS && isRetryableMvcBroadcastError(message)) {
        for (const outpoint of raw.spent_outpoints || []) {
          excludedOutpoints.add(String(outpoint).toLowerCase());
        }
        await sleep(RETRYABLE_MVC_NFT_BROADCAST_DELAY_MS);
        continue;
      }
      throw error;
    }
  }

  throw new Error(getErrorMessage(lastError ?? 'MVC NFT transfer failed'));
}
