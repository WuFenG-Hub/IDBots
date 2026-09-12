import { getUtxoOutpointKey, isRetryableMvcBroadcastError, type SpendableMvcUtxo } from './mvcSpend';

export interface ChunkedUploadFundingUtxo extends SpendableMvcUtxo {
  flag: string;
}

export const CHUNKED_UPLOAD_CHUNK_SIZE_BYTES = 1024 * 1024;
// Per-chunk on-chain tx carries the chunk bytes plus metafile/envelope overhead.
// Calibrated against the uploader estimate endpoint (2000 B file -> chunkFee
// 11270 sats at feeRate 5, i.e. ~254 overhead bytes per chunk tx).
export const CHUNKED_UPLOAD_CHUNK_OVERHEAD_BYTES = 320;
// Index tx + merge-tx outputs/pre-tx margins, expressed as virtual bytes.
export const CHUNKED_UPLOAD_FIXED_OVERHEAD_BYTES = 1500;

export function estimateChunkedUploadFundingSats(sizeBytes: number, feeRate: number, chunkSizeBytes?: number): number {
  const size = Math.max(0, Math.floor(Number(sizeBytes) || 0));
  const rate = Math.max(1, Math.floor(Number(feeRate) || 0));
  if (size <= 0) return 0;
  const chunkSize = Number.isFinite(chunkSizeBytes) && Number(chunkSizeBytes) > 0
    ? Math.floor(Number(chunkSizeBytes))
    : CHUNKED_UPLOAD_CHUNK_SIZE_BYTES;
  const chunkCount = Math.ceil(size / chunkSize);
  const lastChunkSize = size - (chunkCount - 1) * chunkSize;
  const dataBytes = (chunkCount - 1) * (chunkSize + CHUNKED_UPLOAD_CHUNK_OVERHEAD_BYTES)
    + lastChunkSize + CHUNKED_UPLOAD_CHUNK_OVERHEAD_BYTES;
  return Math.ceil((dataBytes + CHUNKED_UPLOAD_FIXED_OVERHEAD_BYTES) * rate);
}

export function formatSatsAsSpace(sats: number): string {
  const value = Math.max(0, Number(sats) || 0) / 100_000_000;
  return `${Number(value.toFixed(8))} SPACE`;
}

export function normalizeChunkedUploadUtxos(input: unknown, address: string): ChunkedUploadFundingUtxo[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      const record = item as Record<string, unknown>;
      const txId = String(record.txId ?? record.txid ?? '').trim();
      const outputIndex = Number(record.outputIndex ?? record.outIndex ?? record.vout);
      const satoshis = Number(record.satoshis ?? record.value ?? 0);
      const height = Number(record.height ?? 0);
      return {
        txId,
        outputIndex,
        satoshis,
        address: String(record.address || address).trim() || address,
        height: Number.isFinite(height) ? height : 0,
        flag: String(record.flag || ''),
      };
    })
    .filter((utxo) => /^[0-9a-fA-F]{64}$/.test(utxo.txId) && Number.isInteger(utxo.outputIndex) && utxo.outputIndex >= 0 && utxo.satoshis > 600);
}

export function pickChunkedUploadFundingUtxos(
  utxos: ChunkedUploadFundingUtxo[],
  amount: number,
  feeRate: number,
  excludedOutpoints: ReadonlySet<string> = new Set(),
): ChunkedUploadFundingUtxo[] {
  let requiredAmount = amount + 34 * 2 * feeRate + 100;
  const candidateUtxos: ChunkedUploadFundingUtxo[] = [];

  let current = 0;
  for (const utxo of utxos) {
    if (excludedOutpoints.has(getUtxoOutpointKey(utxo))) continue;
    current += utxo.satoshis;
    requiredAmount += feeRate * 148;
    candidateUtxos.push(utxo);
    if (current > requiredAmount) {
      return candidateUtxos;
    }
  }

  throw new Error(
    `Insufficient MVC balance for chunked upload: requires ~${requiredAmount} sats (${formatSatsAsSpace(requiredAmount)}), only ${current} sats (${formatSatsAsSpace(current)}) spendable`,
  );
}

export function isRetryableChunkedUploadError(message: string): boolean {
  const normalized = String(message || '').toLowerCase();
  return (
    isRetryableMvcBroadcastError(message)
    || (normalized.includes('failed to broadcast') && isRetryableMvcBroadcastError(message))
    || normalized.includes('failed to broadcast merge transaction: [-25]missing inputs')
    || normalized.includes('failed to broadcast merge transaction: 258: txn-mempool-conflict')
  );
}
