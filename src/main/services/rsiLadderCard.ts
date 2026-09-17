/**
 * RSI 爬梯卡 — 主进程服务：登记链抓取 + 本地缓存 + 快照计算。
 *
 * §2.5 视图数据契约：唯一数据源 = 链上 `taskkey=local:88` 的 /protocols/simplelog
 * 记录；本地索引仅作缓存，与链上冲突时以链上为准。本服务不做任何链上写入、
 * 不自动登记、不自动抽验（§5.3）——读链是视图自身的取数职责，非「动作」。
 *
 * 链上读法（与 src/main/libs/omniReaderAgentTools.ts 的 pins_by_path 同端点）：
 *   GET https://manapi.metaid.io/api/pin/path/list?path=/protocols/simplelog&size=100&cursor=…
 * item.contentSummary 承载 payload 全文（2026-09-18 实测：1789/2576/504 字符均完整）；
 * contentSummary 解析失败时按 pin 回源 GET /content/<pinId> 兜底。
 */
import * as fs from 'fs';
import * as path from 'path';
import type {
  RsiLadderChainRecord,
  RsiLadderSnapshot,
  RsiLadderSnapshotResult,
} from '../../renderer/types/rsiLadder';
import { RSI_LADDER_TASKKEY } from '../../renderer/types/rsiLadder';
import { computeSnapshot } from './rsiLadderCompute';
import { readReceipts, registrationIndexPathFor } from './rsiLadderIndex';

const MANAPI_BASE = 'https://manapi.metaid.io';
const SIMPLELOG_PATH = '/protocols/simplelog';
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const FETCH_TIMEOUT_MS = 15_000;
/** 缓存新鲜度：超过该时长后下次 snapshot 会重取链上（手动刷新永远强取）。 */
const CACHE_STALE_MS = 5 * 60_000;

export type FetchJson = (url: string) => Promise<unknown>;
export type FetchText = (url: string) => Promise<string>;

interface PinPathListItem {
  id?: unknown;
  timestamp?: unknown;
  contentSummary?: unknown;
  content?: unknown;
}

interface PinPathListResponse {
  data?: { list?: PinPathListItem[]; nextCursor?: unknown; total?: unknown };
}

export interface RsiLadderCardServiceOptions {
  userDataPath: string;
  fetchJson?: FetchJson;
  fetchText?: FetchText;
  nowMs?: () => number;
}

/** 默认 HTTP 客户端：AbortController 超时 + 非 2xx 抛错。 */
function defaultFetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { signal: controller.signal })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return response.text();
    })
    .finally(() => clearTimeout(timer));
}

function defaultFetchJson(url: string): Promise<unknown> {
  return defaultFetchText(url).then((text) => JSON.parse(text) as unknown);
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  if (!text || !text.trim().startsWith('{')) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

interface ViewCacheFile {
  fetchedAtMs: number;
  records: RsiLadderChainRecord[];
}

export class RsiLadderCardService {
  private readonly userDataPath: string;
  private readonly fetchJson: FetchJson;
  private readonly fetchText: FetchText;
  private readonly nowMs: () => number;
  private lastChainRecords: RsiLadderChainRecord[] | null = null;
  private lastFetchAtMs = 0;

  constructor(options: RsiLadderCardServiceOptions) {
    this.userDataPath = options.userDataPath;
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
    this.fetchText = options.fetchText ?? defaultFetchText;
    this.nowMs = options.nowMs ?? Date.now;
  }

  get cacheFilePath(): string {
    return path.join(this.userDataPath, 'rsi-ladder', 'view-cache.json');
  }

  get registrationIndexPath(): string {
    return registrationIndexPathFor(this.userDataPath);
  }

  /**
   * 视图快照。refresh=false 时缓存 5 分钟内直接复用；refresh=true 强取链上。
   * 链上失败 → 落回缓存 / 登记索引兜底（fromChain=false + chainError）。
   */
  async snapshot(input?: { refresh?: boolean }): Promise<RsiLadderSnapshotResult> {
    const now = this.nowMs();
    const forceRefresh = input?.refresh === true;
    const cacheFresh = this.lastChainRecords !== null && now - this.lastFetchAtMs < CACHE_STALE_MS;
    if (!forceRefresh && cacheFresh && this.lastChainRecords) {
      return { success: true, snapshot: this.computeFrom(this.lastChainRecords, true, null, now) };
    }
    try {
      const records = await this.fetchChainRecords();
      this.lastChainRecords = records;
      this.lastFetchAtMs = this.nowMs();
      this.writeCache({ fetchedAtMs: this.lastFetchAtMs, records });
      return { success: true, snapshot: this.computeFrom(records, true, null, this.lastFetchAtMs) };
    } catch (error) {
      const chainError = error instanceof Error ? error.message : String(error);
      const cached = this.readCache();
      if (cached) {
        return { success: true, snapshot: this.computeFrom(cached.records, false, chainError, now) };
      }
      return { success: true, snapshot: this.computeFromIndexOnly(chainError, now) };
    }
  }

  /** 分页抓取 /protocols/simplelog 并按 taskkey 过滤（登记 + 抽验回写两类）。 */
  private async fetchChainRecords(): Promise<RsiLadderChainRecord[]> {
    const records: RsiLadderChainRecord[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL('api/pin/path/list', `${MANAPI_BASE}/`);
      url.searchParams.set('path', SIMPLELOG_PATH);
      url.searchParams.set('size', String(PAGE_SIZE));
      if (cursor) url.searchParams.set('cursor', cursor);
      const response = (await this.fetchJson(url.toString())) as PinPathListResponse;
      const list = response?.data?.list ?? [];
      for (const item of list) {
        const pinId = typeof item.id === 'string' ? item.id : '';
        const timestamp = typeof item.timestamp === 'number' ? item.timestamp : NaN;
        if (!pinId || !Number.isFinite(timestamp)) continue;
        const summaryText = typeof item.contentSummary === 'string' ? item.contentSummary : '';
        let payload = tryParseJsonObject(summaryText);
        if (!payload) {
          const fallbackText = typeof item.content === 'string' && item.content ? item.content : '';
          payload = fallbackText ? tryParseJsonObject(fallbackText) : null;
        }
        if (!payload) {
          try {
            payload = tryParseJsonObject(await this.fetchText(`${MANAPI_BASE}/content/${pinId}`));
          } catch {
            payload = null;
          }
        }
        if (!payload) continue;
        if (payload.taskkey !== RSI_LADDER_TASKKEY) continue;
        records.push({ pinId, createdAtMs: timestamp * 1000, source: 'chain', payload });
      }
      const next = response?.data?.nextCursor;
      if (typeof next !== 'string' || !next || list.length === 0) break;
      cursor = next;
    }
    return records;
  }

  private computeFrom(
    records: RsiLadderChainRecord[],
    fromChain: boolean,
    chainError: string | null,
    nowMs: number,
  ): RsiLadderSnapshot {
    const snapshot = computeSnapshot({ nowMs, records });
    return { ...snapshot, fromChain, chainError };
  }

  /** 链上不可达且无视图缓存：用登记索引回执兜底渲染（恒为待验，绝不计入 c(W)）。 */
  private computeFromIndexOnly(chainError: string, nowMs: number): RsiLadderSnapshot {
    const { receipts } = readReceipts(this.registrationIndexPath);
    const records: RsiLadderChainRecord[] = receipts.map((receipt) => ({
      pinId: receipt.registeredPin,
      createdAtMs: Date.parse(receipt.time) || receipt.recordedAtMs,
      source: 'index' as const,
      payload: {
        kind: 'status',
        taskkey: RSI_LADDER_TASKKEY,
        step: 'rsi-improvement-registered',
        extra: {
          time: receipt.time,
          improvement_id: receipt.improvementId,
          initiator: receipt.initiator,
          initiator_id: receipt.initiatorId,
          reason_summary: receipt.reasonSummary ?? '',
        },
      },
    }));
    const snapshot = computeSnapshot({ nowMs, records });
    return { ...snapshot, fromChain: false, chainError };
  }

  private readCache(): ViewCacheFile | null {
    try {
      const text = fs.readFileSync(this.cacheFilePath, 'utf8');
      const value = JSON.parse(text) as Partial<ViewCacheFile>;
      if (!Array.isArray(value.records)) return null;
      return { fetchedAtMs: typeof value.fetchedAtMs === 'number' ? value.fetchedAtMs : 0, records: value.records };
    } catch {
      return null;
    }
  }

  private writeCache(cache: ViewCacheFile): void {
    try {
      fs.mkdirSync(path.dirname(this.cacheFilePath), { recursive: true });
      fs.writeFileSync(this.cacheFilePath, JSON.stringify(cache), 'utf8');
    } catch {
      // 缓存写失败不阻塞视图——链上仍是唯一权威。
    }
  }
}
