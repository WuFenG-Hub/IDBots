/**
 * OpenTeam guest daemon (M1): watches group_chat_messages for every active
 * openteam_memberships row and lets the invited bot answer when @-mentioned,
 * exactly like a local group-task worker would.
 *
 * Modeled on groupTaskDaemon's structure (5s tick, single-tick re-entry guard,
 * module-level start/stop singleton, same mention gating via
 * groupChatMentionUtils) but deliberately leaner: no chair/worker protocol, no
 * orchestration, no session channel. Loop prevention comes from the per-
 * membership cursor (openteam_memberships.last_processed_msg_id, monotonic),
 * the self-message skip, and a per-membership reply cooldown. A reply starting
 * with [NO_REPLY] is suppressed (not sent on-chain), same escape hatch as the
 * group-task daemon.
 *
 * M1 scope note: plain LLM completion path only — no chat-skill routing turns
 * (getChatSkillsRoutingPrompt needs the cowork session/runner machinery; the
 * guest persona rules still tell the model to use its skills conceptually).
 * Session/experience recording is likewise left to later milestones.
 */

import type { SqliteDatabase as Database } from '../sqliteTypes';
import type { MetabotStore } from '../metabotStore';
import type { Metabot } from '../types/metabot';
import type {
  OpenTeamMembership,
  OpenTeamMembershipStore,
} from '../openTeamMembershipStore';
import { normalizeMetabotLlmId } from './llmFallback';
import { isMentioned } from './groupChatMentionUtils';
import { buildOpenTeamGuestPrompt } from './openTeamGuestPrompt';

/** Escape hatch: a reply starting with the [NO_REPLY] tag is suppressed (not sent on-chain). */
const NO_REPLY_PATTERN = /^\[NO_REPLY\]/i;

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_COOLDOWN_MS = 20_000;
const DEFAULT_CONTEXT_MESSAGE_COUNT = 20;

// ---------------------------------------------------------------------------
// Pure gating (exported for tests)
// ---------------------------------------------------------------------------

export interface OpenTeamGuestDaemonMessage {
  id: number;
  pinId: string | null;
  senderMetaId: string;
  senderGlobalMetaId: string | null;
  senderName: string;
  content: string;
  chainTimestamp?: number | null;
  replyPin?: string | null;
  /** Raw mention column (JSON array string). */
  mention: string | null;
}

export type OpenTeamGuestDecision =
  | { respond: true; reason: 'mentioned' }
  | { respond: false; reason: 'self_message' | 'empty_content' | 'not_mentioned' | 'cooldown' };

/**
 * Guest gating: answer only messages that @-mention this bot. Never the bot's
 * own messages (sender globalMetaId match), never empty content, and not while
 * the per-membership reply cooldown is still running (loop insurance).
 */
export function decideOpenTeamGuestResponse(input: {
  message: OpenTeamGuestDaemonMessage;
  bot: { name: string; globalmetaid: string | null; metaid?: string };
  lastReplyAt: number;
  now: number;
  cooldownMs: number;
}): OpenTeamGuestDecision {
  const { message, bot } = input;
  const content = (message.content ?? '').trim();
  if (!content) return { respond: false, reason: 'empty_content' };
  const senderGlobalMetaId = (message.senderGlobalMetaId ?? '').trim();
  if (
    senderGlobalMetaId
    && bot.globalmetaid?.trim()
    && senderGlobalMetaId === bot.globalmetaid.trim()
  ) {
    return { respond: false, reason: 'self_message' };
  }
  if (!isMentioned(message, bot)) return { respond: false, reason: 'not_mentioned' };
  if (input.now - input.lastReplyAt < input.cooldownMs) {
    return { respond: false, reason: 'cooldown' };
  }
  return { respond: true, reason: 'mentioned' };
}

// ---------------------------------------------------------------------------
// Daemon loop
// ---------------------------------------------------------------------------

export type OpenTeamGuestPerformChatFn = (
  systemPrompt: string,
  userMessage: string,
  llmId?: string | null,
  options?: { fallbackLlmId?: string | null; thinking?: 'enabled' | 'disabled' },
) => Promise<string>;

export type OpenTeamGuestSendGroupMessageFn = (
  metabotId: number,
  groupId: string,
  opts: { content: string; nickName?: string },
) => Promise<{ pinId: string }>;

export interface OpenTeamGuestDaemonSqliteLike {
  getDatabase(): Database;
}

export interface OpenTeamGuestDaemonDeps {
  getStore: () => OpenTeamGuestDaemonSqliteLike;
  getMetabotStore: () => MetabotStore;
  getOpenTeamMembershipStore: () => OpenTeamMembershipStore;
  performChat: OpenTeamGuestPerformChatFn;
  sendGroupMessage: OpenTeamGuestSendGroupMessageFn;
  emitLog?: (message: string) => void;
  now?: () => number;
  intervalMs?: number;
  cooldownMs?: number;
  contextMessageCount?: number;
}

export interface OpenTeamGuestDaemonLoop {
  runTick(): Promise<void>;
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

interface GroupChatMessageRow {
  id: number;
  pin_id: string | null;
  sender_metaid: string | null;
  sender_global_metaid: string | null;
  sender_name: string | null;
  content: string | null;
  mention: string | null;
  chain_timestamp: number | null;
  reply_pin: string | null;
}

function mapMessageRows(result: ReturnType<Database['exec']>): GroupChatMessageRow[] {
  if (!result[0]?.values?.length) return [];
  const columns = result[0].columns as string[];
  return result[0].values.map((values) => {
    const row: Record<string, unknown> = {};
    columns.forEach((col, index) => {
      row[col] = values[index];
    });
    return row as unknown as GroupChatMessageRow;
  });
}

function toDaemonMessage(row: GroupChatMessageRow): OpenTeamGuestDaemonMessage {
  return {
    id: row.id,
    pinId: row.pin_id ?? null,
    senderMetaId: (row.sender_metaid ?? '').trim(),
    senderGlobalMetaId: row.sender_global_metaid ?? null,
    senderName: (row.sender_name ?? '').trim() || 'Unknown',
    content: (row.content ?? '').trim(),
    mention: row.mention ?? null,
    chainTimestamp: row.chain_timestamp ?? null,
    replyPin: row.reply_pin ?? null,
  };
}

export function createOpenTeamGuestDaemonLoop(deps: OpenTeamGuestDaemonDeps): OpenTeamGuestDaemonLoop {
  const intervalMs = Math.max(1_000, Math.trunc(deps.intervalMs ?? DEFAULT_INTERVAL_MS));
  const cooldownMs = Math.max(0, Math.trunc(deps.cooldownMs ?? DEFAULT_COOLDOWN_MS));
  const contextMessageCount = Math.max(1, Math.trunc(deps.contextMessageCount ?? DEFAULT_CONTEXT_MESSAGE_COUNT));
  const emitLog = deps.emitLog ?? (() => undefined);
  const now = deps.now ?? (() => Date.now());

  // Loop prevention state (in-memory, per loop instance; the durable half is
  // the membership cursor in openteam_memberships).
  const lastReplyAtByMembership = new Map<number, number>();

  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  const queryNewMessages = (db: Database, groupId: string, afterId: number): GroupChatMessageRow[] =>
    mapMessageRows(db.exec(
      `SELECT id, pin_id, sender_metaid, sender_global_metaid, sender_name, content, mention,
              chain_timestamp, reply_pin
       FROM group_chat_messages
       WHERE group_id = ? AND id > ?
       ORDER BY id ASC`,
      [groupId, afterId],
    ));

  const queryRecentMessages = (db: Database, groupId: string, limit: number): GroupChatMessageRow[] => {
    const rows = mapMessageRows(db.exec(
      `SELECT id, pin_id, sender_metaid, sender_global_metaid, sender_name, content, mention,
              chain_timestamp, reply_pin
       FROM group_chat_messages
       WHERE group_id = ?
       ORDER BY id DESC LIMIT ?`,
      [groupId, limit],
    ));
    return rows.reverse();
  };

  /** Per-turn local time line (mirrors groupTaskDaemon's formatTurnTimeText). */
  const formatTurnTimeText = (): string => {
    const date = new Date(now());
    const pad = (value: number): string => String(value).padStart(2, '0');
    const local = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const utcOffset = `${sign}${Math.floor(Math.abs(offsetMinutes) / 60)}`;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
    const weekday = date.toLocaleDateString('en-US', { weekday: 'long' });
    return `Current local time: ${local} (UTC${utcOffset}, ${timezone}), ${weekday}`;
  };

  const buildGroupLogUserMessage = (
    db: Database,
    membership: OpenTeamMembership,
    triggering: OpenTeamGuestDaemonMessage,
  ): string => {
    const recent = queryRecentMessages(db, membership.groupId, contextMessageCount);
    const lines = recent.map((row) => {
      const message = toDaemonMessage(row);
      const line = `${message.senderName}: ${message.content}`;
      return row.id === triggering.id
        ? `>>> ${line} <<< (the message you are responding to)`
        : line;
    });
    const taskTitle = (membership.taskTitle ?? '').trim() || '(untitled task)';
    return [
      formatTurnTimeText(),
      '',
      `[OpenTeam group task "${taskTitle}" — recent group log (last ${contextMessageCount} messages)]`,
      ...(lines.length > 0 ? lines : ['(no messages yet)']),
    ].join('\n');
  };

  const generateAndSendGuestReply = async (
    membership: OpenTeamMembership,
    bot: Metabot,
    message: OpenTeamGuestDaemonMessage,
  ): Promise<void> => {
    const db = deps.getStore().getDatabase();
    const systemPrompt = buildOpenTeamGuestPrompt({ metabot: bot, membership });
    const userMessage = buildGroupLogUserMessage(db, membership, message);
    const llmId = normalizeMetabotLlmId(bot.llm_id) ?? undefined;
    const fallbackLlmId = normalizeMetabotLlmId(bot.fallback_llm_id);
    const reply = (
      await deps.performChat(systemPrompt, userMessage, llmId, { fallbackLlmId, thinking: 'enabled' })
    ).trim();
    if (!reply) return;
    // [NO_REPLY] escape hatch: the model opted to stay silent.
    if (NO_REPLY_PATTERN.test(reply)) {
      emitLog(
        `[OpenTeamGuestDaemon] Group ${membership.groupId}: bot ${bot.id} answered [NO_REPLY]; send suppressed`,
      );
      return;
    }
    await deps.sendGroupMessage(bot.id, membership.groupId, {
      content: reply,
      nickName: bot.name?.trim() || `bot-${bot.id}`,
    });
  };

  const processMembership = async (membership: OpenTeamMembership): Promise<void> => {
    const metabotStore = deps.getMetabotStore();
    const membershipStore = deps.getOpenTeamMembershipStore();
    const bot = metabotStore.getMetabotById(membership.metabotId);
    if (!bot || bot.enabled === false) return;
    if (!bot.globalmetaid?.trim()) return;
    const db = deps.getStore().getDatabase();

    const rows = queryNewMessages(db, membership.groupId, membership.lastProcessedMsgId);
    for (const row of rows) {
      const message = toDaemonMessage(row);
      try {
        const decision = decideOpenTeamGuestResponse({
          message,
          bot,
          lastReplyAt: lastReplyAtByMembership.get(membership.id) ?? 0,
          now: now(),
          cooldownMs,
        });
        if (decision.respond) {
          await generateAndSendGuestReply(membership, bot, message);
          lastReplyAtByMembership.set(membership.id, now());
        }
      } catch (error) {
        // One bad message must never stall the cursor or the tick.
        emitLog(
          `[OpenTeamGuestDaemon] Group ${membership.groupId}: message ${message.id} failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        membershipStore.updateLastProcessedMsgId(
          membership.groupId,
          membership.metabotId,
          message.id,
        );
      }
    }
  };

  const runTick = async (): Promise<void> => {
    const membershipStore = deps.getOpenTeamMembershipStore();
    for (const membership of membershipStore.listActiveMemberships()) {
      try {
        await processMembership(membership);
      } catch (error) {
        emitLog(
          `[OpenTeamGuestDaemon] Membership ${membership.id} tick failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  const runGuardedTick = (): void => {
    if (ticking) return;
    ticking = true;
    void runTick()
      .catch((error) => {
        emitLog(`[OpenTeamGuestDaemon] Tick failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        ticking = false;
      });
  };

  return {
    runTick,
    start() {
      if (timer) return;
      runGuardedTick();
      timer = setInterval(runGuardedTick, intervalMs);
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

let activeDaemonLoop: OpenTeamGuestDaemonLoop | null = null;

export function startOpenTeamGuestDaemon(deps: OpenTeamGuestDaemonDeps): void {
  stopOpenTeamGuestDaemon();
  activeDaemonLoop = createOpenTeamGuestDaemonLoop(deps);
  activeDaemonLoop.start();
}

export function stopOpenTeamGuestDaemon(): void {
  activeDaemonLoop?.stop();
  activeDaemonLoop = null;
}

export function isOpenTeamGuestDaemonRunning(): boolean {
  return Boolean(activeDaemonLoop?.isRunning());
}
