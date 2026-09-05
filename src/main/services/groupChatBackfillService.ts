/**
 * Group chat history backfill for Group Task groups: periodically reconciles local
 * group_chat_messages with the indexer history API so messages missed by the socket
 * push (disconnects, restarts, app offline) are recovered. The socket push remains
 * the realtime path; backfill only fills gaps. Both paths use INSERT OR IGNORE on
 * pin_id (UNIQUE), so they are naturally idempotent.
 *
 * Loop pattern cloned from privateChatBackfillService (15s interval, single-tick
 * re-entry guard, timer.unref(), module-level start/stop/isRunning singleton).
 */

import type { SqliteDatabase as Database } from '../sqliteTypes';
import { decryptGroupMessage } from './metaWebCrypto';
import { resolveGroupChatSenderName } from './metaWebListenerService';

export interface GroupChatBackfillServiceDeps {
  db: Database;
  saveDb: () => void;
  emitLog?: (message: string) => void;
  fetchJson?: (url: string) => Promise<unknown>;
  endpoints?: Array<{ baseUrl: string }>;
  intervalMs?: number;
  pageSize?: number;
  maxRowsPerGroupPerTick?: number;
}

export interface GroupChatBackfillSyncResult {
  groups: number;
  fetched: number;
  inserted: number;
  failedGroups: number;
}

export interface GroupChatBackfillLoop {
  syncOnce(): Promise<GroupChatBackfillSyncResult>;
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_ROWS_PER_GROUP_PER_TICK = 200;

/** Dual indexer endpoints, same pair as privateChatHistorySyncService. */
const DEFAULT_ENDPOINTS = [
  { baseUrl: 'https://api.idchat.io/chat-api/group-chat/group-chat-list-by-index' },
  { baseUrl: 'https://www.show.now/chat-api/group-chat/group-chat-list-by-index' },
];

// DI for the active-group source (group_tasks rows live behind groupTaskStore;
// injecting a getter here avoids a module-level dependency/cycle). Wired from main.ts.
let activeGroupIdsGetter: (() => string[]) | null = null;

export function setGroupChatBackfillActiveGroupIdsGetter(getter: () => string[]): void {
  activeGroupIdsGetter = getter;
}

function getActiveGroupIds(): string[] {
  if (!activeGroupIdsGetter) return [];
  try {
    return activeGroupIdsGetter() ?? [];
  } catch {
    return [];
  }
}

const toSafeString = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
};

const toNullableNumber = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.trunc(value);
};

const getUserInfoRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

/** Normalized group chat history item (GroupChatItem from the indexer API). */
interface GroupChatHistoryMessage {
  index: number | null;
  txId: string;
  pinId: string;
  groupId: string;
  channelId: string;
  metaId: string;
  globalMetaId: string;
  address: string;
  nickName: string;
  userInfo: Record<string, unknown> | null;
  protocol: string;
  content: string;
  contentType: string;
  encryption: string;
  chatType: number | null;
  replyPin: string;
  mention: unknown[];
  timestamp: number | null;
  chain: string;
  raw: Record<string, unknown>;
}

/** Keep the record with the most non-null fields (mirrors scoreMessage in privateChatHistorySyncService). */
const scoreMessage = (message: GroupChatHistoryMessage): number => {
  return [
    message.txId,
    message.pinId,
    message.groupId,
    message.channelId,
    message.metaId,
    message.globalMetaId,
    message.address,
    message.protocol,
    message.content,
    message.contentType,
    message.encryption,
    message.replyPin,
    message.chain,
  ].filter(Boolean).length;
};

function normalizeHistoryMessage(raw: unknown): GroupChatHistoryMessage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const txId = toSafeString(record.txId);
  const pinId = toSafeString(record.pinId) || (txId ? `${txId}i0` : '');
  if (!pinId) return null;

  return {
    index: toNullableNumber(record.index),
    txId,
    pinId,
    groupId: toSafeString(record.groupId),
    channelId: toSafeString(record.channelId),
    metaId: toSafeString(record.metaId),
    globalMetaId: toSafeString(record.globalMetaId),
    address: toSafeString(record.address),
    nickName: toSafeString(record.nickName),
    userInfo: getUserInfoRecord(record.userInfo),
    protocol: toSafeString(record.protocol),
    content: toSafeString(record.content),
    contentType: toSafeString(record.contentType),
    encryption: toSafeString(record.encryption) || toSafeString(record.encrypt),
    chatType: toNullableNumber(record.chatType),
    replyPin: toSafeString(record.replyPin),
    mention: Array.isArray(record.mention) ? record.mention : [],
    timestamp: toNullableNumber(record.timestamp),
    chain: toSafeString(record.chain),
    raw: record,
  };
}

async function fetchHistoryPage(
  endpoint: { baseUrl: string },
  groupId: string,
  startIndex: number,
  size: number,
  fetchJson: (url: string) => Promise<unknown>,
): Promise<GroupChatHistoryMessage[]> {
  const url = new URL(endpoint.baseUrl);
  url.searchParams.set('groupId', groupId);
  url.searchParams.set('startIndex', String(Math.max(0, Math.trunc(startIndex))));
  url.searchParams.set('size', String(Math.max(1, Math.trunc(size))));

  const json = (await fetchJson(url.toString())) as { code?: number; data?: unknown };
  if (typeof json?.code === 'number' && json.code !== 0) return [];
  const data = json?.data;
  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as { list?: unknown[] } | null)?.list)
      ? (data as { list: unknown[] }).list
      : [];
  return list
    .map((item) => normalizeHistoryMessage(item))
    .filter((item): item is GroupChatHistoryMessage => Boolean(item));
}

function mergeMessagesByPinId(
  lists: Array<GroupChatHistoryMessage[] | null>,
): GroupChatHistoryMessage[] {
  const merged = new Map<string, GroupChatHistoryMessage>();
  for (const message of lists.flatMap((list) => list ?? [])) {
    const key = message.pinId || message.txId;
    if (!key) continue;
    const existing = merged.get(key);
    if (!existing || scoreMessage(message) >= scoreMessage(existing)) {
      merged.set(key, message);
    }
  }
  return [...merged.values()].sort((left, right) => {
    const leftIndex = left.index ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = right.index ?? Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    const leftTimestamp = left.timestamp ?? Number.MAX_SAFE_INTEGER;
    const rightTimestamp = right.timestamp ?? Number.MAX_SAFE_INTEGER;
    return leftTimestamp - rightTimestamp;
  });
}

/**
 * Per-group cursor: MAX(msg_index) over locally stored rows. When the group has no
 * local rows yet there is no cursor, so pagination starts at index 0 (the first
 * on-chain message); otherwise it resumes right after the last known index.
 */
function getGroupCursor(db: Database, groupId: string): { cursor: number; rowCount: number } {
  const result = db.exec(
    `SELECT COALESCE(MAX(msg_index), 0) AS cursor, COUNT(*) AS row_count
     FROM group_chat_messages WHERE group_id = ?`,
    [groupId],
  );
  const row = result[0]?.values?.[0];
  const cursor = Number(row?.[0] ?? 0);
  const rowCount = Number(row?.[1] ?? 0);
  return {
    cursor: Number.isFinite(cursor) ? Math.trunc(cursor) : 0,
    rowCount: Number.isFinite(rowCount) ? Math.trunc(rowCount) : 0,
  };
}

/**
 * Insert recovered rows exactly like metaWebListenerService.routeGroupChat does
 * (same columns, same fallbacks, is_processed = 0 so the orchestrator still sees
 * them). INSERT OR IGNORE on pin_id makes realtime/backfill paths idempotent.
 */
function storeGroupChatHistoryMessages(
  db: Database,
  saveDb: () => void,
  groupIdParam: string,
  messages: GroupChatHistoryMessage[],
): number {
  let insertedCount = 0;

  for (const message of messages) {
    const groupId = message.groupId || groupIdParam;
    if (!groupId) continue;

    const userInfo = message.userInfo ?? {};
    const mentionStr = JSON.stringify(message.mention);
    const rawDataStr = JSON.stringify(message.raw);

    let content = message.content;
    if (message.encryption === 'aes' && (message.chatType === 0 || message.chatType === 1)) {
      content = decryptGroupMessage(content, groupId.substring(0, 16));
    }

    db.run(
      `INSERT OR IGNORE INTO group_chat_messages (
        pin_id, tx_id, group_id, channel_id, sender_metaid, sender_global_metaid, sender_address,
        sender_name, sender_avatar, sender_chat_pubkey, protocol, content, content_type, encryption,
        reply_pin, mention, chain_timestamp, chain, raw_data, is_processed, msg_index
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        message.pinId,
        message.txId || null,
        groupId,
        message.channelId || null,
        message.metaId || message.globalMetaId || message.address || '',
        message.globalMetaId || null,
        message.address || null,
        resolveGroupChatSenderName(message.globalMetaId, toSafeString(userInfo.name), message.nickName),
        toSafeString(userInfo.avatar) || '',
        toSafeString(userInfo.chatPublicKey) || '',
        message.protocol || '',
        content,
        message.contentType || null,
        message.encryption || null,
        message.replyPin || '',
        mentionStr,
        message.timestamp,
        message.chain || null,
        rawDataStr,
        message.index,
      ],
    );

    insertedCount += (db as { getRowsModified?: () => number }).getRowsModified?.() ?? 0;
  }

  if (insertedCount > 0) {
    saveDb();
  }

  return insertedCount;
}

export function createGroupChatBackfillLoop(
  deps: GroupChatBackfillServiceDeps,
): GroupChatBackfillLoop {
  const intervalMs = Math.max(1_000, Math.trunc(deps.intervalMs ?? DEFAULT_INTERVAL_MS));
  const pageSize = Math.max(1, Math.trunc(deps.pageSize ?? DEFAULT_PAGE_SIZE));
  const maxRowsPerGroupPerTick = Math.max(
    pageSize,
    Math.trunc(deps.maxRowsPerGroupPerTick ?? DEFAULT_MAX_ROWS_PER_GROUP_PER_TICK),
  );
  const endpoints = deps.endpoints ?? DEFAULT_ENDPOINTS;
  const emitLog = deps.emitLog ?? (() => undefined);
  const fetchJson = deps.fetchJson ?? (async (url: string) => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch group chat history: ${response.status}`);
    }
    return await response.json() as unknown;
  });

  let timer: ReturnType<typeof setInterval> | null = null;
  let syncing = false;

  const syncOnce = async (): Promise<GroupChatBackfillSyncResult> => {
    const result: GroupChatBackfillSyncResult = {
      groups: 0,
      fetched: 0,
      inserted: 0,
      failedGroups: 0,
    };

    const groupIds = [...new Set(
      getActiveGroupIds()
        .map((groupId) => String(groupId ?? '').trim())
        .filter(Boolean),
    )];
    result.groups = groupIds.length;

    for (const groupId of groupIds) {
      try {
        const { cursor, rowCount } = getGroupCursor(deps.db, groupId);
        let startIndex = rowCount === 0 ? 0 : cursor + 1;
        let fetchedForGroup = 0;
        let insertedForGroup = 0;

        while (fetchedForGroup < maxRowsPerGroupPerTick) {
          const size = Math.min(pageSize, maxRowsPerGroupPerTick - fetchedForGroup);
          const lists = await Promise.all(endpoints.map(async (endpoint) => {
            try {
              return await fetchHistoryPage(endpoint, groupId, startIndex, size, fetchJson);
            } catch {
              return null;
            }
          }));
          if (lists.every((list) => list === null)) {
            throw new Error('all history endpoints failed');
          }

          const merged = mergeMessagesByPinId(lists);
          if (merged.length === 0) break;

          fetchedForGroup += merged.length;
          result.fetched += merged.length;
          insertedForGroup += storeGroupChatHistoryMessages(deps.db, deps.saveDb, groupId, merged);

          if (merged.length < size) break; // short page: no more history
          startIndex += merged.length;
        }

        result.inserted += insertedForGroup;
        if (insertedForGroup > 0) {
          emitLog(`[GroupChatBackfill] Recovered ${insertedForGroup} group message(s) for group ${groupId.slice(0, 8)}…`);
        }
      } catch (error) {
        result.failedGroups += 1;
        emitLog(`[GroupChatBackfill] Group sync failed for ${groupId.slice(0, 8)}…: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return result;
  };

  const runBackgroundSync = (): void => {
    if (syncing) return;
    syncing = true;
    void syncOnce()
      .catch((error) => {
        emitLog(`[GroupChatBackfill] Sync failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        syncing = false;
      });
  };

  return {
    syncOnce,
    start() {
      if (timer) return;
      runBackgroundSync();
      timer = setInterval(runBackgroundSync, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    isRunning() {
      return timer !== null;
    },
  };
}

let activeBackfillLoop: GroupChatBackfillLoop | null = null;

export function startGroupChatBackfill(deps: GroupChatBackfillServiceDeps): void {
  stopGroupChatBackfill();
  activeBackfillLoop = createGroupChatBackfillLoop(deps);
  activeBackfillLoop.start();
}

export function stopGroupChatBackfill(): void {
  activeBackfillLoop?.stop();
  activeBackfillLoop = null;
}

export function isGroupChatBackfillRunning(): boolean {
  return Boolean(activeBackfillLoop?.isRunning());
}
