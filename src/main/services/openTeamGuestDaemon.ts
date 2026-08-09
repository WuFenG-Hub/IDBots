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
 * M3 scope note: chat-skill turns are wired through the same narrow seams the
 * group-task daemon uses (getChatSkillsRoutingPrompt + runSkillTurn, backed by
 * runSkillTurnInExistingSession in main.ts). Routing stays on the bot's OWN
 * allow_chat_skills (allowAllEnabled is never set — external group members are
 * not the owner, so the permission surface matches a non-owner private-chat
 * peer). Any routing/execution failure degrades to the plain LLM completion
 * path so skill assembly can never silence the guest. Files produced by a
 * skill turn are uploaded on-chain as metafiles (guest bot's own wallet pays,
 * via the metaFileUploadService path the private-chat order flow uses) and
 * delivered as `[DELIVERABLE] metafile: metafile://<pinId><ext>` lines — the
 * exact shape the inviter-side groupTaskDeliverableParser ingests.
 * Session/experience recording is likewise left to later milestones.
 */

import type { SqliteDatabase as Database } from '../sqliteTypes';
import type { MetabotStore } from '../metabotStore';
import type { Metabot } from '../types/metabot';
import type { CoworkSession, CoworkStore } from '../coworkStore';
import type {
  OpenTeamMembership,
  OpenTeamMembershipStore,
} from '../openTeamMembershipStore';
import { resolveSessionWorkingDirectory } from '../libs/botWorkspace';
import { normalizeMetabotLlmId } from './llmFallback';
import { isMentioned } from './groupChatMentionUtils';
import { buildOpenTeamGuestPrompt } from './openTeamGuestPrompt';
import {
  buildGuestMetafileDeliverableLine,
  collectGuestDeliverableFiles,
  DEFAULT_MAX_DELIVERABLE_FILES,
} from './openTeamGuestDeliverables';

/** Escape hatch: a reply starting with the [NO_REPLY] tag is suppressed (not sent on-chain). */
const NO_REPLY_PATTERN = /^\[NO_REPLY\]/i;

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_COOLDOWN_MS = 20_000;
const DEFAULT_CONTEXT_MESSAGE_COUNT = 20;

/** Cowork conversation-mapping channel for the guest's per-group skill sessions. */
const CONVERSATION_CHANNEL = 'openteam_guest';

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

/** Narrow skill-routing seam (same shape as groupTaskDaemon's; wired to skillManager.buildChatSkillsRoutingPrompt). */
export type OpenTeamGuestSkillRoutingFn = (input: {
  allowChatSkills?: unknown;
  allowAllEnabled?: boolean;
}) =>
  | { prompt: string | null; activeSkillIds: string[] }
  | Promise<{ prompt: string | null; activeSkillIds: string[] }>;

/**
 * Narrow skill-turn seam (wired to runSkillTurnInExistingSession in main.ts).
 * `cwd` is the working directory the turn ran in — the delivery step resolves
 * mentioned file paths and scans for generated files against it.
 */
export type OpenTeamGuestRunSkillTurnFn = (params: {
  sessionId: string;
  systemPrompt: string;
  userMessage: string;
  activeSkillIds: string[];
}) => Promise<{ replyText: string; assistantMessageId?: string | null; cwd?: string | null }>;

/**
 * Narrow metafile upload seam (wired to metaFileUploadService.uploadMetaFile
 * in main.ts). The GUEST bot's own wallet (metabotId) pays the upload, exactly
 * like the private-chat order delivery path.
 */
export type OpenTeamGuestUploadFileFn = (input: {
  metabotId: number;
  filePath: string;
  contentType?: string;
}) => Promise<Record<string, unknown>>;

export interface OpenTeamGuestDaemonSqliteLike {
  getDatabase(): Database;
}

export interface OpenTeamGuestDaemonDeps {
  getStore: () => OpenTeamGuestDaemonSqliteLike;
  getMetabotStore: () => MetabotStore;
  getOpenTeamMembershipStore: () => OpenTeamMembershipStore;
  performChat: OpenTeamGuestPerformChatFn;
  sendGroupMessage: OpenTeamGuestSendGroupMessageFn;
  /**
   * M3 skill machinery — all three must be wired for chat-skill turns; unwired
   * (or failing) the daemon stays on the plain LLM completion path.
   */
  getCoworkStore?: () => CoworkStore;
  getChatSkillsRoutingPrompt?: OpenTeamGuestSkillRoutingFn;
  runSkillTurn?: OpenTeamGuestRunSkillTurnFn;
  /** M3 file delivery; unwired = skill turns run but files are not uploaded/delivered. */
  uploadDeliverableFile?: OpenTeamGuestUploadFileFn;
  /** Cap on metafile deliverables appended per turn (default DEFAULT_MAX_DELIVERABLE_FILES). */
  maxDeliverableFilesPerTurn?: number;
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

  const maxDeliverableFilesPerTurn = Math.max(
    1,
    Math.trunc(deps.maxDeliverableFilesPerTurn ?? DEFAULT_MAX_DELIVERABLE_FILES),
  );

  /**
   * Per-membership cowork session for skill turns (mirrors groupTaskDaemon's
   * ensureTaskSession, keyed on the external group id instead of a local
   * group_tasks row).
   */
  const ensureGuestSession = (
    coworkStore: CoworkStore,
    membership: OpenTeamMembership,
    bot: Metabot,
  ): CoworkSession => {
    const externalConversationId = `openteam-guest:${membership.groupId}`;
    const existing = coworkStore.getConversationMapping(CONVERSATION_CHANNEL, externalConversationId, bot.id);
    if (existing) {
      const session = coworkStore.getSession(existing.coworkSessionId);
      if (session) return session;
    }
    const config = coworkStore.getConfig();
    const workspaceRoot = resolveSessionWorkingDirectory(
      (config.workingDirectory ?? '').trim() || process.cwd(),
      bot.id,
    );
    const taskTitle = (membership.taskTitle ?? '').trim() || '(untitled task)';
    const session = coworkStore.createSession(
      `OpenTeam Guest "${taskTitle}" (${bot.name})`,
      workspaceRoot,
      '',
      config.executionMode || 'local',
      [],
      bot.id,
      'group_task',
      null,
      null,
      null,
    );
    coworkStore.upsertConversationMapping({
      channel: CONVERSATION_CHANNEL,
      externalConversationId,
      metabotId: bot.id,
      coworkSessionId: session.id,
      metadataJson: JSON.stringify({ groupId: membership.groupId }),
    });
    return session;
  };

  /**
   * M3 file delivery: upload the skill turn's file artifact(s) on-chain as
   * metafiles and append one `[DELIVERABLE] metafile: <uri>` line per file.
   * Upload problems never suppress or rewrite the text reply — failed files
   * are called out in a plain (untagged) sentence so no fake deliverable rows
   * can be ingested on the inviter side.
   */
  const appendFileDeliverables = async (input: {
    bot: Metabot;
    reply: string;
    cwd: string;
    turnStartedAt: number;
    turnCompletedAt: number;
  }): Promise<string> => {
    const files = collectGuestDeliverableFiles({
      texts: [input.reply],
      cwd: input.cwd,
      // The allowlist root IS the guest session workspace (the daemon wiring
      // runs the skill turn there): anything outside is dropped + logged.
      allowedRoot: input.cwd,
      emitLog,
      turnStartedAt: input.turnStartedAt,
      turnCompletedAt: input.turnCompletedAt,
      maxFiles: maxDeliverableFilesPerTurn,
    });
    if (files.length === 0) return input.reply;

    const deliverableLines: string[] = [];
    const failedNames: string[] = [];
    for (const file of files) {
      try {
        const upload = await deps.uploadDeliverableFile!({
          metabotId: input.bot.id,
          filePath: file.filePath,
          contentType: file.contentType,
        });
        const pinId = typeof upload?.pinId === 'string' ? upload.pinId.trim() : '';
        const line = pinId
          ? buildGuestMetafileDeliverableLine({
            pinId,
            fileName: file.fileName,
            contentType: file.contentType,
          })
          : null;
        if (line) {
          deliverableLines.push(line);
        } else {
          failedNames.push(file.fileName);
          emitLog(
            `[OpenTeamGuestDaemon] Bot ${input.bot.id}: metafile upload for ${file.fileName} returned no pinId`,
          );
        }
      } catch (error) {
        failedNames.push(file.fileName);
        emitLog(
          `[OpenTeamGuestDaemon] Bot ${input.bot.id}: metafile upload for ${file.fileName} failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (deliverableLines.length === 0 && failedNames.length === 0) return input.reply;
    return [
      input.reply,
      ...deliverableLines,
      ...(failedNames.length > 0
        ? [`(On-chain upload failed for: ${failedNames.join(', ')} — generated locally but not delivered as a metafile; ask me to retry if needed.)`]
        : []),
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

    // Skill routing (mirrors groupTaskDaemon): when the bot has chat skills
    // enabled and routing hits, run ONE skill turn in the guest's cowork
    // session; otherwise (or on any routing failure) fall back to the plain
    // completion path.
    let routing: { prompt: string | null; activeSkillIds: string[] } = { prompt: null, activeSkillIds: [] };
    if (deps.getChatSkillsRoutingPrompt && deps.runSkillTurn && deps.getCoworkStore) {
      try {
        routing = await deps.getChatSkillsRoutingPrompt({
          allowChatSkills: bot.allow_chat_skills ?? [],
          // External group members are never the owner: only the bot's own
          // configured allow_chat_skills are routable — the exact permission
          // surface a non-owner private-chat peer gets. Nothing is widened.
          allowAllEnabled: false,
        });
      } catch (error) {
        emitLog(
          `[OpenTeamGuestDaemon] Group ${membership.groupId}: skill routing failed for bot ${bot.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const canRunSkillTurn = Boolean(
      routing.prompt && routing.activeSkillIds.length > 0 && deps.runSkillTurn && deps.getCoworkStore,
    );

    let reply = '';
    let skillTurn: { cwd: string; startedAt: number; completedAt: number } | null = null;
    if (canRunSkillTurn) {
      const coworkStore = deps.getCoworkStore!();
      const session = ensureGuestSession(coworkStore, membership, bot);
      const skillSystemPrompt = [
        systemPrompt,
        '',
        routing.prompt!,
        '',
        'After using Read/Bash to run a skill, reply concisely in the group. Do not paste full skill logs.',
        'If the skill produced a file, put its absolute local path on its own line in your reply — the host uploads it on-chain and appends the [DELIVERABLE] metafile line for you. NEVER write or invent a metafile:// URI yourself.',
      ].join('\n');
      coworkStore.addMessage(session.id, { type: 'user', content: userMessage });
      const startedAt = now();
      try {
        const skillTurnResult = await deps.runSkillTurn!({
          sessionId: session.id,
          systemPrompt: skillSystemPrompt,
          userMessage,
          activeSkillIds: routing.activeSkillIds,
        });
        reply = (skillTurnResult.replyText ?? '').trim();
        // The runner appends the assistant message to the session itself.
        if (reply) {
          skillTurn = {
            cwd: (skillTurnResult.cwd ?? '').trim() || session.cwd,
            startedAt,
            completedAt: now(),
          };
        }
      } catch (error) {
        // Skill execution failure degrades to the plain completion path — a
        // skill-assembly problem must never silence the guest.
        emitLog(
          `[OpenTeamGuestDaemon] Group ${membership.groupId}: skill turn failed for bot ${bot.id}, ` +
          `falling back to plain completion: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (!reply) {
      const llmId = normalizeMetabotLlmId(bot.llm_id) ?? undefined;
      const fallbackLlmId = normalizeMetabotLlmId(bot.fallback_llm_id);
      reply = (
        await deps.performChat(systemPrompt, userMessage, llmId, { fallbackLlmId, thinking: 'enabled' })
      ).trim();
    }
    if (!reply) return;
    // [NO_REPLY] escape hatch: the model opted to stay silent. Checked BEFORE
    // any upload so a suppressed message never spends upload fees.
    if (NO_REPLY_PATTERN.test(reply)) {
      emitLog(
        `[OpenTeamGuestDaemon] Group ${membership.groupId}: bot ${bot.id} answered [NO_REPLY]; send suppressed`,
      );
      return;
    }

    if (skillTurn && deps.uploadDeliverableFile) {
      reply = await appendFileDeliverables({
        bot,
        reply,
        cwd: skillTurn.cwd,
        turnStartedAt: skillTurn.startedAt,
        turnCompletedAt: skillTurn.completedAt,
      });
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
