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
import type {
  GroupTaskStore,
  GroupTask,
  GroupTaskMember,
  GroupTaskDeliverable,
} from '../groupTaskStore';
import { MetaIDExperienceStore } from '../metaidExperienceStore';
import { resolveSessionWorkingDirectory } from '../libs/botWorkspace';
import { normalizeMetabotLlmId } from './llmFallback';
import { isMentioned } from './groupChatMentionUtils';
import { buildGroupTaskSystemPrompt } from './groupTaskPrompts';
import type { GroupTaskOrchestrationBridge } from './groupTaskOrchestrationBridge';
import { recordMetaIDGroupTaskExperience } from './metaidExperienceRecorder';
import {
  buildExperiencePromptBlocksXml,
  RECENT_SUMMARIES_PROMPT_DAYS,
} from '../libs/experiencePromptBlocks';
import {
  parseDeliverableLines,
  parseWorkingAck,
  hasStandbyMarker,
  isIntegrityDeclaration,
  type ParsedDeliverable,
} from './groupTaskDeliverableParser';

const CONVERSATION_CHANNEL = 'metaweb_group_task';
const DELIVERABLE_TAG = /\[DELIVERABLE\]/i;
const STATUS_TAG = /\[STATUS:\s*(EXECUTING|REVIEW)\s*\]/i;
/** Escape hatch: a reply starting with the [NO_REPLY] tag is suppressed (not sent on-chain). */
const NO_REPLY_PATTERN = /^\[NO_REPLY\]/i;

/**
 * P1-4 / round-4: lines carrying the [DELIVERABLE] protocol tag — the ONLY
 * source for deliverable URIs and kinds. Parsing is delegated to
 * groupTaskDeliverableParser (one row per tag occurrence, strict
 * placeholder/truncation filtering, 64-hex+i0 or ^https?:// validation);
 * URIs anywhere else in the message body never influence the outcome.
 */
const deliverableTagLines = (content: string): string[] =>
  content.split('\n').filter((line) => DELIVERABLE_TAG.test(line));

const CHAIR_PLANNED_KV_PREFIX = 'group_task_chair_planned:';
const CHAIR_PLAN_ATTEMPTS_KV_PREFIX = 'group_task_chair_plan_attempts:';
const MAX_CHAIR_PLAN_ATTEMPTS = 3;

const OWNER_REPORTED_KV_PREFIX = 'group_task_owner_reported:';
const ACK_PENDING_PREFIX = 'group_task_ack_pending:';
const ACK_REMINDED_PREFIX = 'group_task_ack_reminded:';
const EXPECTED_DELIVERY_PREFIX = 'group_task_expected_delivery:';
const DELIVERY_REMINDED_PREFIX = 'group_task_delivery_reminded:';
const MSG_RETRY_PREFIX = 'group_task_msg_retry:';
/** Round-4: a message failing this many consecutive ticks is dropped (cursor advances). */
const MSG_RETRY_MAX_FAILURES = 5;

/** Deliverable verification: strict formats (lowercase hex only). */
const PINID_FORMAT = /^[0-9a-f]{64}i0$/;
const TXID_FORMAT = /^[0-9a-f]{64}$/;
/** Plausible pinid/txid candidates in a [DELIVERABLE] line (incl. 0x-prefixed fakes). */
const DELIVERABLE_ID_CANDIDATE = /\b(?:0[xX][0-9a-fA-F]{2,66}|[0-9a-fA-F]{16,66}(?:i0)?)\b/g;
const MAX_VERIFICATION_CANDIDATES = 3;

/** Hard cap for the appended A2A experience/memory block. */
const EXPERIENCE_BLOCK_MAX_CHARS = 1500;
const GROUP_COGNITION_BLOCK_MAX_CHARS = 3000;

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_WORKER_COOLDOWN_MS = 20_000;
const DEFAULT_CHAIR_COOLDOWN_MS = 10_000;
/**
 * P2-7 (round 2): window (ms) in which ANY chair-bot message posted by the
 * Twin side suppresses daemon-driven chair AUTO replies (deliverable /
 * floor-control / owner-message). Covers scenarios the exact reply-pin match
 * cannot: Twin replies without a reply_pin, or Twin speech on a related but
 * different message. 0 disables the window check.
 */
const DEFAULT_CHAIR_TWIN_SUPPRESS_WINDOW_MS = 60_000;
const DEFAULT_REPLY_BUDGET = 40;
const DEFAULT_MAX_REPLIES_PER_TASK_PER_TICK = 3;
const DEFAULT_CONTEXT_MESSAGE_COUNT = 20;
/** P0-2: minutes of silence before an assigned/working member is auto-marked unreachable. */
const DEFAULT_MEMBER_UNREACHABLE_AFTER_MINUTES = 30;
/** P0-3: minutes before a missing [WORKING] ACK triggers the chair reminder. */
const DEFAULT_ACK_TIMEOUT_MS = 3 * 60_000;
/** P0-4: minutes between retries of an unverified deliverable (indexer lag). */
const DEFAULT_VERIFICATION_RETRY_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// Pure gating (exported for tests)
// ---------------------------------------------------------------------------

export interface GroupTaskDaemonMessage {
  id: number;
  pinId: string | null;
  txId?: string | null;
  senderMetaId: string;
  senderGlobalMetaId: string | null;
  senderName: string;
  content: string;
  chainTimestamp?: number | null;
  replyPin?: string | null;
  /** Raw mention column (JSON array string). */
  mention: string | null;
  /**
   * Round-4 attribution: true when the chain-signature GlobalMetaID is missing
   * or is neither a task member nor the owner. Such messages must never be
   * attributed by senderName, never trigger replies, and never contribute
   * deliverables.
   */
  senderSuspect?: boolean;
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
  globalMetaId?: string | null;
  bio?: string | null;
  roleProfile?: string | null;
  goal?: string | null;
  /** OpenTeam remote teammate: no local bot row; replies come from its own machine. */
  remote?: boolean;
};

// Mention gating (contentMentionsBotName / mentionContainsMetaId / isMentioned)
// lives in groupChatMentionUtils.ts, shared with the OpenTeam guest daemon.

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
  // Round-4 attribution: a SUSPECT sender (chain GlobalMetaID neither a task
  // member nor the owner) never triggers replies. The owner is exempt from the
  // suspect flag, so owner messages still reach the chair.
  if (message.senderSuspect) return decisions;
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

export interface PlanningCoverage {
  ok: boolean;
  /** Worker names mentioned/assigned in the plan text. */
  mentionedWorkers: string[];
  /** Worker names NOT mentioned at all. */
  unmentionedWorkers: string[];
}

/**
 * C-1 defensive check: the chair's auto plan must not concentrate every
 * subtask on a single member when 2+ workers are on the roster. A worker is
 * considered "assigned" when the plan text mentions its name (with or without
 * @). Pure + exported for unit tests.
 */
export function checkPlanningCoverage(reply: string, workerNames: string[]): PlanningCoverage {
  const text = String(reply ?? '');
  const mentioned = workerNames.filter((name) => {
    const trimmed = name.trim();
    if (!trimmed) return false;
    return text.includes(trimmed) || text.includes(`@${trimmed}`);
  });
  const unmentioned = workerNames.filter((name) => !mentioned.includes(name));
  const ok = workerNames.length < 2 || mentioned.length >= 2;
  return { ok, mentionedWorkers: mentioned, unmentionedWorkers: unmentioned };
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
  input: { usageClass: 'self_identity' | 'value_boundary' | 'work_review'; limit: number },
) => Array<{ text: string }>;

/** Recent dream summaries for the A2A experience block. */
export type GroupTaskDaemonListDailySummariesFn = (
  metabotId: number,
  limit: number,
) => Array<{ summaryDate: string; summaryText: string }>;

/**
 * Round-4 attribution: resolve a chain-signature LEGACY metaid to its
 * GlobalMetaID (wired to manapi /api/info/metaid/{metaid} in main.ts). The
 * chain signature is the ONLY identity source for group-task attribution;
 * null when the signature cannot be resolved (message becomes SUSPECT).
 */
export type GroupTaskDaemonResolveGlobalMetaIdFn = (
  legacyMetaId: string,
) => Promise<string | null>;

/**
 * Round-4 deliverable link probe: returns the HTTP status of a key https://
 * deliverable link (HEAD with GET fallback, ~8s bound). null = unavailable.
 * Tests inject a fake; production uses the built-in fetch probe.
 */
export type GroupTaskDaemonProbeUrlFn = (url: string) => Promise<number | null>;

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
  /** P0-4: secondary indexer (metafile-indexer) for multi-source pin verification. */
  readPinSecondaryForVerification?: GroupTaskDaemonReadPinFn;
  resolveGlobalMetaId?: GroupTaskDaemonResolveGlobalMetaIdFn;
  probeUrl?: GroupTaskDaemonProbeUrlFn;
  sendOwnerPrivateReport?: GroupTaskDaemonSendOwnerReportFn;
  listUserMemories?: GroupTaskDaemonListUserMemoriesFn;
  listDailySummaries?: GroupTaskDaemonListDailySummariesFn;
  getMetaIDGroupCognitionPromptBlock?: (input: {
    observerGlobalMetaID: string;
    roster: Array<{ globalMetaID: string | null; name: string; role: 'chair' | 'worker' }>;
  }) => string | Promise<string>;
  experienceStore?: MetaIDExperienceStore;
  emitLog?: (message: string) => void;
  now?: () => number;
  intervalMs?: number;
  workerCooldownMs?: number;
  chairCooldownMs?: number;
  replyBudget?: number;
  maxRepliesPerTaskPerTick?: number;
  contextMessageCount?: number;
  /**
   * P2-7 (round 2): window (ms) during which any Twin-side chair message
   * suppresses daemon chair AUTO replies. Defaults to
   * DEFAULT_CHAIR_TWIN_SUPPRESS_WINDOW_MS.
   */
  chairTwinSuppressWindowMs?: number;
  /**
   * P1-5 (round 2): opt-out — the Twin chair leads the group via its own
   * kickoff; the daemon never runs the auto planning turn for new tasks.
   */
  disableChairPlanningTurn?: boolean;
  /**
   * P0-2: minutes of silence before an assigned/working member is auto-marked
   * unreachable (default 30).
   */
  memberUnreachableAfterMinutes?: number;
  /** P0-3: ms before a missing [WORKING] ACK triggers the chair reminder (default 3 min). */
  ackTimeoutMs?: number;
  /** P0-4: ms between retries of an unverified deliverable (default 10 min). */
  verificationRetryMs?: number;
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
  tx_id: string | null;
  sender_metaid: string | null;
  sender_global_metaid: string | null;
  sender_name: string | null;
  content: string | null;
  mention: string | null;
  chain_timestamp: number | null;
  reply_pin: string | null;
  sender_suspect?: number | null;
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

/** sqlite datetime('now') strings are UTC 'YYYY-MM-DD HH:MM:SS'. */
function parseSqliteUtcMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  return Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6]),
  );
}

function toDaemonMessage(row: GroupChatMessageRow): GroupTaskDaemonMessage {
  return {
    id: row.id,
    pinId: row.pin_id ?? null,
    txId: row.tx_id ?? null,
    senderMetaId: (row.sender_metaid ?? '').trim(),
    senderGlobalMetaId: row.sender_global_metaid ?? null,
    senderName: (row.sender_name ?? '').trim() || 'Unknown',
    content: (row.content ?? '').trim(),
    mention: row.mention ?? null,
    chainTimestamp: row.chain_timestamp ?? null,
    replyPin: row.reply_pin ?? null,
    senderSuspect: Number(row.sender_suspect ?? 0) === 1,
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
  const chairTwinSuppressWindowMs = Math.max(
    0,
    Math.trunc(deps.chairTwinSuppressWindowMs ?? DEFAULT_CHAIR_TWIN_SUPPRESS_WINDOW_MS),
  );
  const memberUnreachableAfterMinutes = Math.max(
    1,
    Math.trunc(deps.memberUnreachableAfterMinutes ?? DEFAULT_MEMBER_UNREACHABLE_AFTER_MINUTES),
  );
  const ackTimeoutMs = Math.max(
    30_000,
    Math.trunc(deps.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS),
  );
  const verificationRetryMs = Math.max(
    60_000,
    Math.trunc(deps.verificationRetryMs ?? DEFAULT_VERIFICATION_RETRY_MS),
  );
  const emitLog = deps.emitLog ?? (() => undefined);
  const now = deps.now ?? (() => Date.now());

  /**
   * Round-4 default link probe: HEAD with a GET fallback (some hosts reject
   * HEAD), redirects followed, ~8s bound. null when the network is
   * unavailable. Production default; tests inject a fake via deps.probeUrl.
   */
  const defaultProbeUrl: GroupTaskDaemonProbeUrlFn = async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      let response = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: controller.signal,
      });
      if (response.status >= 400 || response.status === 405) {
        response = await fetch(url, {
          method: 'GET',
          redirect: 'follow',
          signal: controller.signal,
          headers: { Range: 'bytes=0-0' },
        });
      }
      return response.status;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  const probeUrl = deps.probeUrl ?? defaultProbeUrl;
  const experienceStore = deps.experienceStore ?? new MetaIDExperienceStore(
    deps.getStore().getDatabase(),
    deps.getStore().getSaveFunction(),
  );

  // Loop prevention state (in-memory, per loop instance; no new DB columns).
  const lastReplyAtByKey = new Map<string, number>();
  const replyCountByKey = new Map<string, number>();
  const keyOf = (taskId: number, metabotId: number): string => `${taskId}:${metabotId}`;

  // P2-7 (round 2): pin_ids of messages THIS daemon posted as the chair
  // (planning kickoff + auto replies). They must never count as "Twin
  // activity" for the suppression window — otherwise the daemon's own cadence
  // would self-throttle in fully autonomous groups. Bounded per task.
  const daemonChairSentPins = new Map<number, string[]>();
  const rememberDaemonChairPin = (taskId: number, pinId: string): void => {
    const pins = daemonChairSentPins.get(taskId) ?? [];
    pins.push(pinId);
    if (pins.length > 8) pins.shift();
    daemonChairSentPins.set(taskId, pins);
  };

  /**
   * Re-trigger window (P0-3c): a decision skipped because of the per-tick reply
   * cap or a cooldown is NOT dropped. The (task, bot, message) is queued here and
   * retried at the start of a later tick, so the skipped worker still gets its
   * chance (the message cursor has already advanced past it by then).
   */
  interface DeferredReplyEntry {
    taskId: number;
    metabotId: number;
    messageId: number;
    reason: GroupTaskResponderDecision['reason'];
    verificationNotes: string[];
  }
  let deferredReplies: DeferredReplyEntry[] = [];
  const deferReply = (entry: DeferredReplyEntry): void => {
    const index = deferredReplies.findIndex(
      (existing) => existing.taskId === entry.taskId && existing.metabotId === entry.metabotId,
    );
    if (index >= 0) {
      deferredReplies[index] = entry; // keep only the newest pending message
    } else {
      deferredReplies.push(entry);
    }
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  const queryNewMessages = (db: Database, groupId: string, afterId: number): GroupChatMessageRow[] =>
    mapMessageRows(db.exec(
      `SELECT id, pin_id, tx_id, sender_metaid, sender_global_metaid, sender_name, content, mention,
              chain_timestamp, reply_pin, sender_suspect
       FROM group_chat_messages
       WHERE group_id = ? AND id > ?
       ORDER BY id ASC`,
      [groupId, afterId],
    ));

  const queryMessageById = (db: Database, groupId: string, id: number): GroupChatMessageRow | null =>
    mapMessageRows(db.exec(
      `SELECT id, pin_id, tx_id, sender_metaid, sender_global_metaid, sender_name, content, mention,
              chain_timestamp, reply_pin, sender_suspect
       FROM group_chat_messages
       WHERE group_id = ? AND id = ?
       LIMIT 1`,
      [groupId, id],
    ))[0] ?? null;

  /** True when the chair bot already replied to the given message pin (P2-7). */
  const chairAlreadyRepliedTo = (
    db: Database,
    groupId: string,
    messagePinId: string | null,
    chairGlobalMetaId: string,
  ): boolean => {
    if (!messagePinId || !chairGlobalMetaId) return false;
    const result = db.exec(
      `SELECT COUNT(*) AS n FROM group_chat_messages
       WHERE group_id = ? AND reply_pin = ? AND sender_global_metaid = ?`,
      [groupId, messagePinId, chairGlobalMetaId],
    );
    const value = result[0]?.values?.[0]?.[0];
    return Number(value) > 0;
  };

  /**
   * P2-7 (round 2): true when the chair bot posted ANY message within the
   * suppression window (chain seconds). Pins the daemon itself posted
   * (planning kickoff, auto replies) are excluded — only Twin-side speech
   * counts. Rows without a chain timestamp or pin_id are unattributable and
   * never counted.
   */
  const chairSpokeInWindow = (
    db: Database,
    groupId: string,
    chairGlobalMetaId: string,
    sinceChainSec: number,
    excludePins: ReadonlySet<string>,
  ): boolean => {
    if (!chairGlobalMetaId) return false;
    const result = db.exec(
      `SELECT pin_id FROM group_chat_messages
       WHERE group_id = ? AND sender_global_metaid = ? AND pin_id IS NOT NULL AND pin_id != ''
         AND chain_timestamp IS NOT NULL AND chain_timestamp >= ?`,
      [groupId, chairGlobalMetaId, sinceChainSec],
    );
    const pins = result[0]?.values ?? [];
    return pins.some((values) => {
      const pin = String(values[0] ?? '');
      return Boolean(pin) && !excludePins.has(pin);
    });
  };

  /**
   * P2-7 (round 2): combined "the Twin is already speaking" gate for daemon
   * chair AUTO replies — the exact reply-pin match (Twin replied to THIS
   * message) OR Twin speech anywhere in the recent window (covers replies
   * without a reply_pin and speech on related messages). `chair_mentioned`
   * stays exempt: a direct @ of the chair is the reliable path and must be
   * answered even while the Twin is active.
   */
  const twinChairActive = (
    db: Database,
    taskId: number,
    groupId: string,
    messagePinId: string | null,
    chairGlobalMetaId: string,
  ): boolean => {
    if (chairAlreadyRepliedTo(db, groupId, messagePinId, chairGlobalMetaId)) return true;
    if (chairTwinSuppressWindowMs <= 0) return false;
    const sinceChainSec = Math.floor((now() - chairTwinSuppressWindowMs) / 1000);
    const excludePins = new Set(daemonChairSentPins.get(taskId) ?? []);
    return chairSpokeInWindow(db, groupId, chairGlobalMetaId, sinceChainSec, excludePins);
  };

  const queryRecentMessages = (db: Database, groupId: string, limit: number): GroupChatMessageRow[] => {
    const rows = mapMessageRows(db.exec(
      `SELECT id, pin_id, tx_id, sender_metaid, sender_global_metaid, sender_name, content, mention,
              chain_timestamp, reply_pin, sender_suspect
       FROM group_chat_messages
       WHERE group_id = ?
       ORDER BY id DESC LIMIT ?`,
      [groupId, limit],
    ));
    return rows.reverse();
  };

  const recordGroupTaskMessageForLocalMembers = (
    task: GroupTask,
    message: GroupTaskDaemonMessage,
    members: GroupTaskMember[],
    botsById: Map<number, GroupTaskDaemonBotFull>,
  ): void => {
    const participants = members.map((member) => {
      const bot = member.metabotId == null ? null : botsById.get(member.metabotId);
      const globalMetaID = (member.globalmetaid ?? bot?.globalmetaid ?? '').trim();
      return globalMetaID
        ? { globalMetaID, role: member.role }
        : { unresolvedActorKey: `group-task-member:${member.id}`, role: member.role };
    });
    const coworkStore = deps.getCoworkStore();
    for (const member of members) {
      if (member.metabotId == null) continue;
      const bot = botsById.get(member.metabotId);
      if (!bot?.globalmetaid?.trim()) continue;
      const mapping = coworkStore.getConversationMapping(
        CONVERSATION_CHANNEL,
        `group-task:${task.id}`,
        bot.id,
      );
      try {
        recordMetaIDGroupTaskExperience({
          store: experienceStore,
          ownerGlobalMetaID: bot.globalmetaid,
          taskId: task.id,
          groupId: task.groupId,
          sessionId: mapping?.coworkSessionId ?? null,
          message: {
            id: message.id,
            pinId: message.pinId,
            txId: message.txId,
            senderGlobalMetaID: message.senderGlobalMetaId,
            senderMetaID: message.senderMetaId,
            content: message.content,
            occurredAt: message.chainTimestamp,
            replyPin: message.replyPin,
          },
          participants,
        });
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: experience capture failed for bot ${bot.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  const buildGroupLogUserMessage = (
    db: Database,
    task: GroupTask,
    triggering: GroupTaskDaemonMessage,
  ): string => {
    const recent = queryRecentMessages(db, task.groupId!, contextMessageCount);
    const lines = recent.map((row) => {
      const message = toDaemonMessage(row);
      // Round-4: SUSPECT senders are flagged in context — the bot must never
      // mistake a non-member's display name for a member's identity.
      const line = `${message.senderName}${message.senderSuspect ? ' [SUSPECT]' : ''}: ${message.content}`;
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
      // Past work reviews (dream-written, aligned with the owner's acceptance
      // ratings) — the recall path that keeps prior group-task feedback in play.
      const workReviews = deps.listUserMemories?.(bot.id, { usageClass: 'work_review', limit: 5 }) ?? [];
      const summaries = deps.listDailySummaries?.(bot.id, RECENT_SUMMARIES_PROMPT_DAYS) ?? [];
      const block = buildExperiencePromptBlocksXml({
        identityText: identityEntry?.text ?? null,
        valueBoundaries,
        workReviews,
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

  /**
   * Observer-relative MetaID impression summaries for the group roster, built
   * by the shared cognition service and capped defensively. Failure omits the
   * block without blocking the group turn.
   */
  const buildGroupCognitionBlockFor = async (
    bot: GroupTaskDaemonBotFull,
    promptMembers: DaemonPromptMember[],
  ): Promise<string> => {
    if (!deps.getMetaIDGroupCognitionPromptBlock || !bot.globalmetaid?.trim()) return '';
    try {
      const roster = promptMembers
        .map((member) => ({
          globalMetaID: member.globalMetaId?.trim() ?? null,
          name: member.name,
          role: member.role,
        }))
        .filter((member): member is { globalMetaID: string; name: string; role: 'chair' | 'worker' } =>
          Boolean(member.globalMetaID));
      const block = (await deps.getMetaIDGroupCognitionPromptBlock({
        observerGlobalMetaID: bot.globalmetaid,
        roster,
      })).trim();
      return block.length > GROUP_COGNITION_BLOCK_MAX_CHARS
        ? `${block.slice(0, GROUP_COGNITION_BLOCK_MAX_CHARS)}…`
        : block;
    } catch (error) {
      deps.emitLog?.(
        `[GroupTaskDaemon] MetaID group cognition projection unavailable for bot ${bot.id}; continuing without impression context: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
      return '';
    }
  };

  /**
   * Per-turn prompt split into a STABLE system prompt (base only — no time, no
   * experience/cognition blocks) and a volatile tail for the user message.
   * The system prompt leads DeepSeek's cacheable prefix and is also compared
   * against the cowork session's stored prompt: any byte change resets the
   * underlying SDK session (full cold start). Minute-precision time and
   * nightly-rewritten dream summaries used to live in the system prompt, so
   * every group turn reset the session and missed the entire cache. They now
   * ride the user message instead (Reasonix: volatile state in the turn tail).
   */
  const buildTurnSystemPrompt = async (
    bot: GroupTaskDaemonBotFull,
    task: GroupTask,
    promptMembers: DaemonPromptMember[],
    botRole: 'chair' | 'worker',
    ownerGlobalMetaId: string,
  ): Promise<{ systemPrompt: string; volatileContext: string }> => {
    const experienceBlock = buildExperienceBlockFor(bot);
    const cognitionBlock = await buildGroupCognitionBlockFor(bot, promptMembers);
    const systemPrompt = buildGroupTaskSystemPrompt({
      metabot: bot,
      task: {
        title: task.title,
        goal: task.goal,
        acceptanceCriteria: task.acceptanceCriteria,
      },
      members: promptMembers,
      botRole,
      ownerGlobalMetaId: ownerGlobalMetaId || null,
    });
    const volatileContext = [formatTurnTimeText(), experienceBlock, cognitionBlock]
      .filter((section) => section?.trim())
      .join('\n\n');
    return { systemPrompt, volatileContext };
  };

  /** Plausible pinid/txid candidates in a [DELIVERABLE] line (deduped, capped). */
  const extractIdCandidates = (content: string): string[] => {
    const matches = content.match(DELIVERABLE_ID_CANDIDATE) ?? [];
    return [...new Set(matches)].slice(0, MAX_VERIFICATION_CANDIDATES);
  };

  /**
   * Deliverable verification hints: format-check any pinid/txid-looking token
   * ON THE [DELIVERABLE] TAG LINES ONLY (P1-4 r2 — body prose is not scanned),
   * then (when wired) an on-chain existence check via getPinData. Round-4 also
   * HTTP-probes key https:// links on the tag lines (HEAD, GET fallback) so the
   * chair's acceptance is auto-informed — a link that returns 4xx/5xx is
   * flagged for clarification instead of being copied verbatim (the #7
   * /browser/buzz/ vs /browser/pin/ correction case). The notes are appended
   * to the chair's context so it verifies before accepting.
   */
  const verifyDeliverableCandidates = async (deliverableTagText: string): Promise<string[]> => {
    const notes: string[] = [];
    for (const token of extractIdCandidates(deliverableTagText)) {
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
    // Round-4: HTTP probe on key https:// links from the [DELIVERABLE] tag
    // lines (only). Probe results ride the chair's verification notes.
    const urlCandidates = extractUrlCandidates(deliverableTagText);
    for (const url of urlCandidates) {
      const status = await probeUrl(url);
      const short = url.length > 48 ? `${url.slice(0, 44)}…` : url;
      if (status == null) {
        notes.push(`… Host verification: HTTP probe ${short} unavailable (timeout/network).`);
      } else if (status >= 200 && status < 400) {
        notes.push(`✓ Host verification: HTTP probe ${short} → ${status} (link reachable).`);
      } else {
        notes.push(
          `⚠ Host verification: HTTP probe ${short} → ${status} — link may be invalid; verify before accepting.`,
        );
      }
    }
    return notes;
  };

  /**
   * Round-4: https?:// URLs on the [DELIVERABLE] tag lines only (deduped,
   * capped). Body prose is never scanned (P1-4 r2 heritage).
   */
  const extractUrlCandidates = (content: string): string[] => {
    const matches = content.match(/https?:\/\/[^\s()（）<>\[\]`*_]+/gi) ?? [];
    const cleaned = matches.map((url) => url.replace(/[，。；、！？!?.,;:)+]+$/g, ''));
    return [...new Set(cleaned)].slice(0, MAX_VERIFICATION_CANDIDATES);
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
      const systemPromptParts = await buildTurnSystemPrompt(bot, task, promptMembers, 'chair', ownerGlobalMetaId);
      const systemPrompt = systemPromptParts.systemPrompt;
      // Volatile context (time + experience/cognition) rides the user turn.
      const directive = [systemPromptParts.volatileContext, buildOwnerReportDirective(store, task)]
        .filter(Boolean)
        .join('\n\n');
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
   * Round-4 correction-first matching: find the deliverable row a correction
   * message supersedes. The correction must come from the same author as the
   * original and reference the same object — matched by a shared 64-hex+i0
   * pinid token inside both URIs (the strongest signal: msg97's buzz URL and
   * msg99's corrected preview URL share the same buzz pinid). When the
   * candidate has no pinid token, fall back to the newest pending row of the
   * same kind by the same author. Rows already carrying the exact same URI
   * are never "superseded".
   */
  const findSupersededDeliverable = (
    taskId: number,
    senderGlobalMetaId: string | null,
    candidate: ParsedDeliverable,
  ): GroupTaskDeliverable | undefined => {
    const author = (senderGlobalMetaId ?? '').trim().toLowerCase();
    if (!author || !candidate.uri) return undefined;
    const candidatePinids = new Set(
      candidate.uri.match(/[0-9a-f]{64}i0/gi)?.map((token) => token.toLowerCase()) ?? [],
    );
    const candidatesByAuthor = deps.getGroupTaskStore().listDeliverables(taskId)
      .filter((deliverable) =>
        deliverable.status === 'pending'
        && Boolean(deliverable.authorGlobalmetaid)
        && deliverable.authorGlobalmetaid!.trim().toLowerCase() === author,
      )
      .slice()
      .reverse(); // newest rows first
    for (const deliverable of candidatesByAuthor) {
      if (deliverable.uri === candidate.uri && deliverable.kind === candidate.kind) continue;
      const oldPinids = new Set(
        (deliverable.uri ?? '').match(/[0-9a-f]{64}i0/gi)?.map((token) => token.toLowerCase()) ?? [],
      );
      if (candidatePinids.size > 0 && [...candidatePinids].some((pinid) => oldPinids.has(pinid))) {
        return deliverable;
      }
    }
    // Fallback: same kind, no shared pinid — a correction that rewrites the
    // deliverable's uri (e.g. a link that changed host) supersedes the newest
    // same-kind row by the same author.
    if (candidate.kind !== 'text') {
      return candidatesByAuthor.find(
        (deliverable) => deliverable.kind === candidate.kind && deliverable.uri !== candidate.uri,
      );
    }
    return undefined;
  };

  /**
   * Protocol tags on EVERY ingested message (before/independent of reply gating):
   * - [DELIVERABLE]: record one pending deliverable row per valid tag
   *   candidate (deduped by msg_pin_id + uri + kind; corrections supersede in
   *   place) and compute host verification notes for the chair.
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

    // Deliverable collection is worker-only: a chair message that merely quotes
    // an example (`metaapp://<pinId>`) or recap must never become a deliverable.
    const chairGlobalMetaId = (
      members.find((member) => member.role === 'chair')?.globalmetaid ?? ''
    ).trim();
    const senderGlobalMetaId = (message.senderGlobalMetaId ?? '').trim();
    const isChairMessage = Boolean(
      chairGlobalMetaId && senderGlobalMetaId && senderGlobalMetaId === chairGlobalMetaId,
    );

    // Round-4 attribution: deliverables are only collected from messages whose
    // chain-signature GlobalMetaID is a task member. SUSPECT senders (neither
    // member nor owner) are marked on the row but never contribute deliverables.
    if (message.senderSuspect) {
      // no deliverable collection for non-member speakers
    } else if (DELIVERABLE_TAG.test(content) && !isChairMessage) {
      // Round-4: per-candidate ingestion. Every [DELIVERABLE] tag occurrence
      // (its own line or inline) produces one candidate; valid candidates each
      // get their own row — a message with two tag lines records TWO rows.
      // Placeholder/truncated candidates are dropped individually so a junk
      // line can never hide a real URI on a sibling line.
      const msgPinId = message.pinId;
      const tagLines = deliverableTagLines(content);
      const candidates = parseDeliverableLines(content);
      const recordedDeliverables: ParsedDeliverable[] = [];
      const rejected = candidates.filter((candidate) => !candidate.valid);
      if (rejected.length > 0) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: ${rejected.length} [DELIVERABLE] candidate(s) rejected ` +
          `(${rejected.map((candidate) => candidate.note ?? 'invalid').join('; ')})`,
        );
      }
      const isCorrection = /更正|修正|以…?为准|以此为准|请以此为准/.test(content);
      for (const candidate of candidates) {
        if (!candidate.valid) continue; // placeholder/truncated/example → never recorded
        if (!msgPinId) continue;
        // Round-4 correction-first aggregation: a later message declaring
        // 「更正/修正/以…为准」 for the same object (matched by a shared
        // 64-hex pinid token, same author) supersedes the earlier row in place
        // instead of recording a duplicate.
        if (isCorrection && candidate.uri) {
          const superseded = findSupersededDeliverable(task.id, message.senderGlobalMetaId, candidate);
          if (superseded) {
            store.updateDeliverableUri(superseded.id, candidate.uri, candidate.kind);
            // P0-4: corrected deliverable is re-verified on the next monitor pass.
            store.updateDeliverableVerification(superseded.id, '{}');
            verificationNotes.push(
              `✓ 更正优先：交付物 #${superseded.id}（${superseded.kind ?? 'text'}）已就地更新为 ${candidate.uri}`,
            );
            if (deps.orchestrationBridge) {
              try {
                deps.orchestrationBridge.recordDeliverable({
                  groupTaskId: task.id,
                  deliverable: store.listDeliverables(task.id)
                    .find((deliverable) => deliverable.id === superseded.id)!,
                  verificationNotes,
                });
              } catch (error) {
                emitLog(
                  `[GroupTaskDaemon] Task ${task.id}: canonical correction projection failed: ` +
                  `${error instanceof Error ? error.message : String(error)}`,
                );
              }
            }
            continue;
          }
        }
        const existing = store.findDeliverableByMsgPinAndUri(
          task.id,
          msgPinId,
          candidate.uri,
          candidate.kind,
        );
        if (existing) {
          recordedDeliverables.push(candidate);
          continue;
        }
        const deliverable = store.addDeliverable({
          taskId: task.id,
          msgPinId,
          authorGlobalmetaid: message.senderGlobalMetaId,
          kind: candidate.kind,
          uri: candidate.uri,
        });
        recordedDeliverables.push(candidate);
        // P0-4: persist multi-source on-chain verification for pinid deliverables.
        if (candidate.kind === 'metaapp' || candidate.kind === 'metafile' || candidate.kind === 'pinid') {
          const pinid = pinidFromDeliverable(candidate.uri);
          if (pinid) {
            try {
              const report = await verifyPinSources(pinid);
              store.updateDeliverableVerification(deliverable.id, JSON.stringify(report));
              const lagging = report.sources.some((entry) => entry.outcome === 'not_found')
                && report.sources.some((entry) => entry.outcome === 'found');
              if (!report.verified) {
                verificationNotes.push(
                  lagging
                    ? `… Host verification: pinid ${pinid.slice(0, 10)}… 未同步（索引延迟，多源不一致），将自动重试`
                    : `⚠ Host verification: pinid ${pinid.slice(0, 10)}… not found on-chain`,
                );
              }
            } catch (error) {
              emitLog(
                `[GroupTaskDaemon] Task ${task.id}: deliverable #${deliverable.id} verification failed: ` +
                `${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
        }
        if (deps.orchestrationBridge) {
          try {
            deps.orchestrationBridge.recordDeliverable({
              groupTaskId: task.id,
              deliverable,
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
      try {
        const notes = await verifyDeliverableCandidates(tagLines.join('\n'));
        if (notes.length > 0) {
          verificationNotes = [...verificationNotes, ...notes];
        }
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: deliverable verification failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // P0-8: public integrity declarations (honest correction/report) are
    // recorded into the acceptance record. Dedupe by message pin.
    if (!message.senderSuspect && message.pinId && isIntegrityDeclaration(content)) {
      try {
        if (!store.hasIntegrityEventWithMsgPin(task.id, message.pinId)) {
          const isCorrection = /更正|修正|纠正|以…?为准|以此为准|补正|勘误/.test(content);
          store.addIntegrityEvent({
            taskId: task.id,
            msgPinId: message.pinId,
            authorGlobalmetaid: message.senderGlobalMetaId,
            eventType: isCorrection ? 'correction' : 'honest_report',
            detail: content.slice(0, 500),
          });
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: recorded integrity ${isCorrection ? 'correction' : 'report'} from ${message.senderName}`,
          );
        }
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: integrity event record failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
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
          // P0-5: status tags also write the transition audit log (actor =
          // chair metabot id, reason = the STATUS tag).
          const chairName = (chairMember?.name ?? members.find((m) => m.role === 'chair')?.name ?? 'chair').trim();
          const updated = store.updateTaskStatusWithLog(task.id, nextStatus, {
            actor: chairName || `metabot:${chairMember?.metabotId ?? 'chair'}`,
            reason: `[STATUS:${statusMatch[1].toUpperCase()}] tag`,
          });
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
              // P0-1: failed noise steps (mistaken mentions whose skill routing
              // failed) are auto-ignored on review entry so they never block the
              // owner's acceptance, and the acceptance UI sees them as ignored.
              try {
                const ignored = deps.orchestrationBridge?.ignoreFailedSteps(task.id) ?? 0;
                if (ignored > 0) {
                  emitLog(`[GroupTaskDaemon] Task ${task.id}: auto-ignored ${ignored} noise step(s) on review entry`);
                }
              } catch (error) {
                emitLog(
                  `[GroupTaskDaemon] Task ${task.id}: failed to auto-ignore noise steps: ` +
                  `${error instanceof Error ? error.message : String(error)}`,
                );
              }
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

  /**
   * System-generated planning directive for the chair planning turn. The full
   * member roster (name, role, bio/role profile, goal) is embedded so the chair
   * LLM assigns work to the right specialist instead of guessing from an empty
   * group log (P1-5: the planning turn fired before any member message existed).
   */
  const buildPlanningDirective = (db: Database, task: GroupTask, promptMembers: DaemonPromptMember[]): string => {
    const recent = queryRecentMessages(db, task.groupId!, contextMessageCount);
    const logLines = recent.map((row) => {
      const message = toDaemonMessage(row);
      return `${message.senderName}${message.senderSuspect ? ' [SUSPECT]' : ''}: ${message.content}`;
    });
    const rosterLines = promptMembers.map((member) => {
      const profile = [member.bio, member.roleProfile].filter(Boolean).join(' — ');
      const goal = member.goal?.trim() ? ` (goal: ${member.goal.trim()})` : '';
      const skillsHint = member.role === 'chair' ? ' (chair, do not assign work to the chair)' : '';
      const remoteHint = member.remote ? ' (remote teammate via OpenTeam — replies come from their own machine, may be delayed)' : '';
      return `- ${member.name} [${member.role}]${goal}${skillsHint}${remoteHint}${profile ? ` — ${profile}` : ''}`;
    });
    const workerCount = promptMembers.filter((member) => member.role === 'worker').length;
    const distributionRule = workerCount >= 2
      ? ' With 2+ workers on the roster, DISTRIBUTE the subtasks across AT LEAST 2 DIFFERENT members by their strengths — never concentrate every subtask on a single member.'
      : ' (single worker on the roster — assign all subtasks to that one member).';
    return [
      '[SYSTEM planning directive — generated by the host, not by a group participant]',
      'The group task has just been created. As the chair, post the task plan to the group NOW, in one message:',
      '(a) Decompose the goal into concrete subtasks.',
      `(b) Assign each subtask to the SINGLE most suitable member BY NAME based on the roster profiles (never assign the same work to everyone).${distributionRule}`,
      '(c) State the sequence/dependencies and @-mention ONLY the members who should act NOW (later steps get assigned when their inputs arrive, e.g. after a [DELIVERABLE]).',
      '(d) End the message with [STATUS:EXECUTING].',
      '',
      'Full member roster (assign only to these members, by exact name):',
      ...(rosterLines.length > 0 ? rosterLines : ['(no members yet besides the chair)']),
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
    if (deps.disableChairPlanningTurn) {
      // Host opt-out (P1-5 r2): the Twin chair leads the kickoff itself, so
      // the daemon never runs the auto planning turn. Mark the task as
      // "planned" so the guard stays quiet on later ticks.
      sqlite.set(plannedKey, '1');
      emitLog(
        `[GroupTaskDaemon] Task ${task.id}: chair planning turn disabled (disableChairPlanningTurn); Twin leads the kickoff`,
      );
      return;
    }
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
      const systemPromptParts = await buildTurnSystemPrompt(bot, task, promptMembers, 'chair', ownerGlobalMetaId);
      const systemPrompt = systemPromptParts.systemPrompt;
      // Volatile context (time + experience/cognition) rides the user turn.
      const directive = [systemPromptParts.volatileContext, buildPlanningDirective(db, task, promptMembers)]
        .filter(Boolean)
        .join('\n\n');
      const llmId = normalizeMetabotLlmId(bot.llm_id) ?? undefined;
      const fallbackLlmId = normalizeMetabotLlmId(bot.fallback_llm_id);
      // Plain LLM path: the chair is planning here, not executing skills.
      let reply = (await deps.performChat(systemPrompt, directive, llmId, { fallbackLlmId, thinking: 'enabled' })).trim();
      if (!reply || NO_REPLY_PATTERN.test(reply)) {
        throw new Error('planning turn produced no usable plan');
      }
      // C-1 defensive coverage check: never let a multi-worker plan concentrate
      // every subtask on one member. Retry while attempts remain; on the final
      // attempt, attach a host warning instead of blocking the plan.
      const workerNames = promptMembers
        .filter((member) => member.role === 'worker')
        .map((member) => member.name);
      if (workerNames.length > 1) {
        const coverage = checkPlanningCoverage(reply, workerNames);
        if (!coverage.ok) {
          if (attempts + 1 < MAX_CHAIR_PLAN_ATTEMPTS) {
            throw new Error(
              'planning coverage check failed: all subtasks assigned to a single member ' +
              `(${coverage.mentionedWorkers.join(', ') || 'none'})`,
            );
          }
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: planning coverage check failed on final attempt — ` +
            `appending host warning (mentioned: ${coverage.mentionedWorkers.join(', ') || 'none'})`,
          );
          reply += `\n\n⚠ Host warning: this plan concentrates the work on one member ` +
            `(${coverage.mentionedWorkers.join(', ') || 'unknown'}). Verify that every roster ` +
            `member got a subtask or an explicit standby note.`;
        }
      }

      const session = ensureTaskSession(coworkStore, task, bot.id, bot.name);
      coworkStore.addMessage(session.id, { type: 'user', content: directive });
      coworkStore.addMessage(session.id, { type: 'assistant', content: reply });
      const posted = await deps.postGroupTaskMessage(task.id, bot.id, reply);
      // P2-7 r2: the daemon's own kickoff must not count as "Twin activity".
      rememberDaemonChairPin(task.id, posted.pinId);
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

    const { systemPrompt: baseSystemPrompt, volatileContext } = await buildTurnSystemPrompt(bot, task, promptMembers, member.role, ownerGlobalMetaId);
    // Volatile context (time + experience/cognition) rides the user turn so
    // the system prompt stays byte-stable across group turns.
    let userMessage = [volatileContext, buildGroupLogUserMessage(db, task, message)]
      .filter(Boolean)
      .join('\n\n');
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
    if (member.role === 'chair') {
      // P2-7 r2: the daemon's own auto reply must not count as "Twin activity"
      // for the suppression window when it round-trips into the DB.
      rememberDaemonChairPin(task.id, sent.pinId);
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

  /**
   * Round-4 attribution enrichment. The chain-signature GlobalMetaID is the
   * ONLY identity source for group-task attribution:
   * - a row whose sender_global_metaid is empty is resolved from its legacy
   *   sender_metaid via the injected manapi resolver and the row is updated
   *   once (so every consumer — daemon, experience ledger, show — agrees);
   * - a message whose GlobalMetaID is neither a task member nor the owner is
   *   marked SUSPECT (persisted); senderName is NEVER used for attribution.
   */
  const memberGlobalMetaIdSet = (members: GroupTaskMember[]): Set<string> => {
    const set = new Set<string>();
    for (const member of members) {
      const gmid = (member.globalmetaid ?? '').trim().toLowerCase();
      if (gmid) set.add(gmid);
    }
    return set;
  };

  const enrichMessageAttribution = async (
    message: GroupTaskDaemonMessage,
    memberGmids: Set<string>,
    ownerGlobalMetaId: string,
  ): Promise<GroupTaskDaemonMessage> => {
    let globalMetaId = (message.senderGlobalMetaId ?? '').trim();
    const legacy = (message.senderMetaId ?? '').trim();
    if (!globalMetaId && legacy && deps.resolveGlobalMetaId) {
      try {
        const resolved = (await deps.resolveGlobalMetaId(legacy))?.trim();
        if (resolved) {
          globalMetaId = resolved;
          try {
            deps.getGroupTaskStore().updateMessageSenderGlobalMetaId(message.id, resolved);
          } catch (error) {
            emitLog(
              `[GroupTaskDaemon] Message ${message.id}: resolved GlobalMetaID persist failed: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Message ${message.id}: legacy metaid resolution failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const normalized = globalMetaId.toLowerCase();
    const suspect = !globalMetaId
      || (!memberGmids.has(normalized) && normalized !== ownerGlobalMetaId.toLowerCase());
    if (suspect !== Boolean(message.senderSuspect)) {
      try {
        deps.getGroupTaskStore().setMessageSenderSuspect(message.id, suspect);
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Message ${message.id}: suspect flag persist failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { ...message, senderGlobalMetaId: globalMetaId || null, senderSuspect: suspect };
  };

  /**
   * P0-2: auto-mark silent assigned/working members as unreachable after
   * memberUnreachableAfterMinutes without any chain speech. Baseline = last
   * speak time (fallback: member join time); never marks chair members, done
   * members, or members who already show a non-active status.
   */
  const monitorMemberUnreachable = (task: GroupTask, members: GroupTaskMember[]): void => {
    const thresholdMs = memberUnreachableAfterMinutes * 60_000;
    const store = deps.getGroupTaskStore();
    const workers = members.filter(
      (member) => member.role === 'worker'
        && (member.status === 'assigned' || member.status === 'working'),
    );
    if (workers.length === 0 || !task.groupId) return;
    const speakMap = store.getMembersLastSpeakAt(
      task.groupId,
      workers.map((member) => member.globalmetaid),
    );
    for (const member of workers) {
      const gmid = (member.globalmetaid ?? '').trim().toLowerCase();
      const speakSec = gmid ? speakMap.get(gmid) ?? null : null;
      const lastMs = speakSec != null
        ? speakSec * 1000
        : parseSqliteUtcMs(member.createdAt);
      if (lastMs == null) continue;
      if (now() - lastMs <= thresholdMs) continue;
      try {
        store.setMemberStatus(task.id, member.metabotId, 'unreachable', member.globalmetaid);
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: member ${member.name ?? member.metabotId} marked ` +
          `unreachable (no speech for ${memberUnreachableAfterMinutes}+ min) — chair should re-assign or check`,
        );
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: failed to mark member ${member.metabotId} unreachable: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  /**
   * P0-3: per-message protocol markers:
   * - chair message that @mentions a worker = an ASSIGNMENT → record a pending
   *   [WORKING] ACK expectation for that worker (kv, timestamped).
   * - worker [WORKING] ACK → status working, clears the pending ACK, records
   *   the estimated delivery deadline for P0-4.
   * - worker [STANDBY] → status standby.
   * - any other worker speech clears the pending ACK (implicit ACK) and marks
   *   the member working (silence is never assumed).
   */
  const handleMemberProtocolMarkers = (
    task: GroupTask,
    message: GroupTaskDaemonMessage,
    members: GroupTaskMember[],
    botsById: Map<number, GroupTaskDaemonBotFull>,
  ): void => {
    const sqlite = deps.getStore();
    const store = deps.getGroupTaskStore();
    const senderGmid = (message.senderGlobalMetaId ?? '').trim().toLowerCase();
    if (!senderGmid || message.senderSuspect) return;

    const chairMember = members.find((member) => member.role === 'chair');
    const chairGmid = (chairMember?.globalmetaid ?? '').trim().toLowerCase();
    const isChairMessage = Boolean(chairGmid && senderGmid === chairGmid);
    if (isChairMessage) {
      for (const member of members) {
        if (member.role !== 'worker' || member.metabotId == null) continue;
        const bot = botsById.get(member.metabotId);
        if (!bot || !isMentioned(message, bot)) continue;
        const pendingKey = `${ACK_PENDING_PREFIX}${task.id}:${member.metabotId}`;
        const remindedKey = `${ACK_REMINDED_PREFIX}${task.id}:${member.metabotId}`;
        if (sqlite.get<string>(pendingKey) == null && sqlite.get<string>(remindedKey) !== '1') {
          sqlite.set(pendingKey, JSON.stringify({ assignedAt: now(), messageId: message.id }));
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: assignment to ${member.name ?? member.metabotId} (message #${message.id}); waiting for [WORKING] ACK`,
          );
        }
      }
      return;
    }

    const member = members.find(
      (candidate) => (candidate.globalmetaid ?? '').trim().toLowerCase() === senderGmid,
    );
    if (!member || member.role !== 'worker' || member.metabotId == null) return;

    const pendingKey = `${ACK_PENDING_PREFIX}${task.id}:${member.metabotId}`;
    const remindedKey = `${ACK_REMINDED_PREFIX}${task.id}:${member.metabotId}`;
    const ack = parseWorkingAck(message.content);
    if (ack) {
      store.setMemberStatus(task.id, member.metabotId, 'working', member.globalmetaid);
      if (sqlite.get<string>(pendingKey) != null) sqlite.delete(pendingKey);
      if (sqlite.get<string>(remindedKey) != null) sqlite.delete(remindedKey);
      if (ack.estimatedMinutes != null && ack.estimatedMinutes > 0) {
        sqlite.set(
          `${EXPECTED_DELIVERY_PREFIX}${task.id}:${member.metabotId}`,
          JSON.stringify({
            dueAt: now() + ack.estimatedMinutes * 60_000,
            ackedAt: now(),
            taskDescription: ack.taskDescription,
          }),
        );
      }
      emitLog(
        `[GroupTaskDaemon] Task ${task.id}: ${member.name ?? member.metabotId} ACKed [WORKING]` +
        (ack.estimatedMinutes != null ? ` (est. ${ack.estimatedMinutes} min)` : ''),
      );
      return;
    }
    if (hasStandbyMarker(message.content)) {
      store.setMemberStatus(task.id, member.metabotId, 'standby', member.globalmetaid);
      return;
    }
    // Implicit ACK: any worker speech counts as engaged.
    if (member.status === 'assigned') {
      store.setMemberStatus(task.id, member.metabotId, 'working', member.globalmetaid);
    }
    if (sqlite.get<string>(pendingKey) != null) sqlite.delete(pendingKey);
    if (sqlite.get<string>(remindedKey) != null) sqlite.delete(remindedKey);
  };

  /**
   * P0-3: chair reminder when an assignment got no [WORKING] ACK within
   * ackTimeoutMs (default 3 min). Fires ONCE per pending assignment; never
   * auto-fails the worker.
   */
  const monitorAcksAndReminders = async (
    task: GroupTask,
    members: GroupTaskMember[],
  ): Promise<void> => {
    if (task.status !== 'planning' && task.status !== 'executing') return;
    const sqlite = deps.getStore();
    const chair = members.find((member) => member.role === 'chair');
    if (!chair?.metabotId) return;
    for (const member of members) {
      if (member.role !== 'worker' || member.metabotId == null) continue;
      const pendingKey = `${ACK_PENDING_PREFIX}${task.id}:${member.metabotId}`;
      const raw = sqlite.get<string>(pendingKey);
      if (!raw) continue;
      let entry: { assignedAt: number; messageId: number };
      try {
        entry = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!entry || typeof entry.assignedAt !== 'number') continue;
      if (now() - entry.assignedAt < ackTimeoutMs) continue;
      const remindedKey = `${ACK_REMINDED_PREFIX}${task.id}:${member.metabotId}`;
      if (sqlite.get<string>(remindedKey) === '1') continue;
      const text =
        `@chair ⚠ ${member.name ?? `bot-${member.metabotId}`} was assigned ` +
        `(message #${entry.messageId}) but has not sent a [WORKING] ACK within ` +
        `${Math.round(ackTimeoutMs / 60_000)} min. Check whether the assignment ` +
        `was received; do not auto-fail.`;
      try {
        await deps.postGroupTaskMessage(task.id, chair.metabotId, text);
        sqlite.set(remindedKey, '1');
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: reminded chair that ${member.name ?? member.metabotId} has not ACKed`,
        );
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: ACK reminder post failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  /**
   * P0-4: multi-source on-chain existence check. MAN (local sqlite + manapi)
   * is always queried via deps.readPinForVerification; the metafile-indexer
   * is queried when deps.readPinSecondaryForVerification is wired. A 404 from
   * ONE source with success from another is treated as indexer lag ("待同步"),
   * never as a hard failure.
   */
  const verifyPinSources = async (pinId: string): Promise<{
    sources: Array<{ source: string; outcome: 'found' | 'not_found' | 'unavailable' }>;
    verified: boolean;
    checkedAt: number;
  }> => {
    const sources: Array<{ source: string; outcome: 'found' | 'not_found' | 'unavailable' }> = [];
    const primary = deps.readPinForVerification;
    if (primary) {
      try {
        sources.push({ source: 'man', outcome: await primary(pinId) });
      } catch {
        sources.push({ source: 'man', outcome: 'unavailable' });
      }
    }
    if (deps.readPinSecondaryForVerification) {
      try {
        sources.push({
          source: 'metafile-indexer',
          outcome: await deps.readPinSecondaryForVerification(pinId),
        });
      } catch {
        sources.push({ source: 'metafile-indexer', outcome: 'unavailable' });
      }
    }
    const found = sources.some((entry) => entry.outcome === 'found');
    const notFound = sources.some((entry) => entry.outcome === 'not_found');
    // verified only when at least one source found it AND no source hard-404s.
    const verified = found && !notFound;
    return { sources, verified, checkedAt: now() };
  };

  /** P0-4: extract the first 64-hex+i0 pinid from a deliverable uri. */
  const pinidFromDeliverable = (uri: string | null): string | null => {
    const match = (uri ?? '').match(/[0-9a-f]{64}i0/i);
    return match ? match[0].toLowerCase() : null;
  };

  /**
   * P0-4: periodic re-verification for deliverables that are NOT verified yet
   * (indexer lag / 40400). Re-checks every verificationRetryMinutes (default
   * 10) per deliverable until verified.
   */
  const monitorDeliverableVerification = async (task: GroupTask): Promise<void> => {
    const store = deps.getGroupTaskStore();
    const deliverables = store.listDeliverables(task.id);
    const nowMs = now();
    for (const deliverable of deliverables) {
      if (deliverable.status === 'rejected') continue;
      const pinid = pinidFromDeliverable(deliverable.uri);
      if (!pinid) continue;
      let report: { verified?: boolean; checkedAt?: number } = {};
      try {
        if (deliverable.verification) report = JSON.parse(deliverable.verification);
      } catch {
        // corrupt/missing → re-verify
      }
      if (report.verified === true) continue;
      const checkedAt = typeof report.checkedAt === 'number' ? report.checkedAt : 0;
      if (nowMs - checkedAt < verificationRetryMs) continue;
      try {
        const fresh = await verifyPinSources(pinid);
        store.updateDeliverableVerification(deliverable.id, JSON.stringify(fresh));
        const lagging = fresh.sources.some((entry) => entry.outcome === 'not_found')
          && fresh.sources.some((entry) => entry.outcome === 'found');
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: deliverable #${deliverable.id} ${pinid.slice(0, 10)}… ` +
          `${fresh.verified ? 'verified on-chain' : (lagging ? 'awaiting indexer sync' : 'not found')}`,
        );
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: deliverable #${deliverable.id} re-verification failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  /**
   * P0-4: delivery deadline reminders. When a worker's [WORKING] ACK carried an
   * estimated duration and the deadline passes without ANY deliverable from
   * that member, post ONE reminder addressed to both chair and worker.
   */
  const monitorDeliveryDeadlines = async (
    task: GroupTask,
    members: GroupTaskMember[],
  ): Promise<void> => {
    if (task.status !== 'executing') return;
    const sqlite = deps.getStore();
    const store = deps.getGroupTaskStore();
    const nowMs = now();
    for (const member of members) {
      if (member.role !== 'worker' || member.metabotId == null) continue;
      const raw = sqlite.get<string>(`${EXPECTED_DELIVERY_PREFIX}${task.id}:${member.metabotId}`);
      if (!raw) continue;
      let entry: { dueAt: number };
      try {
        entry = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!entry || typeof entry.dueAt !== 'number' || nowMs < entry.dueAt) continue;
      const remindedKey = `${DELIVERY_REMINDED_PREFIX}${task.id}:${member.metabotId}`;
      if (sqlite.get<string>(remindedKey) === '1') continue;
      const gmid = (member.globalmetaid ?? '').trim().toLowerCase();
      const hasDeliverable = store.listDeliverables(task.id).some(
        (deliverable) =>
          Boolean(gmid)
          && (deliverable.authorGlobalmetaid ?? '').trim().toLowerCase() === gmid
          && deliverable.status !== 'rejected',
      );
      if (hasDeliverable) {
        sqlite.delete(`${EXPECTED_DELIVERY_PREFIX}${task.id}:${member.metabotId}`);
        continue;
      }
      const chair = members.find((candidate) => candidate.role === 'chair');
      if (!chair?.metabotId) continue;
      const text =
        `@chair ⚠ @${member.name ?? `bot-${member.metabotId}`} estimated delivery ` +
        `by ${new Date(entry.dueAt).toISOString()} but no [DELIVERABLE] arrived yet. ` +
        `Check status; do not auto-fail.`;
      try {
        await deps.postGroupTaskMessage(task.id, chair.metabotId, text);
        sqlite.set(remindedKey, '1');
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: reminded chair+worker ${member.name ?? member.metabotId} about missed delivery deadline`,
        );
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: delivery reminder post failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  const processTask = async (task: GroupTask): Promise<void> => {
    if (!task.groupId) return;
    const store = deps.getGroupTaskStore();
    const sqlite = deps.getStore();
    const db = sqlite.getDatabase();

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
    // Remote OpenTeam teammates (metabotId == null) join the prompt roster so
    // the chair and local workers can see and @ them; botsById and responder
    // gating stay local-only because their replies come from their own machine.
    const promptMembers: DaemonPromptMember[] = members.map((member) => {
      if (member.metabotId == null) {
        const globalMetaId = member.globalmetaid?.trim() || null;
        return {
          // The roster name must stay exactly the display_name snapshot — the
          // invitee's guest daemon name-gates on its real bot name.
          name: member.name ?? `remote-${(globalMetaId ?? '').slice(0, 10) || 'unknown'}`,
          role: member.role,
          globalMetaId,
          bio: null,
          roleProfile: null,
          goal: null,
          remote: true,
        };
      }
      const bot = botsById.get(member.metabotId);
      return {
        name: member.name ?? bot?.name ?? `bot-${member.metabotId}`,
        role: member.role,
        globalMetaId: member.globalmetaid?.trim() || bot?.globalmetaid?.trim() || null,
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

    // Round-4: per-tick heartbeat — lastDrivenAt (epoch seconds) is the host's
    // last drive timestamp, the primary input for the show stall signal.
    try {
      store.updateLastDrivenAt(task.id, Math.floor(now() / 1000));
    } catch (error) {
      emitLog(
        `[GroupTaskDaemon] Task ${task.id}: lastDrivenAt heartbeat failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // P0-2: auto-mark silent assigned/working members unreachable (badge for chair).
    if (task.status === 'executing') {
      monitorMemberUnreachable(task, members);
    }

    // P0-3: once-per-assignment chair reminder for missing [WORKING] ACKs.
    await monitorAcksAndReminders(task, members);
    // P0-4: re-verify lagging deliverables + missed delivery deadlines.
    await monitorDeliverableVerification(task);
    await monitorDeliveryDeadlines(task, members);

    // Exactly one chair planning turn per task, while it is still in 'planning'.
    if (task.status === 'planning') {
      await maybeRunChairPlanningTurn(task, members, botsById, promptMembers);
    }

    // P0-3c: compensate replies deferred by a cap/cooldown in an earlier tick.
    // Deferred entries get priority over brand-new messages so a skipped worker
    // still gets its chance (the message cursor already advanced past it).
    const deferredForTask = deferredReplies.filter((entry) => entry.taskId === task.id);
    if (deferredForTask.length > 0) {
      deferredReplies = deferredReplies.filter((entry) => entry.taskId !== task.id);
      for (const entry of deferredForTask) {
        const member = members.find((candidate) => candidate.metabotId === entry.metabotId);
        const bot = botsById.get(entry.metabotId);
        if (!member || !bot) continue;
        const row = queryMessageById(db, task.groupId, entry.messageId);
        if (!row) continue; // message purged; drop the deferred entry
        const deferredMessage = toDaemonMessage(row);
        const key = keyOf(task.id, entry.metabotId);
        const isChair = member.role === 'chair';
        const lastReplyAt = lastReplyAtByKey.get(key) ?? 0;
        const cooldownMs = isChair ? chairCooldownMs : workerCooldownMs;
        if (now() - lastReplyAt < cooldownMs) {
          deferReply(entry); // still cooling down; keep waiting
          continue;
        }
        if ((replyCountByKey.get(key) ?? 0) >= replyBudget) continue; // permanently spent
        if (isChair && entry.reason !== 'chair_mentioned' && twinChairActive(db, task.id, task.groupId, deferredMessage.pinId, chairGlobalMetaId)) {
          continue; // the Twin already spoke about this message (or in the recent window); drop the auto reply
        }
        try {
          await generateAndSendReply(
            task,
            member,
            bot,
            deferredMessage,
            promptMembers,
            chairGlobalMetaId,
            ownerGlobalMetaId,
            entry.verificationNotes,
          );
          lastReplyAtByKey.set(key, now());
          replyCountByKey.set(key, (replyCountByKey.get(key) ?? 0) + 1);
        } catch (error) {
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: deferred reply failed for bot ${entry.metabotId}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    const rows = queryNewMessages(db, task.groupId, task.lastProcessedMsgId);
    if (rows.length === 0) return;

    let workerRepliesThisTick = 0;
    // P2-7: at most ONE chair auto response (deliverable / floor control / owner
    // message) per tick, so the daemon never double-speaks alongside the Twin.
    let chairAutoRepliesThisTick = 0;

    const memberGmids = memberGlobalMetaIdSet(members);
    for (const row of rows) {
      // Round-4 attribution first: resolve the chain-signature GlobalMetaID
      // (persisted once) and mark SUSPECT when the sender is neither a task
      // member nor the owner. Everything downstream (deliverable collection,
      // gating, replies, experience capture) consumes the enriched message.
      const message = await enrichMessageAttribution(
        toDaemonMessage(row),
        memberGmids,
        ownerGlobalMetaId,
      );
      if (message.senderSuspect) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: message ${message.id} from non-member sender ` +
          `(globalMetaId=${message.senderGlobalMetaId ?? 'unresolved'}, name=${message.senderName}) ` +
          'marked SUSPECT — no deliverables recorded, no replies triggered',
        );
      }
      try {
        recordGroupTaskMessageForLocalMembers(task, message, members, botsById);
        const verificationNotes = await processMessageTags(task, message, members, botsById, promptMembers);
        // P0-3: [WORKING] ACK / [STANDBY] markers + assignment ACK tracking.
        handleMemberProtocolMarkers(task, message, members, botsById);
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

          // P2-7: a chair auto response (deliverable / floor control / owner
          // message) is suppressed when the Twin already replied to this message
          // on-chain OR spoke in the recent suppression window — the daemon must
          // not double-speak next to the Twin (round 2 covers replies without a
          // reply_pin and Twin speech on related messages).
          if (isChair && decision.reason !== 'chair_mentioned') {
            if (twinChairActive(db, task.id, task.groupId, message.pinId, chairGlobalMetaId)) {
              emitLog(`[GroupTaskDaemon] Task ${task.id}: Twin already spoke about message ${message.id}; skipping chair auto response`);
              continue;
            }
            if (chairAutoRepliesThisTick >= 1) {
              emitLog(`[GroupTaskDaemon] Task ${task.id}: chair auto-reply cap (1/tick) reached; skipping`);
              continue;
            }
          }

          if (!isChair && workerRepliesThisTick >= maxRepliesPerTaskPerTick) {
            emitLog(`[GroupTaskDaemon] Task ${task.id}: per-tick reply cap reached; deferring bot ${decision.metabotId} to a later tick`);
            deferReply({
              taskId: task.id,
              metabotId: decision.metabotId,
              messageId: message.id,
              reason: decision.reason,
              verificationNotes: [],
            });
            continue;
          }
          const lastReplyAt = lastReplyAtByKey.get(key) ?? 0;
          const cooldownMs = isChair ? chairCooldownMs : workerCooldownMs;
          if (now() - lastReplyAt < cooldownMs) {
            emitLog(`[GroupTaskDaemon] Task ${task.id}: bot ${decision.metabotId} in cooldown; deferring to a later tick`);
            deferReply({
              taskId: task.id,
              metabotId: decision.metabotId,
              messageId: message.id,
              reason: decision.reason,
              verificationNotes: decision.reason === 'chair_deliverable' ? verificationNotes : [],
            });
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
          if (!isChair) {
            workerRepliesThisTick += 1;
          } else if (decision.reason !== 'chair_mentioned') {
            chairAutoRepliesThisTick += 1;
          }
        }
        // Round-4: cursor advances only on SUCCESSFUL processing.
        store.updateLastProcessedMsgId(task.id, message.id);
        const retryKey = `${MSG_RETRY_PREFIX}${task.id}:${message.id}`;
        if (sqlite.get<number>(retryKey) != null) {
          sqlite.delete(retryKey); // recovered after earlier failures
        }
      } catch (error) {
        // Round-4 cursor semantics: lastProcessedMsgId is the id of the LAST
        // MESSAGE THE HOST SUCCESSFULLY PROCESSED — it only advances on
        // success. A failing message is retried on later ticks (bounded by a
        // kv failure counter) so a transient error never loses the message,
        // while a permanently broken message is dropped after
        // MSG_RETRY_MAX_FAILURES so it cannot stall the pipeline forever.
        const retryKey = `${MSG_RETRY_PREFIX}${task.id}:${message.id}`;
        const failures = (Number(sqlite.get<number>(retryKey) ?? 0) || 0) + 1;
        sqlite.set(retryKey, failures);
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: message ${message.id} failed ` +
          `(attempt ${failures}/${MSG_RETRY_MAX_FAILURES}): ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
        if (failures >= MSG_RETRY_MAX_FAILURES) {
          sqlite.delete(retryKey);
          store.updateLastProcessedMsgId(task.id, message.id);
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: message ${message.id} dropped after ` +
            `${failures} consecutive failures (cursor advanced past it)`,
          );
        }
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
