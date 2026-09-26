import { fetchProtocolPinsFromIndexer, type ProtocolPinRecord } from '../protocolPinFetch';
import { METATASK_PROTOCOL_ROOT, type MetaTaskEventPath } from './constants';
import type { MetaTaskChainEvent } from './types';

/**
 * MetaTask chain-event collector: walks all nine /protocols/metatask/* pools
 * via pins_by_path with cursor pagination to the empty page (protocol §10.8;
 * an empty pool returns `"list": null` and must be tolerated), merges the
 * local P2P base with manapi, dedups by pinId, and normalizes each item into
 * the engine's MetaTaskChainEvent shape (body parsed from contentBody base64,
 * falling back to contentSummary — same decoding order as the reference
 * Python engine).
 */

const parseBody = (item: Record<string, unknown>): Record<string, unknown> => {
  const contentBody = item.contentBody;
  if (typeof contentBody === 'string' && contentBody) {
    try {
      const parsed = JSON.parse(Buffer.from(contentBody, 'base64').toString('utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through to contentSummary
    }
  }
  const contentSummary = item.contentSummary;
  if (typeof contentSummary === 'string' && contentSummary) {
    try {
      const parsed = JSON.parse(contentSummary);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through to empty body
    }
  }
  return {};
};

const normalizeTimestampMs = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed >= 10_000_000_000 ? Math.floor(parsed) : Math.floor(parsed * 1000);
};

export const normalizeChainEvent = (
  pinId: string,
  rawItem: Record<string, unknown>,
  fallbackTimestampMs: number | null
): MetaTaskChainEvent | null => {
  const path = String(rawItem.path ?? '').split('/').pop() ?? '';
  const heightRaw = Number(rawItem.genesisHeight);
  const height = Number.isFinite(heightRaw) ? Math.floor(heightRaw) : -1;
  if (!pinId || !path) return null;
  return {
    pinId,
    path: path as MetaTaskEventPath,
    author: typeof rawItem.globalMetaId === 'string' ? rawItem.globalMetaId : '',
    height,
    txIndex: Number.isFinite(Number(rawItem.txIndex)) ? Number(rawItem.txIndex) : 0,
    timestampMs: normalizeTimestampMs(rawItem.timestamp) || (fallbackTimestampMs ?? 0),
    body: parseBody(rawItem),
  };
};

export interface CollectMetaTaskEventsOptions {
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  pageSize?: number;
  maxPages?: number;
  timeoutMs?: number;
}

export interface CollectMetaTaskEventsResult {
  events: MetaTaskChainEvent[];
  perPath: { path: MetaTaskEventPath; count: number }[];
}

export async function collectMetaTaskEvents(
  options: CollectMetaTaskEventsOptions = {}
): Promise<CollectMetaTaskEventsResult> {
  const events: MetaTaskChainEvent[] = [];
  const perPath: { path: MetaTaskEventPath; count: number }[] = [];

  // Keep the whole raw item as "content" so the normalizer can read
  // genesisHeight / txIndex / globalMetaId / contentBody.
  const keepRaw = (item: Record<string, unknown>): unknown => item;

  for (const path of ['task', 'tree', 'spec', 'claim', 'release', 'submission', 'verify', 'amend', 'challenge'] as const) {
    let pins: ProtocolPinRecord[] = [];
    try {
      pins = await fetchProtocolPinsFromIndexer(`${METATASK_PROTOCOL_ROOT}/${path}`, {
        pageSize: options.pageSize ?? 200,
        maxPages: options.maxPages ?? 100,
        timeoutMs: options.timeoutMs ?? 8_000,
        fetchImpl: options.fetchImpl,
        selectContent: keepRaw,
      });
    } catch {
      pins = []; // a failed path must not fail the whole sweep
    }
    let count = 0;
    for (const pin of pins) {
      const rawItem = (pin.content && typeof pin.content === 'object' ? pin.content : {}) as Record<string, unknown>;
      const event = normalizeChainEvent(pin.pinId, rawItem, pin.timestampMs ?? null);
      if (event && event.path === path) {
        events.push(event);
        count += 1;
      }
    }
    perPath.push({ path, count });
  }
  return { events, perPath };
}
