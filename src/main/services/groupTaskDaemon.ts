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
import type { GroupTaskOrchestrationBridge } from './groupTaskOrchestrationBridge';
import {
  buildExperiencePromptBlocksXml,
  RECENT_SUMMARIES_PROMPT_DAYS,
} from '../libs/experiencePromptBlocks';

const CONVERSATION_CHANNEL = 'metaweb_group_task';
const DELIVERABLE_TAG = /\[DELIVERABLE\]/i;
const STATUS_TAG = /\[STATUS:\s*(EXECUTING|REVIEW)\s*\]/i;
const DELIVERABLE_URI_PATTERN = /(metafile:\/\/[^\s]+|metaapp:\/\/[^\s]+|https?:\/\/[^\s]+)/i;
/** Escape hatch: a reply starting with the [NO_REPLY] tag is suppressed (not sent on-chain). */
const NO_REPLY_PATTERN = /^\[NO_REPLY\]/i;

const CHAIR_PLANNED_KV_PREFIX = 'group_task_chair_planned:';
const CHAIR_PLAN_ATTEMPTS_KV_PREFIX = 'group_task_chair_plan_attempts:';
const MAX_CHAIR_PLAN_ATTEMPTS = 3;

const OWNER_REPORTED_KV_PREFIX = 'group_task_owner_reported:';

/** Deliverable verification: strict formats (lowercase hex only). */
const PINID_FORMAT = /^[0-9a-f]{64}i0$/;
const TXID_FORMAT = /^[0-9a-f]{64}$/;
/** Plausible pinid/txid candidates in a [DELIVERABLE] line (incl. 0x-prefixed fakes). */
const DELIVERABLE_ID_CANDIDATE = /\b(?:0[xX][0-9a-fA-F]{2,66}|[0-9a-fA-F]{16,66}(?:i0)?)\b/g;
const MAX_VERIFICATION_CANDIDATES = 3;

/** Hard cap for the appended A2A experience/memory block. */
const EXPERIENCE_BLOCK_MAX_CHARS = 1500;

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

/** Prompt roster entry (structurally matches GroupTaskPromptMember). */
type DaemonPromptMember = {
  name: string;
  role: 'chair' | 'worker';
  bio?: string | null;
  roleProfile?: string | null;
  goal?: string | null;
};

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
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
  delete(key: string): void;
}

export type GroupTaskDaemonPerformChatFn = (
  systemPrompt: string,
  userMessage: string,
  llmId?: string | null,
  options?: { fallbackLlmId?: string | null; thinking?: 'enabled' | 'disabled' },
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

export type GroupTaskDaemonTaskEvent =
  | {
    type: 'groupTask:statusChanged';
    taskId: number;
    status: string;
    at: number;
  }
  | {
    type: 'groupTask:ownerReportDelivery';
    taskId: number;
    outcome: 'sent' | 'failed';
    pinId?: string | null;
    sessionId?: string | null;
    displayError?: string | null;
    error?: string | null;
    at: number;
  };

/** On-chain existence check for deliverable verification (main.ts wires getPinData). */
export type GroupTaskDaemonReadPinFn = (
  pinId: string,
) => Promise<'found' | 'not_found' | 'unavailable'>;

/** Private A2A report from the chair bot to the owner (encrypted simplemsg in main.ts). */
export interface GroupTaskOwnerReportDeliveryResult {
  pinId?: string | null;
  sessionId?: string | null;
  displayError?: string | null;
}

export type GroupTaskDaemonSendOwnerReportFn = (params: {
  taskId: number;
  metabotId: number;
  ownerGlobalMetaId: string;
  text: string;
}) => Promise<GroupTaskOwnerReportDeliveryResult>;

/** Narrow memory read (owner scope, created status) for the A2A experience block. */
export type GroupTaskDaemonListUserMemoriesFn = (
  metabotId: number,
  input: { usageClass: 'self_identity' | 'value_boundary'; limit: number },
) => Array<{ text: string }>;

/** Recent dream summaries for the A2A experience block. */
export type GroupTaskDaemonListDailySummariesFn = (
  metabotId: number,
  limit: number,
) => Array<{ summaryDate: string; summaryText: string }>;

export interface GroupTaskDaemonDeps {
  getStore: () => GroupTaskDaemonSqliteStoreLike;
  getGroupTaskStore: () => GroupTaskStore;
  getMetabotStore: () => MetabotStore;
  getCoworkStore: () => CoworkStore;
  orchestrationBridge?: GroupTaskOrchestrationBridge;
  performChat: GroupTaskDaemonPerformChatFn;
  postGroupTaskMessage: GroupTaskDaemonSendFn;
  getChatSkillsRoutingPrompt?: GroupTaskDaemonSkillRoutingFn;
  runSkillTurn?: GroupTaskDaemonRunSkillTurnFn;
  emitTaskEvent?: (payload: GroupTaskDaemonTaskEvent) => void;
  readPinForVerification?: GroupTaskDaemonReadPinFn;
  sendOwnerPrivateReport?: GroupTaskDaemonSendOwnerReportFn;
  listUserMemories?: GroupTaskDaemonListUserMemoriesFn;
  listDailySummaries?: GroupTaskDaemonListDailySummariesFn;
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
   * Unambiguous per-turn local time line (mirrors coworkRunner's Local Time
   * Context intent): local datetime, UTC offset, host timezone, and the long date.
   */
  const formatTurnTimeText = (): string => {
    const date = new Date(now());
    const pad = (value: number): string => String(value).padStart(2, '0');
    const local = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const utcOffset = `${sign}${Math.floor(Math.abs(offsetMinutes) / 60)}`;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
    const weekday = date.toLocaleDateString('en-US', { weekday: 'long' });
    const longDate = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    return `Current time: ${local} (UTC${utcOffset}, ${timezone}); today is ${weekday}, ${longDate}.`;
  };

  /**
   * A2A experience/memory block for the responding bot, built with the SAME
   * exported builder the private-chat path uses (buildExperiencePromptBlocksXml)
   * fed through narrow injected memory/dream getters. '' when unwired or empty.
   */
  const buildExperienceBlockFor = (bot: GroupTaskDaemonBotFull): string => {
    if (!deps.listUserMemories && !deps.listDailySummaries) return '';
    try {
      const identityEntry = deps.listUserMemories?.(bot.id, { usageClass: 'self_identity', limit: 1 })?.[0];
      const valueBoundaries = deps.listUserMemories?.(bot.id, { usageClass: 'value_boundary', limit: 5 }) ?? [];
      const summaries = deps.listDailySummaries?.(bot.id, RECENT_SUMMARIES_PROMPT_DAYS) ?? [];
      const block = buildExperiencePromptBlocksXml({
        identityText: identityEntry?.text ?? null,
        valueBoundaries,
        summaries,
      }).trim();
      if (!block) return '';
      return block.length > EXPERIENCE_BLOCK_MAX_CHARS
        ? `${block.slice(0, EXPERIENCE_BLOCK_MAX_CHARS)}…`
        : block;
    } catch {
      return '';
    }
  };

  /** Full per-turn system prompt: base + fresh time line + experience block. */
  const buildTurnSystemPrompt = (
    bot: GroupTaskDaemonBotFull,
    task: GroupTask,
    promptMembers: DaemonPromptMember[],
    botRole: 'chair' | 'worker',
    ownerGlobalMetaId: string,
  ): string => {
    return buildGroupTaskSystemPrompt({
      metabot: bot,
      task: {
        title: task.title,
        goal: task.goal,
        acceptanceCriteria: task.acceptanceCriteria,
      },
      members: promptMembers,
      botRole,
      ownerGlobalMetaId: ownerGlobalMetaId || null,
      currentTimeText: formatTurnTimeText(),
      experienceBlock: buildExperienceBlockFor(bot),
    });
  };

  /** Plausible pinid/txid candidates in a [DELIVERABLE] line (deduped, capped). */
  const extractIdCandidates = (content: string): string[] => {
    const matches = content.match(DELIVERABLE_ID_CANDIDATE) ?? [];
    return [...new Set(matches)].slice(0, MAX_VERIFICATION_CANDIDATES);
  };

  /**
   * Deliverable verification hints: format-check any pinid/txid-looking token,
   * then (when wired) an on-chain existence check via getPinData. The notes are
   * appended to the chair's context so it verifies before accepting.
   */
  const verifyDeliverableCandidates = async (content: string): Promise<string[]> => {
    const candidates = extractIdCandidates(content);
    if (candidates.length === 0) return [];
    const notes: string[] = [];
    for (const token of candidates) {
      const display = token.length > 16 ? `${token.slice(0, 12)}…` : token;
      const isPinid = PINID_FORMAT.test(token);
      const isTxid = TXID_FORMAT.test(token);
      if (!isPinid && !isTxid) {
        notes.push(
          `⚠ Host verification: reported pinid "${display}" FAILS format validation ` +
          '(expected 64 lowercase hex + i0).',
        );
        continue;
      }
      const label = isPinid ? 'pinid' : 'txid';
      if (!deps.readPinForVerification) {
        notes.push(`… Host verification: ${label} format valid; on-chain check unavailable.`);
        continue;
      }
      try {
        const outcome = await deps.readPinForVerification(isPinid ? token : `${token}i0`);
        if (outcome === 'found') {
          notes.push(`✓ Host verification: ${label} format valid; pin found on-chain (via getPinData/manapi).`);
        } else if (outcome === 'not_found') {
          notes.push(`⚠ Host verification: ${label} format valid but pin NOT found on-chain (via getPinData/manapi).`);
        } else {
          notes.push(`… Host verification: ${label} format valid; on-chain check unavailable.`);
        }
      } catch {
        notes.push(`… Host verification: ${label} format valid; on-chain check unavailable.`);
      }
    }
    return notes;
  };

  /** System-generated owner-report directive for the review transition. */
  const buildOwnerReportDirective = (store: GroupTaskStore, task: GroupTask): string => {
    const deliverables = store.listDeliverables(task.id);
    const deliverableLines = deliverables.map(
      (deliverable) =>
        `- [${deliverable.kind ?? 'text'}] ${deliverable.uri ?? '(no uri)'} (status: ${deliverable.status})`,
    );
    return [
      '[SYSTEM owner-report directive — generated by the host, not by a group participant]',
      `The group task "${task.title}" just moved to REVIEW. Compose a concise PRIVATE report to the owner covering:`,
      '- The task goal (restated briefly).',
      '- What each member did (by name).',
      '- Deliverables with pinids/URLs and any verification outcomes you are aware of.',
      '- What the owner should decide now: accept & close, or request rework (and of what).',
      '',
      `Goal: ${task.goal}`,
      `Acceptance criteria: ${task.acceptanceCriteria?.trim() || '(none specified)'}`,
      'Deliverables recorded:',
      ...(deliverableLines.length > 0 ? deliverableLines : ['(none recorded)']),
    ].join('\n');
  };

  /**
   * Owner report on review: one private A2A report from the chair to the owner
   * per task per review-entry (kv guard group_task_owner_reported:<taskId>;
   * cleared when the task re-enters executing via the rework hatch). The report
   * is never posted to the group; failures only log, never block the tick.
   */
  const maybeSendOwnerReport = async (
    task: GroupTask,
    members: GroupTaskMember[],
    botsById: Map<number, GroupTaskDaemonBotFull>,
    promptMembers: DaemonPromptMember[],
  ): Promise<void> => {
    if (!deps.sendOwnerPrivateReport) {
      deps.emitTaskEvent?.({
        type: 'groupTask:ownerReportDelivery',
        taskId: task.id,
        outcome: 'failed',
        error: 'owner report transport unavailable',
        at: now(),
      });
      return;
    }
    const sqlite = deps.getStore();
    const guardKey = `${OWNER_REPORTED_KV_PREFIX}${task.id}`;
    if (sqlite.get<string>(guardKey) === '1') return;

    const chairMember = members.find((member) => member.role === 'chair');
    const bot = chairMember?.metabotId != null ? botsById.get(chairMember.metabotId) : undefined;
    const ownerGlobalMetaId = (bot?.boss_global_metaid ?? '').trim();
    if (!chairMember || !bot || !ownerGlobalMetaId) {
      const error = 'chair bot or owner GlobalMetaID unavailable';
      emitLog(`[GroupTaskDaemon] Task ${task.id}: owner report skipped (${error})`);
      deps.emitTaskEvent?.({
        type: 'groupTask:ownerReportDelivery',
        taskId: task.id,
        outcome: 'failed',
        error,
        at: now(),
      });
      return;
    }

    try {
      const store = deps.getGroupTaskStore();
      const coworkStore = deps.getCoworkStore();
      const systemPrompt = buildTurnSystemPrompt(bot, task, promptMembers, 'chair', ownerGlobalMetaId);
      const directive = buildOwnerReportDirective(store, task);
      const llmId = normalizeMetabotLlmId(bot.llm_id) ?? undefined;
      const fallbackLlmId = normalizeMetabotLlmId(bot.fallback_llm_id);
      const report = (await deps.performChat(systemPrompt, directive, llmId, { fallbackLlmId, thinking: 'enabled' })).trim();
      if (!report || NO_REPLY_PATTERN.test(report)) {
        throw new Error('owner report turn produced no report');
      }
      const delivery = await deps.sendOwnerPrivateReport({
        taskId: task.id,
        metabotId: bot.id,
        ownerGlobalMetaId,
        text: report,
      });
      sqlite.set(guardKey, '1');
      deps.emitTaskEvent?.({
        type: 'groupTask:ownerReportDelivery',
        taskId: task.id,
        outcome: 'sent',
        pinId: delivery.pinId ?? null,
        sessionId: delivery.sessionId ?? null,
        displayError: delivery.displayError ?? null,
        at: now(),
      });
      // Record the private report in the chair's own group-task session (context
      // continuity), clearly marked as private — never posted to the group.
      const session = ensureTaskSession(coworkStore, task, bot.id, bot.name);
      coworkStore.addMessage(session.id, {
        type: 'assistant',
        content: `[Private report sent to the owner — not posted to the group]\n${report}`,
      });
      emitLog(`[GroupTaskDaemon] Task ${task.id}: owner report sent privately to the owner`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      emitLog(
        `[GroupTaskDaemon] Task ${task.id}: owner report failed (tick continues): ` +
        errorMessage,
      );
      deps.emitTaskEvent?.({
        type: 'groupTask:ownerReportDelivery',
        taskId: task.id,
        outcome: 'failed',
        error: errorMessage,
        at: now(),
      });
    }
  };

  /**
   * Protocol tags on EVERY ingested message (before/independent of reply gating):
   * - [DELIVERABLE]: record one pending deliverable row (deduped by msg_pin_id)
   *   and compute host verification notes for the chair.
   * - [STATUS:EXECUTING|REVIEW]: honored only from the task chair bot; illegal
   *   transitions are silently ignored; a real transition fires emitTaskEvent,
   *   entering review triggers the owner report, re-entering executing clears it.
   * Returns the verification notes for this message (empty when none).
   */
  const processMessageTags = async (
    task: GroupTask,
    message: GroupTaskDaemonMessage,
    members: GroupTaskMember[],
    botsById: Map<number, GroupTaskDaemonBotFull>,
    promptMembers: DaemonPromptMember[],
  ): Promise<string[]> => {
    const store = deps.getGroupTaskStore();
    const content = message.content;
    let verificationNotes: string[] = [];

    if (DELIVERABLE_TAG.test(content)) {
      const msgPinId = message.pinId;
      let recordedDeliverable = msgPinId
        ? store.listDeliverables(task.id).find((deliverable) => deliverable.msgPinId === msgPinId)
        : undefined;
      if (msgPinId && !store.hasDeliverableWithMsgPin(task.id, msgPinId)) {
        recordedDeliverable = store.addDeliverable({
          taskId: task.id,
          msgPinId,
          authorGlobalmetaid: message.senderGlobalMetaId,
          kind: inferDeliverableKind(content),
          uri: extractDeliverableUri(content),
        });
      }
      try {
        verificationNotes = await verifyDeliverableCandidates(content);
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: deliverable verification failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (recordedDeliverable && deps.orchestrationBridge) {
        try {
          deps.orchestrationBridge.recordDeliverable({
            groupTaskId: task.id,
            deliverable: recordedDeliverable,
            verificationNotes,
          });
        } catch (error) {
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: canonical deliverable projection failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          );
        }
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
            try {
              deps.orchestrationBridge?.syncStatus(task.id);
            } catch (error) {
              emitLog(
                `[GroupTaskDaemon] Task ${task.id}: canonical status projection failed: ` +
                `${error instanceof Error ? error.message : String(error)}`,
              );
            }
            deps.emitTaskEvent?.({
              type: 'groupTask:statusChanged',
              taskId: task.id,
              status: updated.status,
              at: now(),
            });
            if (updated.status === 'executing' && beforeStatus === 'review') {
              // Rework hatch: the next review must report to the owner again.
              deps.getStore().delete(`${OWNER_REPORTED_KV_PREFIX}${task.id}`);
            }
            if (updated.status === 'review') {
              await maybeSendOwnerReport(task, members, botsById, promptMembers);
            }
          }
        } catch {
          // Illegal transition (e.g. backwards or from terminal): silently ignored.
        }
      }
    }

    return verificationNotes;
  };

  /** System-generated planning directive for the chair planning turn. */
  const buildPlanningDirective = (db: Database, task: GroupTask): string => {
    const recent = queryRecentMessages(db, task.groupId!, contextMessageCount);
    const logLines = recent.map((row) => {
      const message = toDaemonMessage(row);
      return `${message.senderName}: ${message.content}`;
    });
    return [
      '[SYSTEM planning directive — generated by the host, not by a group participant]',
      'The group task has just been created. As the chair, post the task plan to the group NOW, in one message:',
      '(a) Decompose the goal into concrete subtasks.',
      '(b) Assign each subtask to the SINGLE most suitable member BY NAME based on the roster profiles (never assign the same work to everyone).',
      '(c) State the sequence/dependencies and @-mention ONLY the members who should act NOW (later steps get assigned when their inputs arrive, e.g. after a [DELIVERABLE]).',
      '(d) End the message with [STATUS:EXECUTING].',
      '',
      `[Group Task #${task.id} "${task.title}" — recent group log (last ${contextMessageCount} messages)]`,
      ...(logLines.length > 0 ? logLines : ['(no messages yet)']),
    ].join('\n');
  };

  /**
   * Chair planning turn: exactly one per task, attempted while the task is in
   * 'planning'. The chair decomposes the goal into sequenced sub-assignments and
   * posts the plan (ending with [STATUS:EXECUTING], which the tag parser picks up
   * when the message round-trips through the listener). kv keys:
   * group_task_chair_planned:<taskId> = '1' once posted;
   * group_task_chair_plan_attempts:<taskId> = failure counter (gives up after 3).
   * Does NOT consume the chair's reply budget/cooldown.
   */
  const maybeRunChairPlanningTurn = async (
    task: GroupTask,
    members: GroupTaskMember[],
    botsById: Map<number, GroupTaskDaemonBotFull>,
    promptMembers: DaemonPromptMember[],
  ): Promise<void> => {
    const sqlite = deps.getStore();
    const plannedKey = `${CHAIR_PLANNED_KV_PREFIX}${task.id}`;
    if (sqlite.get<string>(plannedKey) === '1') return;
    const attemptsKey = `${CHAIR_PLAN_ATTEMPTS_KV_PREFIX}${task.id}`;
    const attempts = Number(sqlite.get<number>(attemptsKey) ?? 0) || 0;
    if (attempts >= MAX_CHAIR_PLAN_ATTEMPTS) return;

    const chairMember = members.find((member) => member.role === 'chair');
    const bot = chairMember?.metabotId != null ? botsById.get(chairMember.metabotId) : undefined;
    if (!chairMember || !bot) {
      emitLog(`[GroupTaskDaemon] Task ${task.id}: planning turn skipped (no chair bot found)`);
      return;
    }

    try {
      const db = sqlite.getDatabase();
      const coworkStore = deps.getCoworkStore();
      const ownerGlobalMetaId = (bot.boss_global_metaid ?? '').trim();
      const systemPrompt = buildTurnSystemPrompt(bot, task, promptMembers, 'chair', ownerGlobalMetaId);
      const directive = buildPlanningDirective(db, task);
      const llmId = normalizeMetabotLlmId(bot.llm_id) ?? undefined;
      const fallbackLlmId = normalizeMetabotLlmId(bot.fallback_llm_id);
      // Plain LLM path: the chair is planning here, not executing skills.
      const reply = (await deps.performChat(systemPrompt, directive, llmId, { fallbackLlmId, thinking: 'enabled' })).trim();
      if (!reply || NO_REPLY_PATTERN.test(reply)) {
        throw new Error('planning turn produced no usable plan');
      }
      const session = ensureTaskSession(coworkStore, task, bot.id, bot.name);
      coworkStore.addMessage(session.id, { type: 'user', content: directive });
      coworkStore.addMessage(session.id, { type: 'assistant', content: reply });
      await deps.postGroupTaskMessage(task.id, bot.id, reply);
      sqlite.set(plannedKey, '1');
      emitLog(`[GroupTaskDaemon] Task ${task.id}: chair planning turn posted`);
    } catch (error) {
      const nextAttempts = attempts + 1;
      sqlite.set(attemptsKey, nextAttempts);
      if (nextAttempts >= MAX_CHAIR_PLAN_ATTEMPTS) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: chair planning turn failed ${nextAttempts} time(s), giving up: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      } else {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: chair planning turn failed (attempt ${nextAttempts}/${MAX_CHAIR_PLAN_ATTEMPTS}): ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  const generateAndSendReply = async (
    task: GroupTask,
    member: GroupTaskMember,
    bot: GroupTaskDaemonBotFull,
    message: GroupTaskDaemonMessage,
    promptMembers: DaemonPromptMember[],
    chairGlobalMetaId: string,
    ownerGlobalMetaId: string,
    verificationNotes: string[],
  ): Promise<void> => {
    const db = deps.getStore().getDatabase();
    const coworkStore = deps.getCoworkStore();

    const baseSystemPrompt = buildTurnSystemPrompt(bot, task, promptMembers, member.role, ownerGlobalMetaId);
    let userMessage = buildGroupLogUserMessage(db, task, message);
    if (verificationNotes.length > 0) {
      // Host deliverable-verification facts accompany the chair's context.
      userMessage = `${userMessage}\n${verificationNotes.join('\n')}`;
    }

    // Skill routing (mirrors privateChatDaemon): when the bot has chat skills enabled
    // and routing hits, run one skill turn in the existing metaweb_group_task session;
    // otherwise fall back to the plain completion path.
    let routing: { prompt: string | null; activeSkillIds: string[] } = { prompt: null, activeSkillIds: [] };
    if (deps.getChatSkillsRoutingPrompt && deps.runSkillTurn) {
      try {
        const senderGlobalMetaId = (message.senderGlobalMetaId ?? '').trim();
        const bossGlobalMetaId = (bot.boss_global_metaid ?? '').trim();
        // Trust the owner AND the chair: the twin chairs on the owner's behalf, so
        // its assignments unlock the worker's full enabled skill set (routing still
        // decides WHICH skills; no routing hit -> plain path remains).
        const senderIsBoss = Boolean(
          senderGlobalMetaId && bossGlobalMetaId && senderGlobalMetaId === bossGlobalMetaId,
        );
        const senderIsChair = Boolean(
          senderGlobalMetaId && chairGlobalMetaId && senderGlobalMetaId === chairGlobalMetaId,
        );
        routing = await deps.getChatSkillsRoutingPrompt({
          allowChatSkills: bot.allow_chat_skills ?? [],
          allowAllEnabled: senderIsBoss || senderIsChair,
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
    let orchestrationAttemptId: string | null = null;
    if (member.role === 'worker' && deps.orchestrationBridge) {
      try {
        const context = deps.orchestrationBridge.beginWorkerAttempt({
          groupTaskId: task.id,
          workerMetabotId: bot.id,
          objective: message.content,
          sourceMessageKey: message.pinId ?? String(message.id),
        });
        orchestrationAttemptId = context.attempt.id;
        deps.orchestrationBridge.markWorkerAttemptRunning(context.attempt.id, session.id);
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: canonical Worker attempt start failed for bot ${bot.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const failCanonicalAttempt = (error: unknown): void => {
      if (!orchestrationAttemptId || !deps.orchestrationBridge) return;
      deps.orchestrationBridge.failWorkerAttempt(
        orchestrationAttemptId,
        error instanceof Error ? error.message : String(error),
      );
    };
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
      let skillTurnResult;
      try {
        skillTurnResult = await deps.runSkillTurn!({
          sessionId: session.id,
          systemPrompt: skillSystemPrompt,
          userMessage,
          activeSkillIds: routing.activeSkillIds,
        });
      } catch (error) {
        failCanonicalAttempt(error);
        throw error;
      }
      reply = (skillTurnResult.replyText ?? '').trim();
      // The runner appends the assistant message to the session itself.
    } else {
      const llmId = normalizeMetabotLlmId(bot.llm_id) ?? undefined;
      const fallbackLlmId = normalizeMetabotLlmId(bot.fallback_llm_id);
      try {
        reply = (await deps.performChat(baseSystemPrompt, userMessage, llmId, { fallbackLlmId, thinking: 'enabled' })).trim();
      } catch (error) {
        failCanonicalAttempt(error);
        throw error;
      }
      if (reply) {
        coworkStore.addMessage(session.id, { type: 'assistant', content: reply });
      }
    }
    if (!reply) {
      failCanonicalAttempt('WORKER_EMPTY_HANDOFF');
      return;
    }

    // [NO_REPLY] escape hatch: the model opted to stay silent. The assistant
    // message is already in the session (context continuity) and cooldown/budget
    // is still recorded by the caller; only the on-chain send is suppressed.
    if (NO_REPLY_PATTERN.test(reply)) {
      failCanonicalAttempt('WORKER_NO_REPLY');
      emitLog(
        `[GroupTaskDaemon] Task ${task.id}: bot ${bot.id} answered [NO_REPLY]; ` +
        'on-chain send suppressed (debug)',
      );
      return;
    }

    let sent: { pinId: string };
    try {
      sent = await deps.postGroupTaskMessage(task.id, bot.id, reply);
    } catch (error) {
      failCanonicalAttempt(error);
      emitLog(
        `[GroupTaskDaemon] Send failed (task ${task.id}, bot ${bot.id}): ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (orchestrationAttemptId && deps.orchestrationBridge) {
      try {
        deps.orchestrationBridge.completeWorkerAttempt({
          attemptId: orchestrationAttemptId,
          replyText: reply,
          groupMessagePinId: sent.pinId,
        });
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: Worker reply was sent but canonical completion failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  const processTask = async (task: GroupTask): Promise<void> => {
    if (!task.groupId) return;
    const store = deps.getGroupTaskStore();
    const db = deps.getStore().getDatabase();

    if (deps.orchestrationBridge) {
      try {
        deps.orchestrationBridge.ensureCanonicalTask(task);
        deps.orchestrationBridge.syncStatus(task.id);
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: canonical reconciliation failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const members = store.listMembers(task.id);
    const metabotStore = deps.getMetabotStore();
    const botsById = new Map<number, GroupTaskDaemonBotFull>();
    for (const member of members) {
      if (member.metabotId == null) continue;
      const bot = metabotStore.getMetabotById(member.metabotId);
      if (bot) botsById.set(member.metabotId, bot);
    }
    const promptMembers: DaemonPromptMember[] = members
      .filter((member) => member.metabotId != null)
      .map((member) => {
        const bot = botsById.get(member.metabotId!);
        return {
          name: member.name ?? bot?.name ?? `bot-${member.metabotId}`,
          role: member.role,
          bio: bot?.bio ?? bot?.background ?? null,
          roleProfile: bot?.role ?? null,
          goal: bot?.goal ?? null,
        };
      });
    const chairGlobalMetaId = (
      members.find((member) => member.role === 'chair')?.globalmetaid ?? ''
    ).trim();
    const chairMemberId = members.find((member) => member.role === 'chair')?.metabotId;
    const ownerGlobalMetaId = (
      chairMemberId != null ? botsById.get(chairMemberId)?.boss_global_metaid ?? '' : ''
    ).trim();

    // Exactly one chair planning turn per task, while it is still in 'planning'.
    if (task.status === 'planning') {
      await maybeRunChairPlanningTurn(task, members, botsById, promptMembers);
    }

    const rows = queryNewMessages(db, task.groupId, task.lastProcessedMsgId);
    if (rows.length === 0) return;

    let workerRepliesThisTick = 0;

    for (const row of rows) {
      const message = toDaemonMessage(row);
      try {
        const verificationNotes = await processMessageTags(task, message, members, botsById, promptMembers);
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

          // Verification facts travel with the deliverable that triggered the chair.
          const notesForDecision = decision.reason === 'chair_deliverable' ? verificationNotes : [];
          await generateAndSendReply(
            task,
            member,
            bot,
            message,
            promptMembers,
            chairGlobalMetaId,
            ownerGlobalMetaId,
            notesForDecision,
          );
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
