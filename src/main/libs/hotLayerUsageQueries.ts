import type { SqliteDatabase as Database } from '../sqliteTypes';

/** Trailing-window usage evidence for one hot-layer item (RRSI P3). */
export interface HotLayerUsageStats {
  itemId: string;
  /** Nights the item was judged APPLIED on (hot or recall — re-entry needs
   * recall evidence, so both count). Only audited nights can be applied. */
  appliedNights: number;
  /** Audited nights the item was injected HOT (the pruning denominator). */
  exposedNights: number;
  /** Nights the audit pass returned a verdict for the item at all. */
  auditedNights: number;
}

/**
 * Shared hot_layer_usage aggregation (RRSI P3, design §6.3): one GROUP BY row
 * per item over [sinceDate, untilDate] (inclusive). Callers with no candidate
 * ids skip the query; a database created before the table existed (unit-test
 * stores without SqliteStore) yields an empty map instead of throwing — only
 * "no such table" degrades, any other error is rethrown.
 */
export function queryHotLayerUsageStats(
  db: Database,
  input: {
    metabotId: number;
    kind: 'technique' | 'procedure' | 'knowledge' | 'memory';
    sinceDate: string;
    untilDate: string;
    itemIds?: readonly string[];
  },
): Map<string, HotLayerUsageStats> {
  const itemIds = input.itemIds ?? null;
  if (itemIds !== null && itemIds.length === 0) return new Map();
  const params: Array<string | number> = [input.metabotId, input.kind, input.sinceDate, input.untilDate];
  const itemFilter = itemIds !== null
    ? ` AND item_id IN (${itemIds.map(() => '?').join(', ')})`
    : '';
  if (itemIds !== null) params.push(...itemIds);
  let rows: Array<{ item_id: string; applied_nights: number | string; exposed_nights: number | string; audited_nights: number | string }>;
  try {
    const result = db.exec(
      `SELECT item_id,
              SUM(CASE WHEN applied = 1 THEN 1 ELSE 0 END) AS applied_nights,
              SUM(CASE WHEN audited_at IS NOT NULL AND exposure = 'hot' THEN 1 ELSE 0 END) AS exposed_nights,
              SUM(CASE WHEN audited_at IS NOT NULL THEN 1 ELSE 0 END) AS audited_nights
       FROM hot_layer_usage
       WHERE metabot_id = ? AND item_kind = ? AND usage_date >= ? AND usage_date <= ?${itemFilter}
       GROUP BY item_id`,
      params,
    );
    const columns = result[0]?.columns ?? [];
    rows = (result[0]?.values ?? []).map((values) => {
      const record: Record<string, unknown> = {};
      columns.forEach((column, index) => { record[column] = values[index]; });
      return record as unknown as {
        item_id: string; applied_nights: number | string; exposed_nights: number | string; audited_nights: number | string;
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('no such table')) return new Map();
    throw error;
  }
  const stats = new Map<string, HotLayerUsageStats>();
  for (const row of rows) {
    stats.set(String(row.item_id), {
      itemId: String(row.item_id),
      appliedNights: Math.max(0, Math.floor(Number(row.applied_nights) || 0)),
      exposedNights: Math.max(0, Math.floor(Number(row.exposed_nights) || 0)),
      auditedNights: Math.max(0, Math.floor(Number(row.audited_nights) || 0)),
    });
  }
  return stats;
}
