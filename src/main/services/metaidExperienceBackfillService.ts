/**
 * Conservative, versioned backfill for the owner-scoped MetaID experience
 * ledger. This adapter only consumes already-normalized local protocol rows;
 * it never infers an identity from a display name or rewrites source tables.
 */

import type { SqliteDatabase as Database } from '../sqliteTypes';
import type {
  MetaIDExperienceEpisodeStatus,
  MetaIDExperienceStore,
} from '../metaidExperienceStore';
import type { ServiceOrderRecord } from '../serviceOrderStore';
import type { GroupTask, GroupTaskMember, GroupTaskStore } from '../groupTaskStore';
import { normalizeGlobalMetaID, type GlobalMetaID } from '../shared/globalMetaId';
import { buildCanonicalPrivateConversationExternalConversationId } from './simplemsgPeerConversation';
import {
  recordMetaIDGroupTaskExperience,
  recordMetaIDPrivateA2AExperience,
  recordMetaIDServiceOrderExperience,
  type MetaIDServiceOrderExperienceEvent,
} from './metaidExperienceRecorder';

export const METAID_EXPERIENCE_BACKFILL_VERSION = 'v1';

export interface MetaIDExperienceBackfillIdentity {
  metabotId: number;
  globalMetaID: unknown;
}

export interface MetaIDExperienceBackfillMigrationState {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
}

export interface MetaIDExperienceBackfillSourceResult {
  source: 'private_a2a' | 'service_order' | 'group_task';
  status: 'completed' | 'skipped' | 'failed';
  scanned: number;
  recorded: number;
  skipped: number;
  errors: number;
}

export interface MetaIDExperienceBackfillResult {
  version: string;
  sources: MetaIDExperienceBackfillSourceResult[];
}

export interface MetaIDExperienceBackfillDeps {
  db: Database;
  experienceStore: MetaIDExperienceStore;
  saveDb?: () => void;
  migrationState: MetaIDExperienceBackfillMigrationState;
  localIdentities: () => MetaIDExperienceBackfillIdentity[];
  serviceOrders?: () => ServiceOrderRecord[];
  groupTaskStore?: GroupTaskStore;
  emitLog?: (message: string) => void;
}

interface PrivateMessageRow {
  id: number | string;
  pin_id: string | null;
  tx_id: string | null;
  from_global_metaid: string | null;
  to_global_metaid: string | null;
  content: string | null;
  reply_pin: string | null;
  chain_timestamp: number | string | null;
  created_at: string | number | null;
}

interface GroupMessageRow {
  id: number | string;
  pin_id: string | null;
  tx_id: string | null;
  sender_metaid: string | null;
  sender_global_metaid: string | null;
  sender_name: string | null;
  content: string | null;
  reply_pin: string | null;
  chain_timestamp: number | string | null;
  created_at: string | number | null;
}

const text = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
};

function tableExists(db: Database, tableName: string): boolean {
  const result = db.exec(
    `SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
    [tableName],
  );
  return Boolean(result[0]?.values?.length);
}

function rows<T>(db: Database, sql: string, params: unknown[] = []): T[] {
  const result = db.exec(sql, params);
  const columns = result[0]?.columns ?? [];
  return (result[0]?.values ?? []).map((values) =>
    Object.fromEntries(columns.map((column, index) => [column, values[index]])) as T,
  );
}

function epochMilliseconds(value: unknown): number | undefined {
  if (typeof value === 'string' && value.trim() && !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsedDate = Date.parse(value);
    return Number.isFinite(parsedDate) && parsedDate >= 0 ? parsedDate : undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed > 0 && parsed < 1_000_000_000_000 ? parsed * 1000 : parsed);
}

function validIdentities(
  input: MetaIDExperienceBackfillIdentity[],
): Map<number, GlobalMetaID> {
  const result = new Map<number, GlobalMetaID>();
  for (const identity of input ?? []) {
    const metabotId = Number(identity?.metabotId);
    const globalMetaID = normalizeGlobalMetaID(identity?.globalMetaID);
    if (!Number.isFinite(metabotId) || metabotId <= 0 || !globalMetaID) continue;
    result.set(Math.trunc(metabotId), globalMetaID);
  }
  return result;
}

function getPrivateMappingSessionId(
  db: Database,
  metabotId: number,
  peerGlobalMetaID: GlobalMetaID,
): string | null {
  if (!tableExists(db, 'cowork_conversation_mappings')) return null;
  const externalConversationId = buildCanonicalPrivateConversationExternalConversationId(peerGlobalMetaID);
  const result = db.exec(
    `SELECT cowork_session_id
     FROM cowork_conversation_mappings
     WHERE channel = 'metaweb_private' AND external_conversation_id = ? AND metabot_id = ?
     LIMIT 1`,
    [externalConversationId, metabotId],
  );
  return text(result[0]?.values?.[0]?.[0]) || null;
}

function privateRows(db: Database): PrivateMessageRow[] {
  if (!tableExists(db, 'private_chat_messages')) return [];
  return rows<PrivateMessageRow>(
    db,
    `SELECT id, pin_id, tx_id, from_global_metaid, to_global_metaid,
            content, reply_pin, chain_timestamp, created_at
     FROM private_chat_messages
     ORDER BY id ASC`,
  );
}

function isCiphertextWithoutPlaintext(value: string): boolean {
  return value.startsWith('U2FsdGVkX1') || value.startsWith('-----BEGIN');
}

export function backfillMetaIDPrivateA2AExperiences(input: {
  db: Database;
  experienceStore: MetaIDExperienceStore;
  localIdentities: MetaIDExperienceBackfillIdentity[];
  peerGlobalMetaID?: unknown;
}): MetaIDExperienceBackfillSourceResult {
  const result: MetaIDExperienceBackfillSourceResult = {
    source: 'private_a2a',
    status: 'completed',
    scanned: 0,
    recorded: 0,
    skipped: 0,
    errors: 0,
  };
  if (!tableExists(input.db, 'private_chat_messages')) {
    return { ...result, status: 'skipped' };
  }

  const identityMap = validIdentities(input.localIdentities);
  const peerFilter = normalizeGlobalMetaID(input.peerGlobalMetaID);
  for (const row of privateRows(input.db)) {
    result.scanned += 1;
    const fromGlobalMetaID = normalizeGlobalMetaID(row.from_global_metaid);
    const toGlobalMetaID = normalizeGlobalMetaID(row.to_global_metaid);
    const content = text(row.content);
    if (!fromGlobalMetaID || !toGlobalMetaID || fromGlobalMetaID === toGlobalMetaID || !content) {
      result.skipped += 1;
      continue;
    }
    if (peerFilter && fromGlobalMetaID !== peerFilter && toGlobalMetaID !== peerFilter) continue;
    const occurredAt = epochMilliseconds(row.chain_timestamp) ?? epochMilliseconds(row.created_at);
    const observers: Array<{ metabotId: number; owner: GlobalMetaID; peer: GlobalMetaID; direction: 'incoming' | 'outgoing' }> = [];
    for (const [metabotId, owner] of identityMap.entries()) {
      if (owner === fromGlobalMetaID) {
        observers.push({ metabotId, owner, peer: toGlobalMetaID, direction: 'outgoing' });
      } else if (owner === toGlobalMetaID) {
        observers.push({ metabotId, owner, peer: fromGlobalMetaID, direction: 'incoming' });
      }
    }
    if (observers.length === 0 || isCiphertextWithoutPlaintext(content)) {
      result.skipped += 1;
      continue;
    }
    for (const observer of observers) {
      try {
        const recorded = recordMetaIDPrivateA2AExperience({
          store: input.experienceStore,
          ownerGlobalMetaID: observer.owner,
          peerGlobalMetaID: observer.peer,
          externalConversationId: buildCanonicalPrivateConversationExternalConversationId(observer.peer),
          sessionId: getPrivateMappingSessionId(input.db, observer.metabotId, observer.peer),
          direction: observer.direction,
          content,
          messageId: text(row.id) || null,
          pinId: text(row.pin_id) || null,
          replyToPinId: text(row.reply_pin) || null,
          occurredAt,
          sourceMetadata: {
            txId: text(row.tx_id) || null,
            pinId: text(row.pin_id) || null,
          },
        });
        if (recorded) result.recorded += 1;
        else result.skipped += 1;
      } catch {
        result.errors += 1;
      }
    }
  }
  return result;
}

interface HistoricalOrderEvent {
  type: MetaIDServiceOrderExperienceEvent;
  at: number;
  rank: number;
  status: ServiceOrderRecord['status'];
}

function orderEventTime(order: ServiceOrderRecord, value: unknown): number {
  return epochMilliseconds(value) ?? epochMilliseconds(order.updatedAt) ?? epochMilliseconds(order.createdAt) ?? Date.now();
}

function historicalOrderEvents(order: ServiceOrderRecord): HistoricalOrderEvent[] {
  const events: HistoricalOrderEvent[] = [
    { type: 'created', at: orderEventTime(order, order.createdAt), rank: 0, status: 'awaiting_first_response' },
  ];
  if (order.firstResponseAt != null) events.push({ type: 'first_response', at: orderEventTime(order, order.firstResponseAt), rank: 1, status: 'in_progress' });
  if (order.deliveredAt != null || text(order.deliveryMessagePinId)) events.push({ type: 'delivered', at: orderEventTime(order, order.deliveredAt), rank: 2, status: 'rating_pending' });
  if (order.failedAt != null || order.status === 'failed' || order.status === 'refund_pending' || order.status === 'refunded') events.push({ type: 'failed', at: orderEventTime(order, order.failedAt), rank: 3, status: 'failed' });
  if (order.ratingRequestedAt != null) events.push({ type: 'rating_requested', at: orderEventTime(order, order.ratingRequestedAt), rank: 4, status: 'rating_pending' });
  if (order.refundRequestedAt != null || text(order.refundRequestPinId) || order.status === 'refund_pending' || order.status === 'refunded') events.push({ type: 'refund_requested', at: orderEventTime(order, order.refundRequestedAt), rank: 5, status: 'refund_pending' });
  if (order.refundCompletedAt != null || text(order.refundFinalizePinId) || order.status === 'refunded') events.push({ type: 'refunded', at: orderEventTime(order, order.refundCompletedAt), rank: 6, status: 'refunded' });
  if (order.orderEndedAt != null || text(order.orderEndMessagePinId) || order.status === 'completed') events.push({ type: 'order_ended', at: orderEventTime(order, order.orderEndedAt), rank: 7, status: 'completed' });
  return events.sort((left, right) => left.at - right.at || left.rank - right.rank);
}

export function backfillMetaIDServiceOrderExperiences(input: {
  experienceStore: MetaIDExperienceStore;
  localIdentities: MetaIDExperienceBackfillIdentity[];
  orders: ServiceOrderRecord[];
}): MetaIDExperienceBackfillSourceResult {
  const result: MetaIDExperienceBackfillSourceResult = {
    source: 'service_order',
    status: 'completed',
    scanned: input.orders.length,
    recorded: 0,
    skipped: 0,
    errors: 0,
  };
  const identityMap = validIdentities(input.localIdentities);
  for (const order of input.orders) {
    const ownerGlobalMetaID = identityMap.get(Number(order.localMetabotId));
    if (!ownerGlobalMetaID) {
      result.skipped += 1;
      continue;
    }
    for (const event of historicalOrderEvents(order)) {
      try {
        const historicalOrder = {
          ...order,
          status: event.status,
          updatedAt: event.at,
        } as ServiceOrderRecord;
        const recorded = recordMetaIDServiceOrderExperience({
          store: input.experienceStore,
          ownerGlobalMetaID,
          order: historicalOrder,
          event: event.type,
          occurredAt: event.at,
          sourceMetadata: { localMetabotId: order.localMetabotId },
        });
        if (recorded) result.recorded += 1;
        else result.skipped += 1;
      } catch {
        result.errors += 1;
      }
    }
  }
  return result;
}

function taskMessageRows(db: Database, groupId: string): GroupMessageRow[] {
  return rows<GroupMessageRow>(
    db,
    `SELECT id, pin_id, tx_id, sender_metaid, sender_global_metaid, sender_name,
            content, reply_pin, chain_timestamp, created_at
     FROM group_chat_messages
     WHERE group_id = ?
     ORDER BY id ASC`,
    [groupId],
  );
}

function taskStatusToEpisodeStatus(status: GroupTask['status']): MetaIDExperienceEpisodeStatus {
  if (status === 'done') return 'completed';
  if (status === 'cancelled') return 'abandoned';
  return 'open';
}

function taskParticipants(
  members: GroupTaskMember[],
  identities: Map<number, GlobalMetaID>,
): Array<{ globalMetaID?: GlobalMetaID; unresolvedActorKey?: string; role: string }> {
  return members.map((member) => {
    const globalMetaID = normalizeGlobalMetaID(member.globalmetaid)
      ?? (member.metabotId == null ? null : identities.get(member.metabotId) ?? null);
    return globalMetaID
      ? { globalMetaID, role: member.role }
      : { unresolvedActorKey: `group-task-member:${member.id}`, role: member.role };
  });
}

function getTaskSessionId(db: Database, taskId: number, metabotId: number): string | null {
  if (!tableExists(db, 'cowork_conversation_mappings')) return null;
  const result = db.exec(
    `SELECT cowork_session_id FROM cowork_conversation_mappings
     WHERE channel = 'metaweb_group_task' AND external_conversation_id = ? AND metabot_id = ?
     LIMIT 1`,
    [`group-task:${taskId}`, metabotId],
  );
  return text(result[0]?.values?.[0]?.[0]) || null;
}

export function backfillMetaIDGroupTaskExperiences(input: {
  db: Database;
  experienceStore: MetaIDExperienceStore;
  groupTaskStore: GroupTaskStore;
  localIdentities: MetaIDExperienceBackfillIdentity[];
}): MetaIDExperienceBackfillSourceResult {
  const result: MetaIDExperienceBackfillSourceResult = {
    source: 'group_task',
    status: 'completed',
    scanned: 0,
    recorded: 0,
    skipped: 0,
    errors: 0,
  };
  if (!tableExists(input.db, 'group_chat_messages')) return { ...result, status: 'skipped' };
  const identities = validIdentities(input.localIdentities);
  for (const task of input.groupTaskStore.listTasks()) {
    if (!task.groupId) continue;
    const members = input.groupTaskStore.listMembers(task.id);
    const localMembers = members.filter((member) => member.metabotId != null && identities.has(member.metabotId));
    if (localMembers.length === 0) continue;
    const participants = taskParticipants(members, identities);
    const messageRows = taskMessageRows(input.db, task.groupId);
    result.scanned += messageRows.length;
    for (const row of messageRows) {
      const content = text(row.content);
      if (!content) {
        result.skipped += 1;
        continue;
      }
      for (const member of localMembers) {
        const ownerGlobalMetaID = identities.get(member.metabotId!);
        if (!ownerGlobalMetaID) continue;
        try {
          const recorded = recordMetaIDGroupTaskExperience({
            store: input.experienceStore,
            ownerGlobalMetaID,
            taskId: task.id,
            groupId: task.groupId,
            sessionId: getTaskSessionId(input.db, task.id, member.metabotId!),
            message: {
              id: row.id,
              pinId: row.pin_id,
              txId: row.tx_id,
              senderGlobalMetaID: row.sender_global_metaid,
              senderMetaID: row.sender_metaid,
              content,
              occurredAt: epochMilliseconds(row.chain_timestamp) ?? epochMilliseconds(row.created_at),
              replyPin: row.reply_pin,
            },
            participants,
          });
          if (recorded) {
            result.recorded += 1;
            const desiredStatus = taskStatusToEpisodeStatus(task.status);
            if (recorded.episode.status !== desiredStatus) {
              input.experienceStore.updateEpisodeStatus({
                episodeId: recorded.episode.id,
                status: desiredStatus,
                endedAt: desiredStatus === 'open' ? null : epochMilliseconds(task.closedAt) ?? Date.now(),
              });
            }
          } else {
            result.skipped += 1;
          }
        } catch {
          result.errors += 1;
        }
      }
    }
  }
  return result;
}

function migrationDone(state: MetaIDExperienceBackfillMigrationState, key: string): boolean {
  const value = state.get<unknown>(key);
  return value === true || value === '1' || (value && typeof value === 'object' && (value as { version?: string }).version === METAID_EXPERIENCE_BACKFILL_VERSION);
}

export function runMetaIDExperienceBackfill(
  deps: MetaIDExperienceBackfillDeps,
): MetaIDExperienceBackfillResult {
  const emitLog = deps.emitLog ?? (() => undefined);
  const sources: MetaIDExperienceBackfillSourceResult[] = [];
  const identities = deps.localIdentities() ?? [];
  const sourceRuns: Array<{
    name: MetaIDExperienceBackfillSourceResult['source'];
    run: () => MetaIDExperienceBackfillSourceResult;
  }> = [
    {
      name: 'private_a2a',
      run: () => backfillMetaIDPrivateA2AExperiences({
        db: deps.db,
        experienceStore: deps.experienceStore,
        localIdentities: identities,
      }),
    },
    {
      name: 'service_order',
      run: () => backfillMetaIDServiceOrderExperiences({
        experienceStore: deps.experienceStore,
        localIdentities: identities,
        orders: deps.serviceOrders?.() ?? [],
      }),
    },
    {
      name: 'group_task',
      run: () => deps.groupTaskStore
        ? backfillMetaIDGroupTaskExperiences({
            db: deps.db,
            experienceStore: deps.experienceStore,
            groupTaskStore: deps.groupTaskStore,
            localIdentities: identities,
          })
        : {
            source: 'group_task',
            status: 'skipped',
            scanned: 0,
            recorded: 0,
            skipped: 0,
            errors: 0,
          },
    },
  ];

  for (const source of sourceRuns) {
    const key = `metaid_experience_backfill:${METAID_EXPERIENCE_BACKFILL_VERSION}:${source.name}`;
    if (migrationDone(deps.migrationState, key)) {
      sources.push({ source: source.name, status: 'skipped', scanned: 0, recorded: 0, skipped: 0, errors: 0 });
      continue;
    }
    try {
      const result = source.run();
      sources.push(result);
      deps.saveDb?.();
      if (result.status !== 'failed') {
        deps.migrationState.set(key, { version: METAID_EXPERIENCE_BACKFILL_VERSION, completedAt: Date.now() });
      }
      emitLog(`[MetaIDExperienceBackfill] ${source.name}: scanned=${result.scanned}, recorded=${result.recorded}, skipped=${result.skipped}, errors=${result.errors}`);
    } catch (error) {
      const result: MetaIDExperienceBackfillSourceResult = {
        source: source.name,
        status: 'failed',
        scanned: 0,
        recorded: 0,
        skipped: 0,
        errors: 1,
      };
      sources.push(result);
      emitLog(`[MetaIDExperienceBackfill] ${source.name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { version: METAID_EXPERIENCE_BACKFILL_VERSION, sources };
}
