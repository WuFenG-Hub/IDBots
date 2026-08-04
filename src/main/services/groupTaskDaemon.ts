/**
 * Group Task daemon: watches group_chat_messages for every non-terminal group_tasks
 * row and triggers bot replies under the strict chair-controlled protocol.
 *
 * Modeled on privateChatDaemon's structure (5s tick, single-tick re-entry guard,
 * module-level start/stop singleton) but deliberately separate from the cognitive
 * orchestrator ("chat mode"): Group Task has its own cursor
 * (group_tasks.last_processed_msg_id), its own session channel
 * (metaweb_group_task), and its own gating rules. Chunk A implements the
 * plain-LLM reply path only (no skill turns).
 */

import type { SqliteDatabase as Database } from '../sqliteTypes';
import type { MetabotStore } from '../metabotStore';
import type { CoworkStore, CoworkSession } from '../coworkStore';
import type { GroupTaskStore, GroupTask, GroupTaskMember } from '../groupTaskStore';
import { resolveSessionWorkingDirectory } from '../libs/botWorkspace';
import { normalizeMetabotLlmId } from './llmFallback';
import { buildGroupTaskSystemPrompt } from './groupTaskPrompts';

const CONVERSATION_CHANNEL = 'metaweb_group_task';
const DELIVERABLE_TAG = /\[DELIVERABLE\]/i;
const STATUS_TAG = /\[STATUS:\s*(EXECUTING|REVIEW)\s*\]/i;
const DELIVERABLE_URI_PATTERN = /(metafile:\/\/[^\s]+|metaapp:\/\/[^\s]+|https?:\/\/[^\s]+)/i;
/** Escape hatch: a reply starting with the [NO_REPLY] tag is suppressed (not sent on-chain). */
const NO_REPLY_PATTERN = /^\[NO_REPLY\]/i;

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_WORKER_COOLDOWN_MS = 20_000;
const DEFAULT_CHAIR_COOLDOWN_MS = 10_000;
const DEFAULT_REPLY_BUDGET = 40;
const DEFAULT_MAX_REPLIES_PER_TASK_PER_TICK = 3;
const DEFAULT_CONTEXT_MESSAGE_COUNT = 20;

// ---------------------------------------------------------------------------
// Pure gating (exported for tests)
// ---------------------------------------------------------------------------

export interface GroupTaskDaemonMessage {
  id: number;
  pinId: string | null;
  senderMetaId: string;
  senderGlobalMetaId: string | null;
  senderName: string;
  content: string;
  /** Raw mention column (JSON array string). */
  mention: string | null;
}

export interface GroupTaskDaemonTask {
  id: number;
  status: string;
}

export interface GroupTaskDaemonMember {
  metabotId: number | null;
  globalmetaid: string | null;
  role: 'chair' | 'worker';
  name: string | null;
}

export interface GroupTaskDaemonBot {
  id: number;
  name: string;
  metaid: string;
  globalmetaid: string | null;
  boss_global_metaid?: string | null;
}

export interface GroupTaskResponderDecision {
  metabotId: number;
  reason:
    | 'worker_mentioned'
    | 'chair_mentioned'
    | 'chair_owner_message'
    | 'chair_deliverable'
    | 'chair_floor_control';
}

/** Full bot shape used inside the daemon (gating + prompts + llm config). */
interface GroupTaskDaemonBotFull extends GroupTaskDaemonBot {
  role?: string | null;
  soul?: string | null;
  goal?: string | null;
  bio?: string | null;
  background?: string | null;
  llm_id?: string | null;
  fallback_llm_id?: string | null;
  allow_chat_skills?: string[] | null;
}

/** Local equivalent of orchestrator's contentContainsBotName (kept separate by design). */
function contentContainsBotName(content: string, botName: string): boolean {
  if (!content || !botName) return false;
  return content.toLowerCase().includes(botName.toLowerCase().trim());
}

/** Local equivalent of orchestrator's mentionContainsMetaId (kept separate by design). */
function mentionContainsMetaId(
  mentionJson: string | null,
  globalMetaId: string | null,
  metaId: string | undefined,
): boolean {
  if (!mentionJson) return false;
  let ids: unknown[] = [];
  try {
    const parsed = JSON.parse(mentionJson) as unknown;
    ids = Array.isArray(parsed) ? parsed : [];
  } catch {
    return false;
  }
  if (ids.length === 0) return false;
  const targets = [globalMetaId, metaId]
    .map((value) => (value ?? '').trim())
    .filter(Boolean);
  if (targets.length === 0) return false;
  return ids.some((id) => targets.includes(String(id).trim()));
}

function isMentioned(
  message: GroupTaskDaemonMessage,
  bot: GroupTaskDaemonBot,
): boolean {
  return mentionContainsMetaId(message.mention, bot.globalmetaid, bot.metaid)
    || contentContainsBotName(message.content, bot.name);
}

/**
 * Decide which local member bots respond to one group message.
 * - Never: the author itself (by sender_global_metaid), empty content, terminal tasks.
 * - Review phase (status === 'review'): workers NEVER respond (even when mentioned);
 *   the chair responds ONLY to owner messages. No floor-control, deliverable, or
 *   mention triggers in review (hard silence against gratitude loops).
 * - Worker: only when @-mentioned (mention array hit or display name in content).
 * - Chair: when (a) @-mentioned, (b) the message is from the owner (sender matches the
 *   chair bot's boss_global_metaid), (c) a [DELIVERABLE] tag appears, or (d) the
 *   message is not addressed to any specific member (floor-control duty). A message
 *   addressed only to another member (exactly one worker hit, chair not hit) keeps
 *   the chair silent unless (b)/(c) apply.
 */
export function decideGroupTaskResponders(
  message: GroupTaskDaemonMessage,
  task: GroupTaskDaemonTask,
  members: GroupTaskDaemonMember[],
  botsById: Map<number, GroupTaskDaemonBot>,
): GroupTaskResponderDecision[] {
  const decisions: GroupTaskResponderDecision[] = [];
  const content = (message.content ?? '').trim();
  if (!content) return decisions;
  if (task.status === 'done' || task.status === 'cancelled') return decisions;
  const isReviewPhase = task.status === 'review';

  const senderGlobalMetaId = (message.senderGlobalMetaId ?? '').trim();
  const isSelf = (bot: GroupTaskDaemonBot): boolean =>
    Boolean(senderGlobalMetaId)
    && Boolean(bot.globalmetaid?.trim())
    && senderGlobalMetaId === bot.globalmetaid!.trim();

  // Resolve mention/name hits once per member.
  const hits = new Map<number, boolean>();
  for (const member of members) {
    if (member.metabotId == null) continue;
    const bot = botsById.get(member.metabotId);
    if (!bot) continue;
    hits.set(member.metabotId, isMentioned(message, bot));
  }

  const chairMember = members.find((member) => member.role === 'chair');
  const chairHit = chairMember?.metabotId != null ? hits.get(chairMember.metabotId) === true : false;
  const workerHitCount = members.filter(
    (member) => member.role === 'worker'
      && member.metabotId != null
      && hits.get(member.metabotId) === true,
  ).length;
  const addressedToSpecificMember = workerHitCount > 0 || chairHit;
  const hasDeliverable = DELIVERABLE_TAG.test(content);

  for (const member of members) {
    if (member.metabotId == null) continue;
    const bot = botsById.get(member.metabotId);
    if (!bot) continue;
    if (isSelf(bot)) continue;

    const mentioned = hits.get(member.metabotId) === true;

    if (member.role === 'worker') {
      // Review phase: workers never respond, even when @-mentioned.
      if (!isReviewPhase && mentioned) {
        decisions.push({ metabotId: member.metabotId, reason: 'worker_mentioned' });
      }
      continue;
    }

    // chair
    const bossGlobalMetaId = (bot.boss_global_metaid ?? '').trim();
    const isOwnerMessage = Boolean(
      senderGlobalMetaId && bossGlobalMetaId && senderGlobalMetaId === bossGlobalMetaId,
    );
    if (isReviewPhase) {
      // Review phase: the chair responds only to the owner (acceptance dialogue).
      if (isOwnerMessage) {
        decisions.push({ metabotId: member.metabotId, reason: 'chair_owner_message' });
      }
      continue;
    }
    if (mentioned) {
      decisions.push({ metabotId: member.metabotId, reason: 'chair_mentioned' });
      continue;
    }
    if (isOwnerMessage) {
      decisions.push({ metabotId: member.metabotId, reason: 'chair_owner_message' });
      continue;
    }
    if (hasDeliverable) {
      decisions.push({ metabotId: member.metabotId, reason: 'chair_deliverable' });
      continue;
    }
    if (!addressedToSpecificMember) {
      decisions.push({ metabotId: member.metabotId, reason: 'chair_floor_control' });
    }
  }

  return decisions;
}

// ---------------------------------------------------------------------------
// Daemon loop
// ---------------------------------------------------------------------------

export interface GroupTaskDaemonSqliteStoreLike {
  getDatabase(): Database;
  getSaveFunction(): () => void;
}

export type GroupTaskDaemonPerformChatFn = (
  systemPrompt: string,
  userMessage: string,
  llmId?: string | null,
  options?: { fallbackLlmId?: string | null },
) => Promise<string>;

export type GroupTaskDaemonSendFn = (
  taskId: number,
  metabotId: number,
  content: string,
) => Promise<{ pinId: string }>;

/** Narrow skill-routing seam (mirrors how privateChatDaemon calls skillManager). */
export type GroupTaskDaemonSkillRoutingFn = (input: {
  allowChatSkills?: unknown;
  allowAllEnabled?: boolean;
}) =>
  | { prompt: string | null; activeSkillIds: string[] }
  | Promise<{ prompt: string | null; activeSkillIds: string[] }>;

/** Narrow skill-turn seam: runs one skill turn inside an existing session. */
export type GroupTaskDaemonRunSkillTurnFn = (params: {
  sessionId: string;
  systemPrompt: string;
  userMessage: string;
  activeSkillIds: string[];
}) => Promise<{ replyText: string; assistantMessageId?: string | null }>;

export interface GroupTaskDaemonTaskEvent {
  type: 'groupTask:statusChanged';
  taskId: number;
  status: string;
  at: number;
}

export interface GroupTaskDaemonDeps {
  getStore: () => GroupTaskDaemonSqliteStoreLike;
  getGroupTaskStore: () => GroupTaskStore;
  getMetabotStore: () => MetabotStore;
  getCoworkStore: () => CoworkStore;
  performChat: GroupTaskDaemonPerformChatFn;
  postGroupTaskMessage: GroupTaskDaemonSendFn;
  getChatSkillsRoutingPrompt?: GroupTaskDaemonSkillRoutingFn;
  runSkillTurn?: GroupTaskDaemonRunSkillTurnFn;
  emitTaskEvent?: (payload: GroupTaskDaemonTaskEvent) => void;
  emitLog?: (message: string) => void;
  now?: () => number;
  intervalMs?: number;
  workerCooldownMs?: number;
  chairCooldownMs?: number;
  replyBudget?: number;
  maxRepliesPerTaskPerTick?: number;
  contextMessageCount?: number;
}

export interface GroupTaskDaemonLoop {
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

function toDaemonMessage(row: GroupChatMessageRow): GroupTaskDaemonMessage {
  return {
    id: row.id,
    pinId: row.pin_id ?? null,
    senderMetaId: (row.sender_metaid ?? '').trim(),
    senderGlobalMetaId: row.sender_global_metaid ?? null,
    senderName: (row.sender_name ?? '').trim() || 'Unknown',
    content: (row.content ?? '').trim(),
    mention: row.mention ?? null,
  };
}

export function createGroupTaskDaemonLoop(deps: GroupTaskDaemonDeps): GroupTaskDaemonLoop {
  const intervalMs = Math.max(1_000, Math.trunc(deps.intervalMs ?? DEFAULT_INTERVAL_MS));
  const workerCooldownMs = Math.max(0, Math.trunc(deps.workerCooldownMs ?? DEFAULT_WORKER_COOLDOWN_MS));
  const chairCooldownMs = Math.max(0, Math.trunc(deps.chairCooldownMs ?? DEFAULT_CHAIR_COOLDOWN_MS));
  const replyBudget = Math.max(1, Math.trunc(deps.replyBudget ?? DEFAULT_REPLY_BUDGET));
  const maxRepliesPerTaskPerTick = Math.max(
    1,
    Math.trunc(deps.maxRepliesPerTaskPerTick ?? DEFAULT_MAX_REPLIES_PER_TASK_PER_TICK),
  );
  const contextMessageCount = Math.max(1, Math.trunc(deps.contextMessageCount ?? DEFAULT_CONTEXT_MESSAGE_COUNT));
  const emitLog = deps.emitLog ?? (() => undefined);
  const now = deps.now ?? (() => Date.now());

  // Loop prevention state (in-memory, per loop instance; no new DB columns).
  const lastReplyAtByKey = new Map<string, number>();
  const replyCountByKey = new Map<string, number>();
  const keyOf = (taskId: number, metabotId: number): string => `${taskId}:${metabotId}`;

  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  const queryNewMessages = (db: Database, groupId: string, afterId: number): GroupChatMessageRow[] =>
    mapMessageRows(db.exec(
      `SELECT id, pin_id, sender_metaid, sender_global_metaid, sender_name, content, mention
       FROM group_chat_messages
       WHERE group_id = ? AND id > ?
       ORDER BY id ASC`,
      [groupId, afterId],
    ));

  const queryRecentMessages = (db: Database, groupId: string, limit: number): GroupChatMessageRow[] => {
    const rows = mapMessageRows(db.exec(
      `SELECT id, pin_id, sender_metaid, sender_global_metaid, sender_name, content, mention
       FROM group_chat_messages
       WHERE group_id = ?
       ORDER BY id DESC LIMIT ?`,
      [groupId, limit],
    ));
    return rows.reverse();
  };

  const buildGroupLogUserMessage = (
    db: Database,
    task: GroupTask,
    triggering: GroupTaskDaemonMessage,
  ): string => {
    const recent = queryRecentMessages(db, task.groupId!, contextMessageCount);
    const lines = recent.map((row) => {
      const message = toDaemonMessage(row);
      const line = `${message.senderName}: ${message.content}`;
      return row.id === triggering.id
        ? `>>> ${line} <<< (the message you are responding to)`
        : line;
    });
    return [
      `[Group Task #${task.id} "${task.title}" — recent group log (last ${contextMessageCount} messages)]`,
      ...lines,
    ].join('\n');
  };

  const ensureTaskSession = (
    coworkStore: CoworkStore,
    task: GroupTask,
    botId: number,
    botName: string,
  ): CoworkSession => {
    const externalConversationId = `group-task:${task.id}`;
    const existing = coworkStore.getConversationMapping(CONVERSATION_CHANNEL, externalConversationId, botId);
    if (existing) {
      const session = coworkStore.getSession(existing.coworkSessionId);
      if (session) return session;
    }
    const config = coworkStore.getConfig();
    const workspaceRoot = resolveSessionWorkingDirectory(
      (config.workingDirectory ?? '').trim() || process.cwd(),
      botId,
    );
    const session = coworkStore.createSession(
      `Group Task #${task.id} (${botName})`,
      workspaceRoot,
      '',
      config.executionMode || 'local',
      [],
      botId,
      'group_task',
      null,
      null,
      null,
    );
    coworkStore.upsertConversationMapping({
      channel: CONVERSATION_CHANNEL,
      externalConversationId,
      metabotId: botId,
      coworkSessionId: session.id,
      metadataJson: JSON.stringify({ taskId: task.id, groupId: task.groupId }),
    });
    return session;
  };

  /** First URI in a [DELIVERABLE] line (metafile://…, metaapp://…, https?://…), else null. */
  const extractDeliverableUri = (content: string): string | null => {
    const match = DELIVERABLE_URI_PATTERN.exec(content);
    return match ? match[1] : null;
  };

  const inferDeliverableKind = (content: string): string => {
    if (/metafile:\/\//i.test(content)) return 'metafile';
    if (/metaapp/i.test(content)) return 'metaapp';
    if (/https?:\/\//i.test(content)) return 'url';
    return 'text';
  };

  /**
   * Protocol tags on EVERY ingested message (before/independent of reply gating):
   * - [DELIVERABLE]: record one pending deliverable row (deduped by msg_pin_id).
   * - [STATUS:EXECUTING|REVIEW]: honored only from the task chair bot; illegal
   *   transitions are silently ignored; a real transition fires emitTaskEvent.
   */
  const processMessageTags = (
    task: GroupTask,
    message: GroupTaskDaemonMessage,
    members: GroupTaskMember[],
  ): void => {
    const store = deps.getGroupTaskStore();
    const content = message.content;

    if (DELIVERABLE_TAG.test(content)) {
      const msgPinId = message.pinId;
      if (msgPinId && !store.hasDeliverableWithMsgPin(task.id, msgPinId)) {
        store.addDeliverable({
          taskId: task.id,
          msgPinId,
          authorGlobalmetaid: message.senderGlobalMetaId,
          kind: inferDeliverableKind(content),
          uri: extractDeliverableUri(content),
        });
      }
    }

    const statusMatch = STATUS_TAG.exec(content);
    if (statusMatch) {
      const chairMember = members.find((member) => member.role === 'chair');
      const chairGlobalMetaId = (chairMember?.globalmetaid ?? '').trim();
      const senderGlobalMetaId = (message.senderGlobalMetaId ?? '').trim();
      if (chairGlobalMetaId && senderGlobalMetaId && senderGlobalMetaId === chairGlobalMetaId) {
        const nextStatus = statusMatch[1].toLowerCase() as 'executing' | 'review';
        try {
          const beforeStatus = store.getTaskById(task.id)?.status;
          const updated = store.updateTaskStatus(task.id, nextStatus);
          if (beforeStatus && updated.status !== beforeStatus) {
            deps.emitTaskEvent?.({
              type: 'groupTask:statusChanged',
              taskId: task.id,
              status: updated.status,
              at: now(),
            });
          }
        } catch {
          // Illegal transition (e.g. backwards or from terminal): silently ignored.
        }
      }
    }
  };

  const generateAndSendReply = async (
    task: GroupTask,
    member: GroupTaskMember,
    bot: GroupTaskDaemonBotFull,
    message: GroupTaskDaemonMessage,
    promptMembers: Array<{ name: string; role: 'chair' | 'worker' }>,
  ): Promise<void> => {
    const db = deps.getStore().getDatabase();
    const coworkStore = deps.getCoworkStore();

    const baseSystemPrompt = buildGroupTaskSystemPrompt({
      metabot: bot,
      task: {
        title: task.title,
        goal: task.goal,
        acceptanceCriteria: task.acceptanceCriteria,
      },
      members: promptMembers,
      botRole: member.role,
    });
    const userMessage = buildGroupLogUserMessage(db, task, message);

    // Skill routing (mirrors privateChatDaemon): when the bot has chat skills enabled
    // and routing hits, run one skill turn in the existing metaweb_group_task session;
    // otherwise fall back to the plain completion path.
    let routing: { prompt: string | null; activeSkillIds: string[] } = { prompt: null, activeSkillIds: [] };
    if (deps.getChatSkillsRoutingPrompt && deps.runSkillTurn) {
      try {
        const senderGlobalMetaId = (message.senderGlobalMetaId ?? '').trim();
        const bossGlobalMetaId = (bot.boss_global_metaid ?? '').trim();
        routing = await deps.getChatSkillsRoutingPrompt({
          allowChatSkills: bot.allow_chat_skills ?? [],
          allowAllEnabled: Boolean(
            senderGlobalMetaId && bossGlobalMetaId && senderGlobalMetaId === bossGlobalMetaId,
          ),
        });
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: skill routing failed for bot ${bot.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const canRunSkillTurn = Boolean(
      routing.prompt && routing.activeSkillIds.length > 0 && deps.runSkillTurn,
    );

    const session = ensureTaskSession(coworkStore, task, bot.id, bot.name);
    coworkStore.addMessage(session.id, { type: 'user', content: userMessage });

    let reply = '';
    if (canRunSkillTurn) {
      const skillSystemPrompt = [
        baseSystemPrompt,
        '',
        routing.prompt!,
        '',
        'After using Read/Bash to run a skill, reply concisely in the group. Do not paste full skill logs.',
      ].join('\n');
      const skillTurnResult = await deps.runSkillTurn!({
        sessionId: session.id,
        systemPrompt: skillSystemPrompt,
        userMessage,
        activeSkillIds: routing.activeSkillIds,
      });
      reply = (skillTurnResult.replyText ?? '').trim();
      // The runner appends the assistant message to the session itself.
    } else {
      const llmId = normalizeMetabotLlmId(bot.llm_id) ?? undefined;
      const fallbackLlmId = normalizeMetabotLlmId(bot.fallback_llm_id);
      reply = (await deps.performChat(baseSystemPrompt, userMessage, llmId, { fallbackLlmId })).trim();
      if (reply) {
        coworkStore.addMessage(session.id, { type: 'assistant', content: reply });
      }
    }
    if (!reply) return;

    // [NO_REPLY] escape hatch: the model opted to stay silent. The assistant
    // message is already in the session (context continuity) and cooldown/budget
    // is still recorded by the caller; only the on-chain send is suppressed.
    if (NO_REPLY_PATTERN.test(reply)) {
      emitLog(
        `[GroupTaskDaemon] Task ${task.id}: bot ${bot.id} answered [NO_REPLY]; ` +
        'on-chain send suppressed (debug)',
      );
      return;
    }

    try {
      await deps.postGroupTaskMessage(task.id, bot.id, reply);
    } catch (error) {
      emitLog(
        `[GroupTaskDaemon] Send failed (task ${task.id}, bot ${bot.id}): ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const processTask = async (task: GroupTask): Promise<void> => {
    if (!task.groupId) return;
    const store = deps.getGroupTaskStore();
    const db = deps.getStore().getDatabase();

    const rows = queryNewMessages(db, task.groupId, task.lastProcessedMsgId);
    if (rows.length === 0) return;

    const members = store.listMembers(task.id);
    const metabotStore = deps.getMetabotStore();
    const botsById = new Map<number, GroupTaskDaemonBotFull>();
    for (const member of members) {
      if (member.metabotId == null) continue;
      const bot = metabotStore.getMetabotById(member.metabotId);
      if (bot) botsById.set(member.metabotId, bot);
    }
    const promptMembers = members
      .filter((member) => member.metabotId != null)
      .map((member) => ({
        name: member.name ?? botsById.get(member.metabotId!)?.name ?? `bot-${member.metabotId}`,
        role: member.role,
      }));

    let workerRepliesThisTick = 0;

    for (const row of rows) {
      const message = toDaemonMessage(row);
      try {
        processMessageTags(task, message, members);
        // A [STATUS:...] tag on THIS message may have flipped the task status
        // (e.g. chair posted [STATUS:REVIEW]); gate with the fresh status, not
        // the tick-start snapshot.
        const freshStatus = store.getTaskById(task.id)?.status ?? task.status;
        const gatingTask = freshStatus === task.status ? task : { ...task, status: freshStatus };
        const decisions = decideGroupTaskResponders(message, gatingTask, members, botsById);
        for (const decision of decisions) {
          const member = members.find((candidate) => candidate.metabotId === decision.metabotId);
          const bot = botsById.get(decision.metabotId);
          if (!member || !bot) continue;
          const isChair = member.role === 'chair';
          const key = keyOf(task.id, decision.metabotId);

          if (!isChair && workerRepliesThisTick >= maxRepliesPerTaskPerTick) {
            emitLog(`[GroupTaskDaemon] Task ${task.id}: per-tick reply cap reached; skipping bot ${decision.metabotId}`);
            continue;
          }
          const lastReplyAt = lastReplyAtByKey.get(key) ?? 0;
          const cooldownMs = isChair ? chairCooldownMs : workerCooldownMs;
          if (now() - lastReplyAt < cooldownMs) {
            emitLog(`[GroupTaskDaemon] Task ${task.id}: bot ${decision.metabotId} in cooldown; skipping`);
            continue;
          }
          if ((replyCountByKey.get(key) ?? 0) >= replyBudget) {
            emitLog(`[GroupTaskDaemon] Task ${task.id}: bot ${decision.metabotId} reply budget exhausted; skipping`);
            continue;
          }

          await generateAndSendReply(task, member, bot, message, promptMembers);
          lastReplyAtByKey.set(key, now());
          replyCountByKey.set(key, (replyCountByKey.get(key) ?? 0) + 1);
          if (!isChair) workerRepliesThisTick += 1;
        }
      } catch (error) {
        // One bad message must never stall the cursor or the tick.
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: message ${message.id} failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        store.updateLastProcessedMsgId(task.id, message.id);
      }
    }
  };

  const runTick = async (): Promise<void> => {
    const store = deps.getGroupTaskStore();
    const activeTasks = store
      .listTasks()
      .filter((task) => task.status === 'planning' || task.status === 'executing' || task.status === 'review');
    for (const task of activeTasks) {
      try {
        await processTask(task);
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id} tick failed: ` +
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
        emitLog(`[GroupTaskDaemon] Tick failed: ${error instanceof Error ? error.message : String(error)}`);
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

let activeDaemonLoop: GroupTaskDaemonLoop | null = null;

export function startGroupTaskDaemon(deps: GroupTaskDaemonDeps): void {
  stopGroupTaskDaemon();
  activeDaemonLoop = createGroupTaskDaemonLoop(deps);
  activeDaemonLoop.start();
}

export function stopGroupTaskDaemon(): void {
  activeDaemonLoop?.stop();
  activeDaemonLoop = null;
}

export function isGroupTaskDaemonRunning(): boolean {
  return Boolean(activeDaemonLoop?.isRunning());
}
