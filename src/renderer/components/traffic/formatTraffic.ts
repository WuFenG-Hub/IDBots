/**
 * Decimal traffic units used by the Settings → Traffic panel.
 * Product contract: 1000 bytes = 1 KB, 1_000_000 bytes = 1 MB
 * (not the 1024-based KiB/MiB scale).
 */

export const TRAFFIC_BYTES_PER_KB = 1000;
export const TRAFFIC_BYTES_PER_MB = 1_000_000;
/** Low-balance banner threshold (5 MB). */
export const TRAFFIC_LOW_BALANCE_BYTES = 5 * TRAFFIC_BYTES_PER_MB;
/** Fallback grant size when campaign status has not returned grantBytes. */
export const DEFAULT_FREE_GRANT_BYTES = 10 * TRAFFIC_BYTES_PER_MB;

export type TrafficDisplayUnit = 'bytes' | 'kb' | 'mb';

export function splitTrafficAmount(bytes: number): { amount: string; unit: TrafficDisplayUnit } {
  const abs = Math.abs(bytes);
  if (abs < TRAFFIC_BYTES_PER_KB) {
    return { amount: String(bytes), unit: 'bytes' };
  }
  if (abs < TRAFFIC_BYTES_PER_MB) {
    return { amount: formatScaled(bytes / TRAFFIC_BYTES_PER_KB), unit: 'kb' };
  }
  return { amount: formatScaled(bytes / TRAFFIC_BYTES_PER_MB, { roundAt: 100 }), unit: 'mb' };
}

function formatScaled(value: number, options: { roundAt?: number } = {}): string {
  if (options.roundAt !== undefined && Math.abs(value) >= options.roundAt) {
    return String(Math.round(value));
  }
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value.toFixed(1);
}
