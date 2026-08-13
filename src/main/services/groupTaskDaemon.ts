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

import { randomUUID } from 'node:crypto';
import type { SqliteDatabase as Database } from '../sqliteTypes';
import type { MetabotStore } from '../metabotStore';
import type { CoworkStore, CoworkSession } from '../coworkStore';
import type {
  GroupTaskStore,
  GroupTask,
  GroupTaskMember,
  GroupTaskDeliverable,
  GroupTaskCheckpoint,
} from '../groupTaskStore';
import type {
  OpenTeamInvite,
  OpenTeamMembershipStore,
} from '../openTeamMembershipStore';
import { MetaIDExperienceStore } from '../metaidExperienceStore';
import { normalizeMetabotLlmId } from './llmFallback';
import { isMentioned } from './groupChatMentionUtils';
import { isNonAnswerAssistantReply } from '../libs/coworkAssistantReply';
import {
  formatWorkerEmptyHandoffError,
  hasSubstantiveActivity,
  summarizeSessionActivity,
  WORKER_EMPTY_HANDOFF,
  type CoworkSessionActivityMessage,
} from '../libs/coworkSessionActivity';
import { buildGroupTaskSystemPrompt } from './groupTaskPrompts';
import {
  ensureGroupTaskSession,
  GROUP_TASK_CONVERSATION_CHANNEL,
} from './groupTaskSession';
import type { GroupTaskOrchestrationBridge } from './groupTaskOrchestrationBridge';
import { recordMetaIDGroupTaskExperience } from './metaidExperienceRecorder';
import { buildAcceptanceSummary, buildAcceptanceSummaryMessageText } from './groupTaskAcceptanceSummary';
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

/** Alias kept for readability; the canonical value lives in groupTaskSession. */
const CONVERSATION_CHANNEL = GROUP_TASK_CONVERSATION_CHANNEL;
const DELIVERABLE_TAG = /\[DELIVERABLE\]/i;
const STATUS_TAG = /\[STATUS:\s*(EXECUTING|REVIEW)\s*\]/i;
/**
 * HITL checkpoint tags (chair-only, same trust rule as STATUS tags):
 * `[CHECKPOINT: <topic>]` pauses the task for the owner's decision;
 * `[CHECKPOINT_RESOLVED: <decision>]` resumes work. While a checkpoint is
 * open the daemon gates responders exactly like the review phase — workers
 * stay silent and only the owner's messages reach the chair.
 */
const CHECKPOINT_OPEN_TAG = /\[CHECKPOINT:\s*([^\]\n]+?)\s*\]/i;
const CHECKPOINT_RESOLVED_TAG = /\[CHECKPOINT_RESOLVED(?::\s*([^\]\n]+?)\s*)?\]/i;
/**
 * HITL: any checkpoint tag form, used to strip the tag(s) out of the chair's
 * message body when deriving the "what the owner must decide" summary.
 * Matches `[CHECKPOINT]`, `[CHECKPOINT: topic]`, `[CHECKPOINT_RESOLVED]` and
 * `[CHECKPOINT_RESOLVED: decision]`.
 */
const CHECKPOINT_ANY_TAG = /\[CHECKPOINT(?:_[A-Z]+)?(?::[^\]]*)?\]/gi;
/** Escape hatch: a reply starting with the [NO_REPLY] tag is suppressed (not sent on-chain). */
const NO_REPLY_PATTERN = /^\[NO_REPLY\]/i;
/**
 * P0-2: worker ACK/progress status tag, e.g.
 * `[WORKING] 已接单，正在做X，预计N分钟` — the worker-to-group "I am alive and
 * working" signal. The tag also feeds the member workStatus readout (P1-4).
 */
const WORKING_TAG = /\[WORKING\]/i;
/** P0-2: kv guard so one dispatch produces at most ONE host ACK. */
const ACK_KV_PREFIX = 'group_task_ack:';
/**
 * P2-6: dependency annotation on a dispatch message, e.g.
 * `[DEPENDS_ON: <64hex pinid>]` — the host holds the worker dispatch until the
 * referenced upstream deliverable lands (bounded wait, then proceeds).
 */
const DEPENDS_ON_TAG = /\[DEPENDS_ON:\s*([^\]]+)\]/i;
const DEP_WAIT_KV_PREFIX = 'group_task_dep_wait:';
/**
 * P2-8: multi-driver mutex — kv heartbeat claim per task
 * (`group_task_driver:<taskId>` = `<instanceId>|<epochMs>`). Only the most
 * recently claiming daemon instance drives a task; others yield. Exported so
 * the service can surface the current driver in the task detail.
 */
export const GROUP_TASK_DRIVER_KV_PREFIX = 'group_task_driver:';
/** Default grace: a driver claim this old (or older) is stale — claimable. */
export const DEFAULT_DRIVER_GRACE_MS = 20_000;
/** Default bounded wait for an upstream deliverable referenced by [DEPENDS_ON]. */
const DEFAULT_DEPENDENCY_WAIT_MAX_MS = 15 * 60_000;

/**
 * 清单 #10 P-A: read a task session's messages for substantive-activity
 * detection. Tolerant — store errors yield [] so the EMPTY_HANDOFF judgment
 * degrades to the old behavior.
 */
function readTaskSessionActivityMessages(
  coworkStore: CoworkStore,
  sessionId: string,
): CoworkSessionActivityMessage[] {
  try {
    const page = coworkStore.getSessionMessagesPage(sessionId, { limit: 100 });
    return (page?.messages ?? []).map((message) => ({
      type: message.type,
      content: String(message.content ?? ''),
      metadata: (message.metadata ?? null) as Record<string, unknown> | null,
    }));
  } catch {
    return [];
  }
}

/**
 * P1-4 / round-4: lines carrying the [DELIVERABLE] protocol tag — the ONLY
 * source for deliverable URIs and kinds. Parsing is delegated to
 * groupTaskDeliverableParser (one row per tag occurrence, strict
 * placeholder/truncation filtering, 64-hex+i0 or ^https?:// validation);
 * URIs anywhere else in the message body never influence the outcome.
 */
const deliverableTagLines = (content: string): string[] =>
  content.split('\n').filter((line) => DELIVERABLE_TAG.test(line));

/**
 * HITL: derive the "what the owner must decide" summary from the chair's
 * [CHECKPOINT] message body — the body minus any checkpoint tags themselves.
 * The chair typically posts the draft/decision content in the same message
 * (e.g. "意见稿已整理好，见链接。 [CHECKPOINT: 意见稿确认]"), so the tag-free
 * remainder IS the decision summary; document links inside it survive
 * untouched. Returns null when only tags (or nothing) remain so callers can
 * fall back to the checkpoint topic.
 */
export function extractCheckpointDecisionSummary(content: string | null | undefined): string | null {
  const text = (content ?? '')
    .replace(CHECKPOINT_ANY_TAG, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0 ? text : null;
}

/**
 * HITL: one-line truncation of a decision summary for the pause ceremony line
 * and the detail banner. Cuts on a whitespace boundary when possible; the
 * full body always stays available in the group transcript.
 */
export function truncateCheckpointSummary(summary: string, maxLength = 120): string {
  const text = summary.trim();
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  const end = lastSpace > maxLength * 0.6 ? lastSpace : maxLength;
  return `${cut.slice(0, end).trimEnd()}…`;
}

const CHAIR_PLANNED_KV_PREFIX = 'group_task_chair_planned:';
const CHAIR_PLAN_ATTEMPTS_KV_PREFIX = 'group_task_chair_plan_attempts:';
const MAX_CHAIR_PLAN_ATTEMPTS = 3;
/** F1 (GT#11): settle-gate kv — last observed roster signature for a task. */
const CHAIR_PLAN_ROSTER_KV_PREFIX = 'group_task_chair_plan_roster:';
/**
 * F1 (GT#11): the chair planning turn must not fire while the roster is still
 * forming (createGroupTask persists the task row + chair member first, then
 * joins each worker with network-bound calls; a 5s daemon tick can otherwise
 * plan against a truncated roster and permanently misplan the task). Default:
 * wait until the roster is unchanged for this long.
 */
const DEFAULT_CHAIR_PLAN_ROSTER_SETTLE_MS = 20_000;
/**
 * F1 (GT#11): absolute cap — planning proceeds once the task is older than
 * this, even if the roster keeps changing (join failures/retries), so a task
 * can never sit in 'planning' forever behind the settle gate.
 */
const DEFAULT_CHAIR_PLAN_ROSTER_CAP_MS = 10 * 60_000;

/**
 * Owner-report guard: one private A2A report per task per review-entry. The
 * rework hatch (review -> executing) clears it so the NEXT review re-reports.
 * Exported so the reopen service path clears the same guard.
 */
export const GROUP_TASK_OWNER_REPORTED_KV_PREFIX = 'group_task_owner_reported:';
/**
 * HITL checkpoint-report guard: one private A2A checkpoint request per
 * checkpoint (`group_task_checkpoint_reported:<taskId>:<checkpointId>`).
 */
const GROUP_TASK_CHECKPOINT_REPORTED_KV_PREFIX = 'group_task_checkpoint_reported:';
const ACK_PENDING_PREFIX = 'group_task_ack_pending:';
const ACK_REMINDED_PREFIX = 'group_task_ack_reminded:';
/**
 * P1-4: ack-seen marker — the worker ACKed (or implicitly engaged on) an
 * assignment message, recorded as `group_task_ack_seen:<taskId>:<messageId>`.
 * Derived [DEPENDS_ON] assignments inherit the upstream ack-seen so the ACK
 * watchdog never starts a fresh 3-min watch on an already-engaged chain, and
 * a re-processed assignment message (cursor retry) never re-arms the watch.
 */
const ACK_SEEN_PREFIX = 'group_task_ack_seen:';
const EXPECTED_DELIVERY_PREFIX = 'group_task_expected_delivery:';
const DELIVERY_REMINDED_PREFIX = 'group_task_delivery_reminded:';
const MSG_RETRY_PREFIX = 'group_task_msg_retry:';
/**
 * #14 follow-up: when a worker turn already in flight lands AFTER the chair's
 * closing ceremony (so the last group message is a worker's, not the host's),
 * the chair re-posts the closing line. This kv stores the straggler message id
 * the re-assert already covered, so each straggler triggers exactly one re-post
 * (and a second tick with no new straggler stays quiet).
 */
const GROUP_TASK_REVIEW_REASSERT_KV_PREFIX = 'group_task_review_reassert:';
/** Round-4: a message failing this many consecutive ticks is dropped (cursor advances). */
const MSG_RETRY_MAX_FAILURES = 5;
/**
 * #13 join-welcome bookkeeping (handshake protocol): the first tick snapshots
 * the initially-joined member keys (create-time roster) under
 * `group_task_welcome_initial_joined:<taskId>`; any member whose joined_pin_id
 * appears LATER (esp. a remote OpenTeam member whose join just confirmed) and
 * is not yet welcomed under `group_task_welcome_done:<taskId>:<memberKey>`
 * gets ONE welcome broadcast as the chair.
 */
const WELCOME_INITIAL_JOINED_PREFIX = 'group_task_welcome_initial_joined:';
const WELCOME_DONE_PREFIX = 'group_task_welcome_done:';

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
 * OpenTeam M2: an offline remote teammate (metabotId == null) whose latest
 * group message is older than this window counts as "unreachable" — injected
 * into the chair's turn context and reported to the owner once per streak.
 */
const DEFAULT_REMOTE_UNREACHABLE_AFTER_MS = 10 * 60_000;
/**
 * OpenTeam M2: presence probes cost an API call — at most one probe per task
 * per this interval (in-memory throttle; failed probes also throttle).
 */
const DEFAULT_REMOTE_PRESENCE_THROTTLE_MS = 60_000;
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
  /**
   * HITL: true while the task has an open human checkpoint. Responder gating
   * treats this exactly like the review phase (workers silent, chair talks to
   * the owner only). Populated by the daemon loop per message.
   */
  hasOpenCheckpoint?: boolean;
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
 * - Human-gate phases (status === 'review' OR an open HITL checkpoint): workers
 *   NEVER respond (even when mentioned); the chair responds ONLY to owner
 *   messages. No floor-control, deliverable, or mention triggers in a human-gate
 *   phase (hard silence against gratitude loops).
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
  // HITL: an open human checkpoint pauses the task exactly like the review
  // phase — the group waits for the owner's decision, not for more work.
  const isHumanGatePhase = task.status === 'review' || task.hasOpenCheckpoint === true;

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
      // Human-gate phases (review / open HITL checkpoint): workers never
      // respond, even when @-mentioned.
      if (!isHumanGatePhase && mentioned) {
        decisions.push({ metabotId: member.metabotId, reason: 'worker_mentioned' });
      }
      continue;
    }

    // chair
    const bossGlobalMetaId = (bot.boss_global_metaid ?? '').trim();
    const isOwnerMessage = Boolean(
      senderGlobalMetaId && bossGlobalMetaId && senderGlobalMetaId === bossGlobalMetaId,
    );
    if (isHumanGatePhase) {
      // Human-gate phases: the chair responds only to the owner (acceptance /
      // checkpoint dialogue).
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

/**
 * F1 (GT#11): deterministic signature of the ACTIVE member roster as seen by
 * the chair planning turn. Any member add / remove / role change produces a
 * new signature, so the planning-turn settle gate can detect a roster that is
 * still forming mid-create (the task row + chair member are persisted first,
 * then each worker joins with network-bound calls). Pure + exported for unit
 * tests.
 */
export function buildRosterSignature(members: Array<{
  role: string;
  name?: string | null;
  displayName?: string | null;
  globalmetaid?: string | null;
  metabotId?: number | null;
}>): string {
  return members
    .map((member) => {
      const name = (member.name ?? member.displayName ?? '').trim();
      const gmid = (member.globalmetaid ?? '').trim();
      const id = member.metabotId ?? '';
      return `${member.role}|${name}|${gmid}|${id}`;
    })
    .sort()
    .join(';');
}

/** Minimal kv surface needed by the driver-claim helpers. */
export interface GroupTaskDriverKv {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
  delete(key: string): void;
}

/** Outcome of tryAcquireGroupTaskDriver. */
export interface AcquireGroupTaskDriverResult {
  ok: boolean;
  /** Claim holder identity when rejected (null when acquired). */
  driverId: string | null;
  /** Claim age in ms when rejected. */
  claimAgeMs: number;
  /** ms to wait before retrying (grace minus claim age). */
  retryAfterMs: number;
}

/**
 * F2 (GT#11): shared driver-claim acquisition used by BOTH the daemon tick
 * (claimDriverOrYield) and the manual RPC send path. Semantics (heartbeat
 * claim, kv `group_task_driver:<taskId>` = `<claimId>|<epochMs>`):
 * - no claim -> acquire;
 * - own claim -> ok (refreshOwn=false keeps the claim age-based so the daemon
 *   holds it only while it actually drives; refreshOwn=true extends it);
 * - foreign claim younger than the grace window -> rejected (mutual exclusion);
 * - stale foreign claim -> take over.
 * Pure + exported for unit tests.
 */
export function tryAcquireGroupTaskDriver(
  kv: GroupTaskDriverKv,
  taskId: number,
  claimId: string,
  graceMs: number,
  nowMs: number,
  refreshOwn = true,
): AcquireGroupTaskDriverResult {
  const key = `${GROUP_TASK_DRIVER_KV_PREFIX}${taskId}`;
  const raw = kv.get<string>(key);
  if (!raw) {
    kv.set(key, `${claimId}|${nowMs}`);
    return { ok: true, driverId: null, claimAgeMs: 0, retryAfterMs: 0 };
  }
  const [ownerId, atText] = raw.split('|');
  const atMs = Number(atText) || 0;
  if (ownerId === claimId) {
    if (refreshOwn) {
      kv.set(key, `${claimId}|${nowMs}`); // refresh our own lease
    }
    return { ok: true, driverId: null, claimAgeMs: 0, retryAfterMs: 0 };
  }
  const ageMs = nowMs - atMs;
  if (ageMs < graceMs) {
    return { ok: false, driverId: ownerId, claimAgeMs: Math.max(0, ageMs), retryAfterMs: Math.max(0, graceMs - ageMs) };
  }
  kv.set(key, `${claimId}|${nowMs}`); // stale claim -> take over
  return { ok: true, driverId: null, claimAgeMs: 0, retryAfterMs: 0 };
}

/** Input of gateChairDrivingSend. */
export interface GateChairDrivingSendInput {
  kv: GroupTaskDriverKv;
  taskId: number;
  /** Resolved sender metabot id of the outgoing message. */
  senderMetabotId: number;
  /** Chair metabot id of the task (driving sends are chair-identity sends). */
  chairMetabotId: number;
  /**
   * Optional per-session driver identity supplied by the caller (e.g. the
   * Twin session id). Sessions that pass the same id refresh each other's
   * claim; sessions with DIFFERENT ids are mutually exclusive. Defaults to
   * `rpc:<chairMetabotId>` when omitted.
   */
  driverId?: string;
  graceMs: number;
  nowMs: number;
}

/**
 * F2 (GT#11): session-level driving mutex for the manual send path. Worker /
 * owner messages are never driving and always pass. A CHAIR-identity message
 * (plan / dispatch / status switch) participates in the driver claim: it is
 * rejected with a readable error while another session holds a fresh claim
 * (e.g. the daemon auto-driver is mid-turn), and it takes the claim otherwise
 * (the daemon then yields its ticks while the manual claim stays fresh).
 * Pure + exported for unit tests.
 */
export function gateChairDrivingSend(input: GateChairDrivingSendInput):
  { ok: true } | { ok: false; error: string; retryAfterMs: number; driverId: string } {
  if (input.senderMetabotId !== input.chairMetabotId) {
    return { ok: true };
  }
  const claimId = (input.driverId ?? '').trim() || `rpc:${input.chairMetabotId}`;
  const result = tryAcquireGroupTaskDriver(input.kv, input.taskId, claimId, input.graceMs, input.nowMs);
  if (!result.ok) {
    const holder = result.driverId ?? 'unknown';
    return {
      ok: false,
      driverId: holder,
      retryAfterMs: result.retryAfterMs,
      error:
        `Task ${input.taskId} is being driven by another session (${holder.slice(0, 12)}…) — ` +
        `the driver claim is ${Math.round(result.claimAgeMs / 1000)}s old; retry in ` +
        `${Math.ceil(result.retryAfterMs / 1000)}s or wait for the active driver to yield ` +
        `(same-session sends pass driver_id to keep driving)`,
    };
  }
  return { ok: true };
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
  opts?: { replyPin?: string; mention?: string[] },
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
    /** 'review' (default) = the acceptance report; 'checkpoint' = a HITL checkpoint request. */
    kind?: 'review' | 'checkpoint';
    checkpointId?: number | null;
    at: number;
  }
  | {
    /** HITL: a checkpoint was opened/resolved so the UI can refresh the detail view. */
    type: 'groupTask:checkpointChanged';
    taskId: number;
    checkpointId: number;
    status: 'open' | 'resolved';
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
  /** 'review' (default) = acceptance report; 'checkpoint' = HITL checkpoint request. */
  kind?: 'review' | 'checkpoint';
  checkpointId?: number;
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

/**
 * OpenTeam M2: online-presence probe for remote teammates (wired to
 * IdchatPresenceService.fetchOnlineStatus in main.ts). One entry per queried
 * GlobalMetaID; a peer with no entry (or isOnline=false) counts as offline.
 */
export interface GroupTaskRemotePresenceEntry {
  globalMetaId: string;
  isOnline: boolean;
  /** Seconds since the peer was last seen online (0/negative = unknown). */
  lastSeenAgoSeconds: number;
}

export type GroupTaskDaemonFetchRemotePresenceFn = (
  globalMetaIds: string[],
) => Promise<GroupTaskRemotePresenceEntry[]>;

export interface GroupTaskDaemonDeps {
  getStore: () => GroupTaskDaemonSqliteStoreLike;
  getGroupTaskStore: () => GroupTaskStore;
  getMetabotStore: () => MetabotStore;
  getCoworkStore: () => CoworkStore;
  /**
   * P1-3: OpenTeam invite store. When wired, the chair planning directive
   * carries the task's pending invites / unconfirmed remote placeholders so
   * the plan never re-decomposes "search + invite" as a subtask after the
   * chair already invited someone. Unwired = the directive stays as before.
   */
  getOpenTeamMembershipStore?: () => OpenTeamMembershipStore;
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
  /**
   * OpenTeam M2: presence probe for remote-teammate unreachable detection.
   * Unwired = the feature stays off (no prompt injection, no owner alert).
   */
  fetchRemotePresence?: GroupTaskDaemonFetchRemotePresenceFn;
  /** Silence window (ms) after which an offline remote teammate is unreachable. */
  remoteUnreachableAfterMs?: number;
  /** Per-task minimum interval (ms) between presence probes. */
  remotePresenceThrottleMs?: number;
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
   * F1 (GT#11): how long (ms) the member roster must stay unchanged before the
   * chair planning turn may fire for a new task. Guards against planning
   * mid-create with a half-formed roster. 0 disables the settle gate.
   * Default DEFAULT_CHAIR_PLAN_ROSTER_SETTLE_MS.
   */
  chairPlanRosterSettleMs?: number;
  /**
   * F1 (GT#11): absolute cap (ms from task creation) — planning proceeds even
   * if the roster never settles. Default DEFAULT_CHAIR_PLAN_ROSTER_CAP_MS.
   */
  chairPlanRosterCapMs?: number;
  /**
   * P0-2 (round 5): host auto-ACK for worker dispatches that will run a skill
   * turn — posts `[WORKING] 已接单…` BEFORE the (potentially long) turn so the
   * group never sees a silent worker (Eleven-style 11-min silence). Default ON.
   */
  autoAckWorkerDispatch?: boolean;
  /**
   * P2-6 (round 5): bounded wait for a `[DEPENDS_ON: <pinid>]` upstream
   * deliverable before dispatching the worker (default 15 min).
   */
  dependencyWaitMaxMs?: number;
  /**
   * P2-8 (round 5): multi-driver mutex grace. A driver claim younger than this
   * window belongs to another daemon instance; this instance yields. Default
   * DEFAULT_DRIVER_GRACE_MS. 0 disables the mutex entirely.
   */
  driverGraceMs?: number;
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

/**
 * P1-4: resolve a chair message's [DEPENDS_ON] reference to the upstream
 * assignment the worker ACKed. Returns:
 * - null: the message is NOT a derived assignment (no [DEPENDS_ON] tag);
 * - '' (falsy): derived assignment whose upstream cannot be verified as ACKed
 *   (descriptive reference, pinid not found in this group's messages, or the
 *   upstream message has no ack-seen) → the caller starts a normal watch;
 * - a pinid: derived assignment whose upstream message IS ack-seen → the
 *   caller inherits the upstream ACK and starts no new watch.
 */
export function resolveDerivedAssignmentUpstream(
  task: GroupTask,
  message: { content: string | null },
  sqlite: GroupTaskDaemonSqliteStoreLike,
): string | null {
  const content = (message.content ?? '').trim();
  const match = DEPENDS_ON_TAG.exec(content);
  if (!match) return null;
  const token = match[1].trim();
  const tokenPin = token.match(/^[0-9a-f]{64}i0$/i)?.[0]?.toLowerCase() ?? null;
  if (!tokenPin || !task.groupId) return '';
  let upstreamMessageId: number | null = null;
  try {
    const db = sqlite.getDatabase();
    const result = db.exec(
      'SELECT id FROM group_chat_messages WHERE group_id = ? AND pin_id = ? LIMIT 1',
      [task.groupId, tokenPin],
    );
    const rawId = result[0]?.values?.[0]?.[0];
    upstreamMessageId = typeof rawId === 'number' ? rawId : Number(rawId);
    if (!Number.isInteger(upstreamMessageId) || (upstreamMessageId as number) <= 0) {
      upstreamMessageId = null;
    }
  } catch {
    return '';
  }
  if (upstreamMessageId == null) return '';
  const seen = sqlite.get<string>(`${ACK_SEEN_PREFIX}${task.id}:${upstreamMessageId}`);
  return seen === '1' ? tokenPin : '';
}

/**
 * P1-3: build the OpenTeam status block for the chair planning directive.
 * Collects the task's LIVE pending invites (openteam_invites.status='pending')
 * plus remote placeholder members whose join never confirmed (member row with
 * joined_pin_id NULL, no invite pending — the invite expired or the join
 * watcher gave up). The block tells the chair NOT to decompose
 * "search + invite a remote bot" as a subtask: the invitation is already out
 * (or already failed), and re-inviting would hit the server's duplicate guard.
 * Empty string when there is nothing to report (or the store is unwired).
 */
export function buildOpenTeamPlanningStatusBlock(
  membershipStore: OpenTeamMembershipStore | undefined,
  task: GroupTask,
  groupTaskStore: GroupTaskStore,
): string {
  if (!membershipStore || !task.groupId) return '';
  const pending = membershipStore
    .listPendingInvites()
    .filter((invite) => invite.taskId === task.id);
  const inviteeGmids = new Set(
    pending.map((invite) => invite.inviteeGlobalmetaid.trim().toLowerCase()),
  );
  const placeholders = groupTaskStore
    .listMembers(task.id)
    .filter(
      (member) =>
        member.metabotId == null
        && !member.joinedPinId
        && !inviteeGmids.has((member.globalmetaid ?? '').trim().toLowerCase()),
    );
  if (pending.length === 0 && placeholders.length === 0) return '';

  const lines: string[] = [
    '[OpenTeam invites already sent — host facts, NOT suggestions]',
  ];
  if (pending.length > 0) {
    lines.push(
      'The chair has already invited remote bot(s) below; they have NOT joined yet ' +
      '(invites are pending, waiting for the guest machine to accept and join on-chain).',
    );
    for (const invite of pending) {
      const label = invite.inviteeName?.trim() || invite.inviteeGlobalmetaid;
      lines.push(
        `- ${label} (${invite.inviteeGlobalmetaid}): pending since ${invite.createdAt ?? 'unknown'}`,
      );
    }
    lines.push(
      'Do NOT plan a "search for a remote bot / invite a remote bot" subtask for these ' +
      '— the invite is already out and a duplicate invite is rejected by the server. ' +
      'Plan their work as post-join assignments (only if they join), or proceed with ' +
      'the current roster without them.',
    );
  }
  for (const member of placeholders) {
    const label = member.displayName?.trim() || member.globalmetaid;
    lines.push(
      `- ${label} (${member.globalmetaid}): remote member placeholder, join never confirmed ` +
      '(previous invite expired or timed out) — do not plan work for it as if joined; ' +
      're-invite it yourself if you want it, else drop it from the plan.',
    );
  }
  return lines.join('\n');
}

/**
 * #13 handshake: the welcome text for a member joining a task AFTER the
 * initial roster (especially a remote OpenTeam member). It states who joined
 * and why (invite required-skills), tells the joiner to greet the group and
 * confirm presence BEFORE starting work, and asks the existing members for a
 * ONE-round online confirmation. The existing members' mention-gated replies
 * ARE the handshake round; their confirmations carry no mentions, so nothing
 * replies to them and the ritual stops after one round ([NO_REPLY] discipline
 * stays intact — only explicitly @-addressed members speak).
 */
export function buildMemberJoinWelcomeText(input: {
  taskId: number;
  taskTitle: string;
  joinerName: string;
  /** Why the joiner was invited (invite required-skills summary); null for plain invites. */
  invitedFor?: string | null;
  /** Display names of existing local members (NOT the joiner, NOT the chair). */
  existingMemberNames: string[];
}): string {
  const why = input.invitedFor?.trim()
    ? `受邀参与:${input.invitedFor.trim()}`
    : '受邀参与本任务协作';
  const lines = [
    `🎉 欢迎 @${input.joinerName} 加入任务「${input.taskTitle}」!`,
    `${input.joinerName} ${why}。`,
    `@${input.joinerName}:请先向群内打个招呼确认就位,再开始工作。`,
  ];
  const names = input.existingMemberNames.map((name) => name.trim()).filter(Boolean);
  if (names.length > 0) {
    lines.push(`${names.map((name) => `@${name}`).join(' ')}:请确认在线(每人一次即可,无需客套)。`);
  }
  return lines.join('\n');
}

/**
 * #14: the system closing line the chair posts when a task enters review (and
 * re-posts when a worker straggler buries it). It is the message that must rest
 * last while the task awaits human acceptance — never a worker's [WORKING].
 * Wording is de-#id (no task number in user-visible text), matching the
 * chair-lifecycle autonomy pass.
 */
const buildReviewClosingLine = (task: { title: string }): string =>
  `📦 任务「${task.title}」所有步骤已完成,进入验收阶段,等待人类评审。`;

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
  const autoAckWorkerDispatch = deps.autoAckWorkerDispatch !== false;
  const dependencyWaitMaxMs = Math.max(
    1_000,
    Math.trunc(deps.dependencyWaitMaxMs ?? DEFAULT_DEPENDENCY_WAIT_MAX_MS),
  );
  const driverGraceMs = Math.max(0, Math.trunc(deps.driverGraceMs ?? DEFAULT_DRIVER_GRACE_MS));
  const driverInstanceId = randomUUID();
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
  const remoteUnreachableAfterMs = Math.max(
    1_000,
    Math.trunc(deps.remoteUnreachableAfterMs ?? DEFAULT_REMOTE_UNREACHABLE_AFTER_MS),
  );
  const remotePresenceThrottleMs = Math.max(
    1_000,
    Math.trunc(deps.remotePresenceThrottleMs ?? DEFAULT_REMOTE_PRESENCE_THROTTLE_MS),
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

  // ---------------------------------------------------------------------
  // OpenTeam M2: remote-teammate unreachable detection (in-memory only).
  // ---------------------------------------------------------------------

  interface RemoteUnreachableInfo {
    globalMetaId: string;
    name: string;
    /** Seconds since the peer was last seen online; null = unknown. */
    offlineSeconds: number | null;
    /** Seconds since its latest group message; null = never posted here. */
    silentSeconds: number | null;
  }

  interface RemotePresenceSnapshot {
    queriedAt: number;
    unreachable: RemoteUnreachableInfo[];
  }

  /** Latest presence evaluation per task; refreshed at most once per throttle window. */
  const remotePresenceByTask = new Map<number, RemotePresenceSnapshot>();
  /** `${taskId}:${globalMetaId}` keys already owner-notified for the CURRENT unreachable streak. */
  const remoteUnreachableNotified = new Set<string>();

  /**
   * P2-8: multi-driver mutex — kv heartbeat claim. Returns true when THIS
   * daemon instance may drive the task this tick: no claim exists, the claim
   * is stale (older than the grace window), or the claim is ours. Returns
   * false when ANOTHER instance claimed within the grace window — the tick
   * yields entirely (no heartbeat, no planning, no message processing), so
   * two chair sessions never double-drive the same task.
   *
   * F2 (GT#11): the daemon does NOT refresh its own claim at tick top anymore
   * — the claim stays fresh only while the daemon ACTUALLY drives (see
   * refreshDriverClaim after each post). A fresh foreign claim therefore means
   * "another session is driving RIGHT NOW", which is exactly what the manual
   * RPC send gate needs to reject duplicate driving.
   */
  const claimDriverOrYield = (taskId: number): boolean => {
    if (driverGraceMs <= 0) return true;
    const result = tryAcquireGroupTaskDriver(deps.getStore(), taskId, driverInstanceId, driverGraceMs, now(), false);
    if (result.ok) return true;
    emitLog(
      `[GroupTaskDaemon] Task ${taskId}: another chair session (${(result.driverId ?? 'unknown').slice(0, 8)}…) ` +
      `holds the driver claim (${Math.round(result.claimAgeMs / 1000)}s old); this instance yields this tick`,
    );
    return false;
  };

  /**
   * F2 (GT#11): refresh our driver claim AFTER an actual drive (a group
   * message post). The claim then ages out during idle ticks, letting a
   * manual chair session take the floor the moment the auto driver goes
   * quiet — and vice versa the daemon yields while a manual claim is fresh.
   */
  const refreshDriverClaim = (taskId: number): void => {
    if (driverGraceMs <= 0) return;
    deps.getStore().set(`${GROUP_TASK_DRIVER_KV_PREFIX}${taskId}`, `${driverInstanceId}|${now()}`);
  };

  /**
   * F2 (GT#11): single choke point for every daemon group-message post —
   * refreshes the driver claim on success so the claim freshness mirrors
   * actual driving activity.
   */
  const postGroupMessage = async (
    taskId: number,
    metabotId: number,
    content: string,
    opts?: { replyPin?: string; mention?: string[] },
  ): Promise<{ pinId: string }> => {
    const result = await deps.postGroupTaskMessage(taskId, metabotId, content, opts);
    refreshDriverClaim(taskId);
    return result;
  };

  /**
   * P2-6: [DEPENDS_ON: <token>] gate. Pinid/txid-shaped tokens are enforced
   * against the task's recorded deliverables (the worker dispatch is held
   * until the upstream deliverable lands); free-text descriptions are
   * advisory only — the prompt protocol carries the "wait for upstream
   * [DELIVERABLE]" wording for those.
   */
  const dependencyStatus = (
    task: GroupTask,
    message: GroupTaskDaemonMessage,
  ): { token: string | null; satisfied: boolean } => {
    const match = DEPENDS_ON_TAG.exec(message.content ?? '');
    if (!match) return { token: null, satisfied: true };
    const token = match[1].trim();
    const pinish = PINID_FORMAT.test(token) || TXID_FORMAT.test(token);
    if (!pinish) return { token, satisfied: true };
    const lower = token.toLowerCase();
    const deliverables = deps.getGroupTaskStore().listDeliverables(task.id);
    const satisfied = deliverables.some((deliverable) =>
      (deliverable.msgPinId ?? '').toLowerCase() === lower
      || (deliverable.uri ?? '').toLowerCase().includes(lower),
    );
    return { token, satisfied };
  };

  /**
   * P0-2: host auto-ACK — post a `[WORKING] 已接单…` status line BEFORE a
   * worker's long (skill-turn) dispatch reply, so the group sees the worker
   * accepted the job instead of a silent gap (the Eleven-style 11-minute
   * silence case). The ACK text is produced by a fast LLM call; on any
   * failure a template line is posted instead. kv-guarded per
   * (task, bot, message) so deferred retries never double-ACK.
   */
  const maybeSendWorkerAck = async (
    task: GroupTask,
    bot: GroupTaskDaemonBotFull,
    message: GroupTaskDaemonMessage,
    baseSystemPrompt: string,
    llmId: string | undefined,
    fallbackLlmId: string | null,
  ): Promise<void> => {
    if (!autoAckWorkerDispatch) return;
    const sqlite = deps.getStore();
    const ackKey = `${ACK_KV_PREFIX}${task.id}:${bot.id}:${message.id}`;
    if (sqlite.get<string>(ackKey) === '1') return;
    const objective = (message.content ?? '').trim().slice(0, 120) || 'assigned work';
    const directive = [
      '[SYSTEM ACK directive — generated by the host, not a group participant]',
      'You were just assigned work in the group task. Reply with EXACTLY ONE line that starts with `[WORKING]`, says you have accepted the job, briefly what you are doing and your estimated time, e.g. `[WORKING] 已接单，正在做X，预计N分钟` (reply in the language of the assignment). No other text.',
      '',
      `The assignment: ${objective}`,
    ].join('\n');
    let ackText = '';
    try {
      ackText = (await deps.performChat(baseSystemPrompt, directive, llmId, {
        fallbackLlmId,
        thinking: 'disabled',
      })).trim();
    } catch (error) {
      emitLog(
        `[GroupTaskDaemon] Task ${task.id}: worker ACK chat failed for bot ${bot.id}; using template: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!ackText || NO_REPLY_PATTERN.test(ackText) || !WORKING_TAG.test(ackText)) {
      ackText = `[WORKING] 已接单，正在处理「${objective}」，预计需要一些时间。`;
    }
    try {
      const sent = await postGroupMessage(task.id, bot.id, ackText, {
        // R5: the ACK is a direct response to the chair's assignment message —
        // thread it under that pin so the group reads as a conversation.
        replyPin: message.pinId ?? undefined,
      });
      sqlite.set(ackKey, '1');
      emitLog(`[GroupTaskDaemon] Task ${task.id}: worker ${bot.id} ACK posted (pin ${sent.pinId})`);
    } catch (error) {
      emitLog(
        `[GroupTaskDaemon] Task ${task.id}: worker ACK send failed for bot ${bot.id} (retried on next turn): ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
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

  /**
   * OpenTeam M2: chain timestamp (seconds) of the sender's latest message in
   * this group; null when the peer never posted (or rows lack timestamps).
   */
  const queryLastSenderMessageChainSec = (
    db: Database,
    groupId: string,
    senderGlobalMetaId: string,
  ): number | null => {
    const result = db.exec(
      `SELECT MAX(chain_timestamp) FROM group_chat_messages
       WHERE group_id = ? AND sender_global_metaid = ?`,
      [groupId, senderGlobalMetaId],
    );
    const value = result[0]?.values?.[0]?.[0];
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };

  const toMinutesText = (seconds: number): string => `${Math.max(1, Math.round(seconds / 60))} min`;

  const formatRemoteUnreachableFacts = (info: RemoteUnreachableInfo): string => {
    const offlineText = info.offlineSeconds != null
      ? `offline for ~${toMinutesText(info.offlineSeconds)}`
      : 'offline (last-seen unknown)';
    const silentText = info.silentSeconds != null
      ? `no message for ${toMinutesText(info.silentSeconds)}`
      : 'no message in this task yet';
    return `${offlineText}, ${silentText}`;
  };

  /**
   * OpenTeam M2: neutral fact block for the chair turn (roster-adjacent). The
   * wording states host-observed facts only — the playbook rules on remote
   * no-shows already tell the chair how to react, so the block just points
   * back at them. Purely real-time: when the teammate is reachable again the
   * next evaluation returns an empty list and the hint disappears.
   */
  const buildRemoteStatusBlock = (infos: RemoteUnreachableInfo[]): string => {
    if (infos.length === 0) return '';
    return [
      '[Remote teammate status — host-observed facts]',
      ...infos.map(
        (info) => `- ${info.name} (remote teammate) is currently unreachable: ${formatRemoteUnreachableFacts(info)}.`,
      ),
      'Apply your playbook rules for unresponsive remote teammates (re-assign the work and/or explain the change to the owner) as you judge fit.',
    ].join('\n');
  };

  /**
   * OpenTeam M2: evaluate remote teammates (metabotId == null, globalmetaid
   * set) of one ACTIVE task and return the currently-unreachable ones.
   * "Unreachable" = presence says offline AND no group message within
   * remoteUnreachableAfterMs. Probes are throttled to one per task per
   * remotePresenceThrottleMs; between probes the cached snapshot is reused so
   * the chair hint stays stable. A failed probe silently keeps the previous
   * snapshot (first failure => empty). Side effect: the FIRST evaluation that
   * finds a teammate unreachable sends one private owner brief via
   * sendOwnerPrivateReport; the flag resets when the teammate is reachable
   * again or the task leaves the active set (pruned in runTick).
   */
  const evaluateRemoteTeammates = async (
    task: GroupTask,
    members: GroupTaskMember[],
    botsById: Map<number, GroupTaskDaemonBotFull>,
    ownerGlobalMetaId: string,
  ): Promise<RemoteUnreachableInfo[]> => {
    if (!task.groupId) return [];
    const remoteMembers = members.filter(
      (member) => member.metabotId == null && Boolean(member.globalmetaid?.trim()),
    );
    // A kicked member leaves the active remote set while the task itself stays
    // active: its owner-notified key would otherwise linger forever and
    // suppress a fresh notification when a re-invited teammate goes silent
    // again. Prune stale keys for this task on every evaluation round.
    const activeRemoteGmids = new Set(
      remoteMembers.map((member) => member.globalmetaid!.trim().toLowerCase()),
    );
    for (const key of [...remoteUnreachableNotified]) {
      const separator = key.indexOf(':');
      if (Number(key.slice(0, separator)) !== task.id) continue;
      if (!activeRemoteGmids.has(key.slice(separator + 1))) {
        remoteUnreachableNotified.delete(key);
      }
    }
    if (remoteMembers.length === 0) {
      remotePresenceByTask.delete(task.id);
      return [];
    }
    if (!deps.fetchRemotePresence) return [];

    const cached = remotePresenceByTask.get(task.id);
    if (cached && now() - cached.queriedAt < remotePresenceThrottleMs) {
      return cached.unreachable;
    }

    let entries: GroupTaskRemotePresenceEntry[];
    try {
      entries = await deps.fetchRemotePresence(
        remoteMembers.map((member) => member.globalmetaid!.trim()),
      );
    } catch (error) {
      // Silent skip: keep the previous snapshot, throttle the next attempt.
      remotePresenceByTask.set(task.id, {
        queriedAt: now(),
        unreachable: cached?.unreachable ?? [],
      });
      emitLog(
        `[GroupTaskDaemon] Task ${task.id}: remote presence probe failed; keeping previous snapshot: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
      return cached?.unreachable ?? [];
    }

    const db = deps.getStore().getDatabase();
    const nowSec = Math.floor(now() / 1000);
    const unreachable: RemoteUnreachableInfo[] = [];
    for (const member of remoteMembers) {
      const globalMetaId = member.globalmetaid!.trim();
      // Join grace: a teammate whose membership row is younger than the
      // unreachable window has not had a fair chance to speak yet — never
      // flag them unreachable (and never notify the owner) this early.
      const joinedMs = parseSqliteUtcMs(member.createdAt);
      if (Number.isFinite(joinedMs) && now() - joinedMs < remoteUnreachableAfterMs) {
        continue;
      }
      const entry = entries.find(
        (candidate) => candidate.globalMetaId.trim().toLowerCase() === globalMetaId.toLowerCase(),
      );
      if (entry?.isOnline) continue; // reachable — no hint, notification flag resets below
      const lastMessageSec = queryLastSenderMessageChainSec(db, task.groupId, globalMetaId);
      const silentSeconds = lastMessageSec != null ? Math.max(0, nowSec - lastMessageSec) : null;
      if (silentSeconds != null && silentSeconds * 1000 < remoteUnreachableAfterMs) {
        continue; // offline but recently active in the group — not unreachable
      }
      const lastSeenAgoSeconds = Number(entry?.lastSeenAgoSeconds);
      unreachable.push({
        globalMetaId,
        name: member.name ?? `remote-${globalMetaId.slice(0, 10) || 'unknown'}`,
        offlineSeconds: Number.isFinite(lastSeenAgoSeconds) && lastSeenAgoSeconds > 0
          ? lastSeenAgoSeconds
          : null,
        silentSeconds,
      });
    }
    remotePresenceByTask.set(task.id, { queriedAt: now(), unreachable });

    // Owner brief: exactly once per (task, member) unreachable streak.
    const reachableAgain = remoteMembers.filter(
      (member) => !unreachable.some(
        (info) => info.globalMetaId.toLowerCase() === member.globalmetaid!.trim().toLowerCase(),
      ),
    );
    for (const member of reachableAgain) {
      remoteUnreachableNotified.delete(`${task.id}:${member.globalmetaid!.trim().toLowerCase()}`);
    }
    if (unreachable.length > 0 && deps.sendOwnerPrivateReport) {
      const chairMember = members.find((member) => member.role === 'chair');
      const chairBot = chairMember?.metabotId != null ? botsById.get(chairMember.metabotId) : undefined;
      for (const info of unreachable) {
        const notifyKey = `${task.id}:${info.globalMetaId.toLowerCase()}`;
        if (remoteUnreachableNotified.has(notifyKey)) continue;
        if (!chairBot || !ownerGlobalMetaId) break; // cannot address the owner; retry next probe
        try {
          await deps.sendOwnerPrivateReport({
            taskId: task.id,
            metabotId: chairBot.id,
            ownerGlobalMetaId,
            text:
              `[OpenTeam] Group task "${task.title}": remote teammate "${info.name}" ` +
              `appears unreachable (${formatRemoteUnreachableFacts(info)}). I have this fact in my ` +
              'context and will re-assign their part if the silence continues.',
          });
          remoteUnreachableNotified.add(notifyKey);
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: owner notified that remote teammate ${info.name} is unreachable`,
          );
        } catch (error) {
          // Not marked as notified — the next probe retries (throttled).
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: unreachable-owner-brief failed for ${info.name}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    return unreachable;
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
      `[Group Task "${task.title}" (#${task.id}) — recent group log (last ${contextMessageCount} messages)]`,
      ...lines,
    ].join('\n');
  };

  /**
   * Per-turn session lookup, delegated to the shared helper (groupTaskSession)
   * so the eager pre-creation path (invite/join) and the daemon always agree
   * on the SAME mapping (P1-3: one session-creation code path).
   */
  const ensureTaskSession = (
    coworkStore: CoworkStore,
    task: GroupTask,
    botId: number,
    botName: string,
  ): CoworkSession => ensureGroupTaskSession(coworkStore, task, botId, botName).session;

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

  /**
   * System-generated owner-report directive for the review transition. R1: the
   * directive no longer re-assembles the deliverable list itself — it reads the
   * host's deterministic acceptance summary (already published as the group's
   * last message) as the single source of truth and asks the chair only to
   * narrate it into a concise private report. The three channels (group summary
   * message, this private report, R2 source-session notification) thus render
   * from one record and cannot drift. Falls back to re-stating goal/criteria
   * inline when no summary has been persisted yet.
   */
  const buildOwnerReportDirective = (store: GroupTaskStore, task: GroupTask): string => {
    const summary = store.getLatestAcceptanceSummary(task.id);
    const deliverableLines = (summary?.deliverables ?? []).map(
      (deliverable) =>
        `- [${deliverable.kind ?? 'text'}] ${deliverable.uri ?? '(no uri)'} (${deliverable.status}, ${deliverable.confirmation}) — ${deliverable.authorName ?? 'unknown'}`,
    );
    return [
      '[SYSTEM owner-report directive — generated by the host, not by a group participant]',
      `The group task "${task.title}" just moved to REVIEW. The host has already posted a deterministic acceptance summary to the group (goal, deliverable list, verification, guidance) — that summary is reproduced verbatim below as the single source of truth. Compose a concise PRIVATE report to the owner that NARRATES it:`,
      '- Restate the goal briefly and lead with your conclusion.',
      '- Say what each member did (by name) and whether the deliverables are on-chain confirmed.',
      '- Recommend an action (accept & close, or request rework — of what). The owner only needs to confirm acceptance in the Tasks UI or send the task back for rework; never end with an open-ended "what would you like to do next?".',
      '',
      `Goal: ${summary?.goal ?? task.goal}`,
      `Acceptance criteria: ${(summary?.acceptanceCriteria ?? task.acceptanceCriteria)?.trim() || '(none specified)'}`,
      'Deliverables recorded (from the host acceptance summary):',
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
    const guardKey = `${GROUP_TASK_OWNER_REPORTED_KV_PREFIX}${task.id}`;
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
   * System-generated checkpoint-report directive: the chair composes a PRIVATE
   * message to the owner presenting the draft/decision the checkpoint is about
   * and asking for the owner's call (confirm, or request changes).
   */
  const buildCheckpointReportDirective = (
    store: GroupTaskStore,
    task: GroupTask,
    checkpoint: GroupTaskCheckpoint,
  ): string => {
    const deliverables = store.listDeliverables(task.id);
    const deliverableLines = deliverables.map(
      (deliverable) =>
        `- [${deliverable.kind ?? 'text'}] ${deliverable.uri ?? '(no uri)'} (status: ${deliverable.status})`,
    );
    return [
      '[SYSTEM checkpoint directive — generated by the host, not by a group participant]',
      `The group task "${task.title}" is PAUSED at a human checkpoint you opened${checkpoint.topic ? ` ("${checkpoint.topic}")` : ''}. Compose a concise PRIVATE message to the owner covering:`,
      '- What is ready for the owner to review NOW (the draft, plan, or decision point — include the actual content or a clear summary, not just a mention of it).',
      '- The specific decision you need from the owner before work continues.',
      '- How the owner can answer: reply in the task group, or tell you privately in this chat (you then relay the decision into the group).',
      '',
      `Task goal: ${task.goal}`,
      ...(deliverableLines.length > 0
        ? ['Deliverables recorded so far:', ...deliverableLines]
        : []),
    ].join('\n');
  };

  /**
   * Checkpoint owner notification: one private A2A message from the chair to
   * the owner per checkpoint (kv guard group_task_checkpoint_reported:<taskId>:
   * <checkpointId>). Mirrors maybeSendOwnerReport; the message is never posted
   * to the group and failures only log, never block the tick.
   */
  const maybeSendCheckpointReport = async (
    task: GroupTask,
    members: GroupTaskMember[],
    botsById: Map<number, GroupTaskDaemonBotFull>,
    promptMembers: DaemonPromptMember[],
    checkpoint: GroupTaskCheckpoint,
  ): Promise<void> => {
    if (!deps.sendOwnerPrivateReport) {
      emitLog(`[GroupTaskDaemon] Task ${task.id}: checkpoint report skipped (transport unavailable)`);
      return;
    }
    const sqlite = deps.getStore();
    const guardKey = `${GROUP_TASK_CHECKPOINT_REPORTED_KV_PREFIX}${task.id}:${checkpoint.id}`;
    if (sqlite.get<string>(guardKey) === '1') return;

    const chairMember = members.find((member) => member.role === 'chair');
    const bot = chairMember?.metabotId != null ? botsById.get(chairMember.metabotId) : undefined;
    const ownerGlobalMetaId = (bot?.boss_global_metaid ?? '').trim();
    if (!chairMember || !bot || !ownerGlobalMetaId) {
      emitLog(`[GroupTaskDaemon] Task ${task.id}: checkpoint report skipped (chair bot or owner GlobalMetaID unavailable)`);
      return;
    }

    try {
      const store = deps.getGroupTaskStore();
      const coworkStore = deps.getCoworkStore();
      const systemPromptParts = await buildTurnSystemPrompt(bot, task, promptMembers, 'chair', ownerGlobalMetaId);
      const systemPrompt = systemPromptParts.systemPrompt;
      // Volatile context (time + experience/cognition) rides the user turn.
      const directive = [systemPromptParts.volatileContext, buildCheckpointReportDirective(store, task, checkpoint)]
        .filter(Boolean)
        .join('\n\n');
      const llmId = normalizeMetabotLlmId(bot.llm_id) ?? undefined;
      const fallbackLlmId = normalizeMetabotLlmId(bot.fallback_llm_id);
      const report = (await deps.performChat(systemPrompt, directive, llmId, { fallbackLlmId, thinking: 'enabled' })).trim();
      if (!report || NO_REPLY_PATTERN.test(report)) {
        throw new Error('checkpoint report turn produced no message');
      }
      const delivery = await deps.sendOwnerPrivateReport({
        taskId: task.id,
        metabotId: bot.id,
        ownerGlobalMetaId,
        text: report,
        kind: 'checkpoint',
        checkpointId: checkpoint.id,
      });
      sqlite.set(guardKey, '1');
      deps.emitTaskEvent?.({
        type: 'groupTask:ownerReportDelivery',
        taskId: task.id,
        outcome: 'sent',
        pinId: delivery.pinId ?? null,
        sessionId: delivery.sessionId ?? null,
        displayError: delivery.displayError ?? null,
        kind: 'checkpoint',
        checkpointId: checkpoint.id,
        at: now(),
      });
      // Record the private checkpoint message in the chair's own group-task
      // session (context continuity), clearly marked as private.
      const session = ensureTaskSession(coworkStore, task, bot.id, bot.name);
      coworkStore.addMessage(session.id, {
        type: 'assistant',
        content: `[Private checkpoint request sent to the owner — not posted to the group]\n${report}`,
      });
      emitLog(`[GroupTaskDaemon] Task ${task.id}: checkpoint #${checkpoint.id} reported privately to the owner`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      emitLog(
        `[GroupTaskDaemon] Task ${task.id}: checkpoint report failed (tick continues): ` +
        errorMessage,
      );
      deps.emitTaskEvent?.({
        type: 'groupTask:ownerReportDelivery',
        taskId: task.id,
        outcome: 'failed',
        error: errorMessage,
        kind: 'checkpoint',
        checkpointId: checkpoint.id,
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
              // Issue #8: drive the ledger's on-chain confirmation state from
              // the multi-source verification result (orthogonal to owner
              // acceptance in `status`).
              store.updateDeliverableConfirmation(
                deliverable.id,
                report.verified ? 'confirmed' : 'unconfirmed',
              );
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
          // P1-5: the on-chain status tag is a chair action — record the actor
          // on the transition event (who moved the task where and when).
          // P0-5: status tags also write the transition audit log (reason =
          // the STATUS tag) via addTaskTransition below.
          const chairName = (chairMember?.name ?? members.find((m) => m.role === 'chair')?.name ?? 'chair').trim();
          const updated = store.updateTaskStatus(task.id, nextStatus, {
            actor: {
              kind: 'chair',
              globalMetaId: senderGlobalMetaId,
              name: chairName || null,
            },
          });
          if (beforeStatus && updated.status !== beforeStatus) {
            try {
              // P0-5: transition audit log (actor = chair name, reason = the STATUS tag).
              store.addTaskTransition({
                taskId: task.id,
                fromStatus: beforeStatus,
                toStatus: updated.status,
                actor: chairName || `metabot:${chairMember?.metabotId ?? 'chair'}`,
                reason: `[STATUS:${statusMatch[1].toUpperCase()}] tag`,
              });
            } catch (error) {
              emitLog(
                `[GroupTaskDaemon] Task ${task.id}: transition log write failed: ` +
                `${error instanceof Error ? error.message : String(error)}`,
              );
            }
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
              // Rework hatch: the next review must report to the owner again,
              // and the re-assert straggler guard must reset so the fresh
              // review entry can re-assert cleanly.
              deps.getStore().delete(`${GROUP_TASK_OWNER_REPORTED_KV_PREFIX}${task.id}`);
              deps.getStore().delete(`${GROUP_TASK_REVIEW_REASSERT_KV_PREFIX}${task.id}`);
            }
            if (updated.status === 'review') {
              // HITL: review entry is itself the final human gate — an open
              // checkpoint still pending at this point is superseded by it.
              try {
                const superseded = store.closeOpenCheckpoints(
                  task.id,
                  'resolved',
                  'superseded by review entry',
                );
                if (superseded > 0) {
                  emitLog(
                    `[GroupTaskDaemon] Task ${task.id}: ${superseded} open checkpoint(s) superseded by review entry`,
                  );
                }
              } catch (error) {
                emitLog(
                  `[GroupTaskDaemon] Task ${task.id}: failed to supersede open checkpoints: ` +
                  `${error instanceof Error ? error.message : String(error)}`,
                );
              }
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
              // R1 closing ceremony: the group must never rest on a worker's
              // [WORKING] when it enters acceptance. Instead of the old fixed
              // string, the host now deterministically aggregates a structured
              // acceptance summary (goal/acceptance criteria/deliverable list/
              // verification/guidance) and posts it as the LAST group message —
              // "把菜端上桌". The same record is the single source of truth for
              // the owner private report (below) and the R2 source-session
              // notification. Publish failure only logs (the existing ceremony
              // contract): review never blocks on a chain write.
              try {
                const deliverables = store.listDeliverables(task.id);
                const summaryInput = buildAcceptanceSummary({ task, deliverables, members });
                const saved = store.saveAcceptanceSummary({
                  taskId: task.id,
                  goal: summaryInput.goal,
                  acceptanceCriteria: summaryInput.acceptanceCriteria,
                  deliverables: summaryInput.deliverables,
                  members: summaryInput.members,
                  guidance: summaryInput.guidance,
                });
                const sent = await postGroupMessage(task.id, chairMember.metabotId!, summaryInput.messageText);
                try {
                  store.updateAcceptanceSummaryPublishedPin(task.id, sent.pinId);
                } catch (pinError) {
                  emitLog(
                    `[GroupTaskDaemon] Task ${task.id}: acceptance summary published-pin record failed: ` +
                    `${pinError instanceof Error ? pinError.message : String(pinError)}`,
                  );
                }
                emitLog(
                  `[GroupTaskDaemon] Task ${task.id}: acceptance summary v${saved.version} posted on review entry (pin ${sent.pinId}, ${deliverables.length} deliverable(s))`,
                );
              } catch (error) {
                emitLog(
                  `[GroupTaskDaemon] Task ${task.id}: acceptance summary post failed, falling back to plain closing line: ` +
                  `${error instanceof Error ? error.message : String(error)}`,
                );
                try {
                  const sent = await postGroupMessage(task.id, chairMember.metabotId!, buildReviewClosingLine(task));
                  emitLog(
                    `[GroupTaskDaemon] Task ${task.id}: plain closing line posted as fallback (pin ${sent.pinId})`,
                  );
                } catch (fallbackError) {
                  emitLog(
                    `[GroupTaskDaemon] Task ${task.id}: review closing fallback post failed: ` +
                    `${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
                  );
                }
              }
              await maybeSendOwnerReport(task, members, botsById, promptMembers);
            }
          }
        } catch {
          // Illegal transition (e.g. backwards or from terminal): silently ignored.
        }
      }
    }

    // HITL checkpoint tags — chair-only authority, same trust rule as STATUS
    // tags: tags from any other sender are ignored. Opening pauses the task
    // (responder gating treats it like the review phase), posts a pause line,
    // and notifies the owner privately; resolving resumes the work.
    const checkpointOpenMatch = CHECKPOINT_OPEN_TAG.exec(content);
    const checkpointResolvedMatch = CHECKPOINT_RESOLVED_TAG.exec(content);
    if (checkpointOpenMatch || checkpointResolvedMatch) {
      const chairMember = members.find((member) => member.role === 'chair');
      const chairGlobalMetaId = (chairMember?.globalmetaid ?? '').trim();
      const senderGlobalMetaId = (message.senderGlobalMetaId ?? '').trim();
      if (!chairGlobalMetaId || !senderGlobalMetaId || senderGlobalMetaId !== chairGlobalMetaId) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: checkpoint tag from non-chair sender ` +
          `${message.senderName ?? 'unknown'} ignored`,
        );
      } else if (checkpointOpenMatch) {
        try {
          const freshTask = store.getTaskById(task.id);
          const openAlready = store.getOpenCheckpoint(task.id);
          const canOpen = Boolean(freshTask)
            && freshTask!.status !== 'review'
            && !store.isTerminalStatus(freshTask!.status)
            && !openAlready;
          if (!canOpen) {
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: checkpoint open tag ignored ` +
              `(status=${freshTask?.status ?? 'unknown'}, openCheckpoint=${openAlready?.id ?? 'none'})`,
            );
          } else {
            const checkpoint = store.openCheckpoint({
              taskId: task.id,
              topic: checkpointOpenMatch[1],
              msgPinId: message.pinId,
            });
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: HITL checkpoint #${checkpoint.id} opened ` +
              `(${checkpoint.topic ?? 'no topic'})`,
            );
            try {
              // HITL: the pause line carries the decision summary so the owner
              // sees what to decide at a glance (the chair's tag-free message
              // body; document links inside it survive). Falls back to the
              // topic-only form when the body holds nothing but tags.
              const decisionSummary = extractCheckpointDecisionSummary(message.content);
              const summaryClause = decisionSummary
                ? ` 需要你拍板：${truncateCheckpointSummary(decisionSummary)}`
                : '';
              const pauseLine =
                `⏸️ 任务 #${task.id}「${task.title}」进入人工确认点（${checkpoint.topic ?? '等待主人决策'}）：` +
                `任务暂停推进，等待主人反馈。${summaryClause}` +
                '主人可直接在本群留言，或与 Twinbot 私聊给出意见。';
              const sent = await postGroupMessage(task.id, chairMember.metabotId!, pauseLine);
              emitLog(
                `[GroupTaskDaemon] Task ${task.id}: checkpoint pause line posted (pin ${sent.pinId})`,
              );
            } catch (error) {
              emitLog(
                `[GroupTaskDaemon] Task ${task.id}: checkpoint pause line post failed: ` +
                `${error instanceof Error ? error.message : String(error)}`,
              );
            }
            deps.emitTaskEvent?.({
              type: 'groupTask:checkpointChanged',
              taskId: task.id,
              checkpointId: checkpoint.id,
              status: 'open',
              at: now(),
            });
            await maybeSendCheckpointReport(task, members, botsById, promptMembers, checkpoint);
          }
        } catch (error) {
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: checkpoint open handling failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } else if (checkpointResolvedMatch) {
        try {
          const open = store.getOpenCheckpoint(task.id);
          if (!open) {
            emitLog(`[GroupTaskDaemon] Task ${task.id}: checkpoint resolved tag ignored (no open checkpoint)`);
          } else {
            const resolved = store.resolveCheckpoint(open.id, {
              resolution: checkpointResolvedMatch[1] ?? null,
              msgPinId: message.pinId,
            });
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: HITL checkpoint #${resolved.id} resolved ` +
              `(${resolved.resolution ?? 'no summary'})`,
            );
            try {
              const resumeLine =
                `▶️ 任务 #${task.id}「${task.title}」人工确认点已通过（${resolved.resolution ?? '主人已确认'}），任务继续推进。`;
              const sent = await postGroupMessage(task.id, chairMember.metabotId!, resumeLine);
              emitLog(
                `[GroupTaskDaemon] Task ${task.id}: checkpoint resume line posted (pin ${sent.pinId})`,
              );
            } catch (error) {
              emitLog(
                `[GroupTaskDaemon] Task ${task.id}: checkpoint resume line post failed: ` +
                `${error instanceof Error ? error.message : String(error)}`,
              );
            }
            deps.emitTaskEvent?.({
              type: 'groupTask:checkpointChanged',
              taskId: task.id,
              checkpointId: resolved.id,
              status: 'resolved',
              at: now(),
            });
          }
        } catch (error) {
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: checkpoint resolve handling failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          );
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
    // P1-3: the chair's own manual `invite_remote` calls create pending invites
    // and/or unconfirmed remote placeholder members BEFORE the planning turn
    // fires. The plan must know: re-decomposing "search + invite a remote bot"
    // as a subtask would make the assigned worker re-invite someone who is
    // already being invited (server rejects duplicates) — useless work. The
    // directive states the pending invites and tells the chair to plan around
    // them (wait for the join, or continue with the current roster).
    const openTeamStatusBlock = buildOpenTeamPlanningStatusBlock(
      deps.getOpenTeamMembershipStore?.(),
      task,
      deps.getGroupTaskStore(),
    );
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
      '(c2) For a DEPENDENT subtask, tag its assignment with `[DEPENDS_ON: <upstream pinid>]` (or describe the upstream requirement) and explicitly tell the member to wait for the upstream [DELIVERABLE] before starting.',
      '(d) End the message with [STATUS:EXECUTING].',
      '(e) The chair NEVER executes task work — no assembly, no publishing, no writing deliverables; assign execution subtasks to WORKERS and keep the chair to coordination, verification and reporting.',
      '(f) Match each subtask to capability: use the roster profiles (bio/role/goal). NEVER assign a step to a member whose profile obviously mismatches it (e.g. do not assign assembly or publishing to a designer-only profile). If no roster member fits a step, state the gap in the plan instead of misassigning it.',
      '(g) HUMAN CHECKPOINTS: if (and only if) the goal or acceptance criteria explicitly ask the owner to review/confirm an intermediate result (e.g. "show me the draft and wait for my OK"), plan that step as a checkpoint — when the draft is ready, post it with a `[CHECKPOINT: <topic>]` tag and wait for the owner. Do NOT invent checkpoints the owner did not ask for.',
      '',
      'Full member roster (assign only to these members, by exact name):',
      ...(rosterLines.length > 0 ? rosterLines : ['(no members yet besides the chair)']),
      ...(openTeamStatusBlock ? ['', openTeamStatusBlock] : []),
      '',
      `[Group Task "${task.title}" (#${task.id}) — recent group log (last ${contextMessageCount} messages)]`,
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
    remoteStatusBlock: string,
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
    // F1 (GT#11): never plan against a roster that is still forming. The task
    // row + chair member are persisted first, then each worker joins with
    // network-bound calls — a 5s tick can otherwise fire the planning turn
    // MID-create and permanently misplan the task with a truncated roster
    // ("single worker" misjudgement, wrong role assignments, planned-key set
    // so the task never re-plans). Wait until the member roster is unchanged
    // for settleMs; an absolute cap from creation guarantees the task can
    // never sit in 'planning' behind the gate (e.g. a join that never lands).
    const settleMs = Math.max(0, Math.trunc(deps.chairPlanRosterSettleMs ?? DEFAULT_CHAIR_PLAN_ROSTER_SETTLE_MS));
    const capMs = Math.max(0, Math.trunc(deps.chairPlanRosterCapMs ?? DEFAULT_CHAIR_PLAN_ROSTER_CAP_MS));
    if (settleMs > 0 || capMs > 0) {
      const rosterKey = `${CHAIR_PLAN_ROSTER_KV_PREFIX}${task.id}`;
      const sig = buildRosterSignature(members);
      let entry: { sig: string; since: number } | null = null;
      try {
        const raw = sqlite.get<string>(rosterKey);
        if (raw) entry = JSON.parse(raw) as { sig: string; since: number };
      } catch {
        entry = null;
      }
      if (!entry || entry.sig !== sig) {
        sqlite.set(rosterKey, JSON.stringify({ sig, since: now() }));
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: chair planning deferred — roster still forming ` +
          `(${members.filter((member) => member.role === 'worker').length} worker(s) of ${members.length} member(s))`,
        );
        return;
      }
      const sinceMs = now() - entry.since;
      const createdMs = parseSqliteUtcMs(task.createdAt);
      const ageMs = createdMs != null ? now() - createdMs : Number.POSITIVE_INFINITY;
      if (sinceMs < settleMs && ageMs < capMs) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: chair planning deferred — waiting for the roster to settle ` +
          `(${Math.max(0, Math.ceil((settleMs - sinceMs) / 1000))}s left)`,
        );
        return;
      }
      sqlite.delete(rosterKey);
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
      // Volatile context (time + experience/cognition + remote-teammate facts)
      // rides the user turn.
      const directive = [systemPromptParts.volatileContext, remoteStatusBlock, buildPlanningDirective(db, task, promptMembers)]
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
      const posted = await postGroupMessage(task.id, bot.id, reply);
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
    remoteStatusBlock: string,
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
    if (member.role === 'chair' && remoteStatusBlock) {
      // OpenTeam M2: host-observed unreachable facts accompany the chair only.
      userMessage = `${userMessage}\n\n${remoteStatusBlock}`;
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

    const llmId = normalizeMetabotLlmId(bot.llm_id) ?? undefined;
    const fallbackLlmId = normalizeMetabotLlmId(bot.fallback_llm_id);
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
    // P0-2: host auto-ACK BEFORE the (potentially long) worker turn — a skill
    // turn can run for many minutes, so the group must already see the
    // "[WORKING] 已接单" signal instead of a silent gap.
    if (member.role === 'worker' && canRunSkillTurn) {
      await maybeSendWorkerAck(task, bot, message, baseSystemPrompt, llmId, fallbackLlmId);
    }
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
    if (!reply || isNonAnswerAssistantReply(reply)) {
      // 清单 #10 P-A (groupTaskDaemon canonical path): an empty reply is only
      // a bare EMPTY_HANDOFF when the session shows no substantive activity;
      // otherwise fail the attempt with the WORKER_EMPTY_HANDOFF_WITH_ACTIVITY
      // summary (commit/tests/files/toolCalls/errors/lastError) so the chair
      // can recognize a false failure and reuse the produced work.
      const activity = summarizeSessionActivity(
        readTaskSessionActivityMessages(coworkStore, session.id),
      );
      failCanonicalAttempt(
        hasSubstantiveActivity(activity)
          ? formatWorkerEmptyHandoffError(activity)
          : WORKER_EMPTY_HANDOFF,
      );
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
      // R5: thread this reply under the message that triggered it (the chair's
      // dispatch for a worker, or the worker's message for a chair response).
      // The host decides who is being replied to from the gating context — the
      // LLM never writes pinids itself.
      sent = await postGroupMessage(task.id, bot.id, reply, {
        replyPin: message.pinId ?? undefined,
      });
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
   * R2P1-4: a resolver THROW is transient and propagates into the caller's
   * bounded retry path — only a definitive null/empty resolution marks SUSPECT.
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
      // A resolver THROW (network/indexer outage) is transient, not a
      // definitive "unresolvable": it propagates so the message rides the
      // bounded MSG_RETRY path instead of being permanently stamped SUSPECT
      // with the cursor advanced past it. Only a clean null/empty resolution
      // below marks SUSPECT.
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
        // P1-4: an assignment message this worker already ACKed must never
        // re-arm the watch — a cursor retry / duplicate processing of the
        // same message would otherwise re-start the 3-min no-ACK watch on an
        // already-engaged worker and misreport it to the chair.
        if (sqlite.get<string>(`${ACK_SEEN_PREFIX}${task.id}:${message.id}`) === '1') {
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: assignment to ${member.name ?? member.metabotId} ` +
            `(message #${message.id}) already ACKed (ack-seen); no new ACK watch`,
          );
          continue;
        }
        if (sqlite.get<string>(pendingKey) == null && sqlite.get<string>(remindedKey) !== '1') {
          // P1-4: a DERIVED assignment (chair tags [DEPENDS_ON]) inherits the
          // upstream ACK: the worker already engaged on the chain the derived
          // step continues, so a fresh no-ACK watch would misreport a worker
          // who is demonstrably working. Inherit only when the referenced
          // upstream pinid resolves to a message this worker ACKed.
          const derived = resolveDerivedAssignmentUpstream(task, message, sqlite);
          if (derived !== null) {
            if (derived) {
              sqlite.set(`${ACK_SEEN_PREFIX}${task.id}:${message.id}`, '1');
              emitLog(
                `[GroupTaskDaemon] Task ${task.id}: derived assignment to ${member.name ?? member.metabotId} ` +
                `(message #${message.id}, DEPENDS_ON upstream ${derived}) inherits the upstream ACK; no new ACK watch`,
              );
            } else {
              sqlite.set(pendingKey, JSON.stringify({ assignedAt: now(), messageId: message.id }));
              emitLog(
                `[GroupTaskDaemon] Task ${task.id}: derived assignment to ${member.name ?? member.metabotId} ` +
                `(message #${message.id}) upstream not ACKed; waiting for [WORKING] ACK`,
              );
            }
            continue;
          }
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
    // P1-4: clearing a pending watch records ack-seen for the assignment
    // message, so derived [DEPENDS_ON] assignments and re-processed messages
    // inherit the ACK instead of re-arming the no-ACK watch.
    const clearPendingAck = (): void => {
      const raw = sqlite.get<string>(pendingKey);
      if (raw != null) {
        try {
          const entry = JSON.parse(raw) as { assignedAt?: number; messageId?: number };
          if (entry && typeof entry.messageId === 'number') {
            sqlite.set(`${ACK_SEEN_PREFIX}${task.id}:${entry.messageId}`, '1');
          }
        } catch {
          // unparsable pending entry: drop it without ack-seen
        }
      }
      sqlite.delete(pendingKey);
      if (sqlite.get<string>(remindedKey) != null) sqlite.delete(remindedKey);
    };
    const ack = parseWorkingAck(message.content);
    if (ack) {
      store.setMemberStatus(task.id, member.metabotId, 'working', member.globalmetaid);
      clearPendingAck();
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
    clearPendingAck();
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
      // P1-4: a worker who spoke ANYTHING after the assignment is engaged —
      // implicit ACK. The pending watch was either missed (cursor retry /
      // member-match gap) or the worker is mid-work; clear it, record
      // ack-seen for the assignment message, and never misreport it as
      // "not ACKed" (the 8/10 #11 incident: worker [WORKING]-ed at 18:36 but
      // the chair still got a no-ACK alert at 18:43).
      const store = deps.getGroupTaskStore();
      const memberGmid = (member.globalmetaid ?? '').trim();
      if (memberGmid && task.groupId) {
        const speakMap = store.getMembersLastSpeakAt(task.groupId, [memberGmid]);
        const lastSpeakSec = speakMap.get(memberGmid.toLowerCase());
        if (lastSpeakSec != null && Number.isFinite(lastSpeakSec) && lastSpeakSec * 1000 >= entry.assignedAt) {
          sqlite.set(`${ACK_SEEN_PREFIX}${task.id}:${entry.messageId}`, '1');
          sqlite.delete(pendingKey);
          if (sqlite.get<string>(`${ACK_REMINDED_PREFIX}${task.id}:${member.metabotId}`) != null) {
            sqlite.delete(`${ACK_REMINDED_PREFIX}${task.id}:${member.metabotId}`);
          }
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: ${member.name ?? member.metabotId} spoke after ` +
            `assignment #${entry.messageId} (implicit ACK); no no-ACK reminder`,
          );
          continue;
        }
      }
      const remindedKey = `${ACK_REMINDED_PREFIX}${task.id}:${member.metabotId}`;
      if (sqlite.get<string>(remindedKey) === '1') continue;
      const text =
        `@chair ⚠ ${member.name ?? `bot-${member.metabotId}`} was assigned work ` +
        `but has not sent a [WORKING] ACK within ` +
        `${Math.round(ackTimeoutMs / 60_000)} min. Check whether the assignment ` +
        `was received; do not auto-fail.`;
      try {
        await postGroupMessage(task.id, chair.metabotId, text);
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
        // Issue #8: the re-verification pass is the chain-confirmation-driven
        // update path — a pin that becomes verifiable on-chain (indexer lag
        // caught up) flips the ledger's confirmation state.
        store.updateDeliverableConfirmation(
          deliverable.id,
          fresh.verified ? 'confirmed' : 'unconfirmed',
        );
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
        await postGroupMessage(task.id, chair.metabotId, text);
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

  /** Stable per-member welcome key (local members by metabot_id, remote by gmid). */
  const memberJoinKey = (member: GroupTaskMember): string =>
    member.metabotId != null
      ? `local:${member.metabotId}`
      : `remote:${(member.globalmetaid ?? '').trim().toLowerCase()}`;

  /**
   * #13 handshake (inviter side): ONE welcome broadcast when a member joins a
   * task AFTER the initial roster — especially a remote OpenTeam member whose
   * join just confirmed (joined_pin_id appears). The welcome names the joiner
   * and why they were invited (invite required-skills), tells the joiner to
   * greet the group first, and @s the existing local members once for an
   * online confirmation. Their mention-gated replies are the one-round
   * handshake; the confirmations carry no mentions, so nothing replies to
   * them and no chat loop starts ([NO_REPLY] discipline intact). The welcome
   * itself @s members only — the chair is skipped (self-skip by sender), so
   * the chair does not floor-control a reply to it.
   *
   * Bookkeeping: the first tick snapshots the initially-joined member keys
   * (create-time roster); later joins outside that snapshot and not yet
   * welcomed get the broadcast (kv `group_task_welcome_done:<taskId>:<key>`).
   * Review/terminal tasks never welcome (review-phase silence must keep the
   * last message as the closing ceremony).
   */
  const monitorMemberJoinWelcomes = async (
    task: GroupTask,
    members: GroupTaskMember[],
    botsById: Map<number, GroupTaskDaemonBotFull>,
  ): Promise<void> => {
    if (task.status !== 'planning' && task.status !== 'executing') return;
    const sqlite = deps.getStore();
    const initialKey = `${WELCOME_INITIAL_JOINED_PREFIX}${task.id}`;
    const rawInitial = sqlite.get<string>(initialKey);
    if (rawInitial == null) {
      // First tick for this task: snapshot the roster that is already joined.
      // Create-time members are introduced by the kickoff — never welcomed.
      const initialJoined = members
        .filter((member) => member.joinedPinId)
        .map(memberJoinKey);
      sqlite.set(initialKey, JSON.stringify(initialJoined));
      return;
    }
    let initialJoined: string[] = [];
    try {
      const parsed = JSON.parse(rawInitial);
      initialJoined = Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      initialJoined = [];
    }
    const chair = members.find((member) => member.role === 'chair');
    if (!chair?.metabotId) return;
    const membershipStore = deps.getOpenTeamMembershipStore?.();
    // Why was each remote joiner invited? (invite required-skills, best-effort)
    const invitedForByGmid = new Map<string, string>();
    for (const member of members) {
      if (member.role === 'chair' || member.metabotId != null || !member.joinedPinId) continue;
      const gmid = (member.globalmetaid ?? '').trim();
      if (!gmid) continue;
      try {
        const invite = membershipStore?.getLatestInvite(task.id, gmid);
        if (invite?.requiredSkills?.length) {
          invitedForByGmid.set(gmid.toLowerCase(), invite.requiredSkills.join(', '));
        }
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: invite lookup for welcome failed (welcome proceeds): ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    for (const member of members) {
      if (member.role === 'chair' || !member.joinedPinId) continue;
      const key = memberJoinKey(member);
      if (initialJoined.includes(key)) continue; // create-time roster
      const doneKey = `${WELCOME_DONE_PREFIX}${task.id}:${key}`;
      if (sqlite.get<string>(doneKey) === '1') continue; // already welcomed
      const isRemote = member.metabotId == null;
      const joinerName = member.name?.trim()
        || (isRemote ? 'remote-member' : `bot-${member.metabotId}`);
      const existingNames = members
        .filter((candidate) => candidate.id !== member.id)
        .filter((candidate) => candidate.role === 'worker' && candidate.metabotId != null)
        .map((candidate) => {
          const bot = botsById.get(candidate.metabotId!);
          return bot?.name?.trim() || candidate.name?.trim() || '';
        })
        .filter(Boolean);
      const text = buildMemberJoinWelcomeText({
        taskId: task.id,
        taskTitle: task.title,
        joinerName,
        invitedFor: invitedForByGmid.get((member.globalmetaid ?? '').trim().toLowerCase()),
        existingMemberNames: existingNames,
      });
      try {
        const sent = await postGroupMessage(task.id, chair.metabotId, text);
        sqlite.set(doneKey, '1');
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: welcomed new ${isRemote ? 'remote' : 'local'} member ` +
          `${joinerName} as chair (pin ${sent.pinId})`,
        );
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: join welcome post failed (retried on next tick): ` +
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

    // P2-8: multi-driver mutex — when another daemon instance holds a fresh
    // driver claim for this task, yield the whole tick (no heartbeat, no
    // planning, no message processing) so two chair sessions never drive the
    // same task at the same instant.
    if (!claimDriverOrYield(task.id)) return;

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

    // OpenTeam M2: remote-teammate unreachable evaluation (throttled presence
    // probe + group-message silence window). The resulting fact block rides
    // every chair turn this tick; empty when everyone is reachable/unwired.
    let remoteStatusBlock = '';
    try {
      remoteStatusBlock = buildRemoteStatusBlock(
        await evaluateRemoteTeammates(task, members, botsById, ownerGlobalMetaId),
      );
    } catch (error) {
      emitLog(
        `[GroupTaskDaemon] Task ${task.id}: remote teammate evaluation failed (tick continues): ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }

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

    // HITL: while a human checkpoint is open the group is paused waiting for
    // the owner's decision — skip member nudging (unreachable marking, ACK and
    // delivery-deadline reminders) that would punish the enforced silence.
    const checkpointOpenAtTick = store.getOpenCheckpoint(task.id) != null;

    // P0-2: auto-mark silent assigned/working members unreachable (badge for chair).
    if (task.status === 'executing' && !checkpointOpenAtTick) {
      monitorMemberUnreachable(task, members);
    }

    // P0-3: once-per-assignment chair reminder for missing [WORKING] ACKs.
    if (!checkpointOpenAtTick) {
      await monitorAcksAndReminders(task, members);
    }
    // P0-4: re-verify lagging deliverables + missed delivery deadlines.
    await monitorDeliverableVerification(task);
    if (!checkpointOpenAtTick) {
      await monitorDeliveryDeadlines(task, members);
    }

    // #13: welcome broadcast + one-round handshake for members joining after
    // the initial roster (esp. remote OpenTeam members). Runs before the
    // planning turn so a mid-planning join is greeted before work is assigned.
    try {
      await monitorMemberJoinWelcomes(task, members, botsById);
    } catch (error) {
      emitLog(
        `[GroupTaskDaemon] Task ${task.id}: join welcome monitor failed (tick continues): ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Exactly one chair planning turn per task, while it is still in 'planning'.
    if (task.status === 'planning') {
      await maybeRunChairPlanningTurn(task, members, botsById, promptMembers, remoteStatusBlock);
    }

    // P0-3c: compensate replies deferred by a cap/cooldown in an earlier tick.
    // Deferred entries get priority over brand-new messages so a skipped worker
    // still gets its chance (the message cursor already advanced past it).
    const memberGmids = memberGlobalMetaIdSet(members);
    const ownerGmidKey = ownerGlobalMetaId.toLowerCase();
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
        // Re-validate the sender before speaking on their message: it may have
        // been flagged SUSPECT, or the sender kicked out of the task, after
        // the reply was deferred (M3 kick loop closure).
        const deferredSenderGmid = (deferredMessage.senderGlobalMetaId ?? '').trim().toLowerCase();
        if (
          deferredMessage.senderSuspect
          || !deferredSenderGmid
          || (deferredSenderGmid !== ownerGmidKey && !memberGmids.has(deferredSenderGmid))
        ) {
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: deferred reply for message ${entry.messageId} dropped; ` +
            'the sender is suspect or no longer an active member',
          );
          continue;
        }
        const key = keyOf(task.id, entry.metabotId);
        const isChair = member.role === 'chair';
        // HITL: worker replies deferred before the checkpoint opened keep
        // waiting — workers are silenced while the owner decides.
        if (checkpointOpenAtTick && !isChair) {
          deferReply(entry);
          continue;
        }
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
        // P2-6: deferred entries still respect the [DEPENDS_ON] gate — keep
        // waiting while the upstream deliverable is absent (bounded).
        const deferredDep = dependencyStatus(task, deferredMessage);
        if (deferredDep.token && !deferredDep.satisfied) {
          const waitKey = `${DEP_WAIT_KV_PREFIX}${task.id}:${bot.id}:${entry.messageId}`;
          const startedAt = Number(sqlite.get<number>(waitKey) ?? 0) || now();
          sqlite.set(waitKey, startedAt);
          if (now() - startedAt < dependencyWaitMaxMs) {
            deferReply(entry); // keep waiting for the upstream deliverable
            continue;
          }
          sqlite.delete(waitKey);
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: dependency wait for ${deferredDep.token} timed out after ` +
            `${Math.round(dependencyWaitMaxMs / 60_000)} min; proceeding with the deferred dispatch`,
          );
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
            remoteStatusBlock,
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

    for (const row of rows) {
      try {
        // Round-4 attribution first: resolve the chain-signature GlobalMetaID
        // (persisted once) and mark SUSPECT when the sender is neither a task
        // member nor the owner. Everything downstream (deliverable collection,
        // gating, replies, experience capture) consumes the enriched message.
        // Inside the try on purpose (R2P1-4): a resolver THROW is transient and
        // rides the bounded retry path below instead of sticking a SUSPECT
        // stamp on the message and advancing the cursor past it.
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
        recordGroupTaskMessageForLocalMembers(task, message, members, botsById);
        const verificationNotes = await processMessageTags(task, message, members, botsById, promptMembers);
        // P0-3: [WORKING] ACK / [STANDBY] markers + assignment ACK tracking.
        handleMemberProtocolMarkers(task, message, members, botsById);
        // A [STATUS:...] tag on THIS message may have flipped the task status
        // (e.g. chair posted [STATUS:REVIEW]); gate with the fresh status, not
        // the tick-start snapshot. A [CHECKPOINT...] tag may likewise have
        // opened/resolved a HITL checkpoint — gate with the fresh state too.
        const freshStatus = store.getTaskById(task.id)?.status ?? task.status;
        const hasOpenCheckpoint = store.getOpenCheckpoint(task.id) != null;
        const gatingTask: GroupTaskDaemonTask = { ...task, status: freshStatus, hasOpenCheckpoint };
        const decisions = decideGroupTaskResponders(message, gatingTask, members, botsById);
        // P0-1: review-phase silence hint — a chair dispatch to workers during
        // review is intentionally unanswered (workers are gated silent); log
        // it so the operator/chair reopens the task instead of assuming the
        // dispatch failed or the worker is broken. Same for an open HITL
        // checkpoint: resume with [CHECKPOINT_RESOLVED: ...].
        if (freshStatus === 'review' || hasOpenCheckpoint) {
          const silencedWorkers = members.filter((candidate) =>
            candidate.role === 'worker'
            && candidate.metabotId != null
            && botsById.get(candidate.metabotId) != null
            && isMentioned(message, botsById.get(candidate.metabotId)!),
          );
          if (silencedWorkers.length > 0) {
            const gatePrefix = freshStatus === 'review' ? 'review-phase silence' : 'checkpoint silence';
            const gateHint = freshStatus === 'review'
              ? 'task in REVIEW; reopen with [STATUS:EXECUTING] or the UI Back-to-work action'
              : 'HITL checkpoint open; resume with [CHECKPOINT_RESOLVED: <decision>] after the owner replies';
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: ${gatePrefix} — dispatch to ` +
              `${silencedWorkers.map((candidate) => candidate.name ?? candidate.metabotId).join(', ')} ` +
              `ignored (${gateHint})`,
            );
          }
        }
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

          // P2-6: [DEPENDS_ON: <pinid>] gate — hold the worker dispatch until
          // the referenced upstream deliverable is recorded on this task
          // (bounded wait, then the dispatch proceeds anyway).
          if (member.role === 'worker') {
            const dep = dependencyStatus(task, message);
            if (dep.token && !dep.satisfied) {
              const waitKey = `${DEP_WAIT_KV_PREFIX}${task.id}:${bot.id}:${message.id}`;
              const startedAt = Number(sqlite.get<number>(waitKey) ?? 0) || now();
              sqlite.set(waitKey, startedAt);
              if (now() - startedAt < dependencyWaitMaxMs) {
                deferReply({
                  taskId: task.id,
                  metabotId: decision.metabotId,
                  messageId: message.id,
                  reason: decision.reason,
                  verificationNotes: [],
                });
                emitLog(
                  `[GroupTaskDaemon] Task ${task.id}: worker ${bot.id} dispatch waits for upstream deliverable ` +
                  `${dep.token} (${Math.ceil((dependencyWaitMaxMs - (now() - startedAt)) / 1000)}s left)`,
                );
                continue;
              }
              sqlite.delete(waitKey);
              emitLog(
                `[GroupTaskDaemon] Task ${task.id}: dependency wait for ${dep.token} timed out after ` +
                `${Math.round(dependencyWaitMaxMs / 60_000)} min; proceeding with the dispatch`,
              );
            }
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
            remoteStatusBlock,
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
        // (row.id: the enriched message variable is scoped to the try block.)
        const retryKey = `${MSG_RETRY_PREFIX}${task.id}:${row.id}`;
        const failures = (Number(sqlite.get<number>(retryKey) ?? 0) || 0) + 1;
        sqlite.set(retryKey, failures);
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: message ${row.id} failed ` +
          `(attempt ${failures}/${MSG_RETRY_MAX_FAILURES}): ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
        if (failures >= MSG_RETRY_MAX_FAILURES) {
          sqlite.delete(retryKey);
          store.updateLastProcessedMsgId(task.id, row.id);
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: message ${row.id} dropped after ` +
            `${failures} consecutive failures (cursor advanced past it)`,
          );
          // The poison message is out of the way: later messages may proceed.
          continue;
        }
        // Fail-stop (R2P1-4 review): later messages must wait behind the
        // failed one — otherwise their success would advance the cursor past
        // it and silently strand the pending retry forever.
        break;
      }
    }

    // #14 follow-up: a worker turn already in flight when the task entered
    // review can land AFTER the chair's closing ceremony, leaving a worker's
    // [WORKING]/[DELIVERABLE] as the last group message. While the task awaits
    // human acceptance the host — not a straggler — must be the last speaker,
    // so re-assert the closing line. One re-assert per distinct straggler
    // (kv-guard on the straggler's message id); the chair post then becomes
    // last and this gate stays quiet until another straggler arrives.
    if (task.status === 'review' && task.groupId) {
      const chair = members.find((member) => member.role === 'chair');
      const chairGlobalMetaId = chair?.globalmetaid?.trim() || null;
      if (chair?.metabotId != null && chairGlobalMetaId) {
        const lastRow = queryRecentMessages(db, task.groupId, 1)[0];
        const lastSender = (lastRow?.sender_global_metaid ?? '').trim();
        if (lastRow && lastSender && lastSender !== chairGlobalMetaId) {
          const reassertKey = `${GROUP_TASK_REVIEW_REASSERT_KV_PREFIX}${task.id}`;
          if (String(sqlite.get(reassertKey) ?? '') !== String(lastRow.id)) {
            sqlite.set(reassertKey, String(lastRow.id));
            try {
              // R1: re-assert the SAME acceptance summary posted at review entry
              // (re-rendered deterministically from the stored record) so a late
              // straggler never replaces "把菜端上桌" with a bare [WORKING]. Falls
              // back to the plain closing line only when no summary exists yet.
              const latest = deps.getGroupTaskStore().getLatestAcceptanceSummary(task.id);
              const reassertText = latest
                ? buildAcceptanceSummaryMessageText(latest, task.title)
                : buildReviewClosingLine(task);
              const sent = await postGroupMessage(task.id, chair.metabotId, reassertText);
              emitLog(
                `[GroupTaskDaemon] Task ${task.id}: re-asserted chair closing after straggler msg ${lastRow.id} (pin ${sent.pinId})`,
              );
            } catch (error) {
              emitLog(
                `[GroupTaskDaemon] Task ${task.id}: review closing re-assert failed: ` +
                `${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
        }
      }
    }
  };

  const runTick = async (): Promise<void> => {
    const store = deps.getGroupTaskStore();
    const activeTasks = store
      .listTasks()
      .filter((task) => task.status === 'planning' || task.status === 'executing' || task.status === 'review');
    // OpenTeam M2: tasks that left the active set (done/cancelled) drop their
    // presence snapshot and owner-notification flags, so a reactivated task
    // re-evaluates and re-notifies from scratch.
    const activeTaskIds = new Set(activeTasks.map((task) => task.id));
    for (const taskId of [...remotePresenceByTask.keys()]) {
      if (!activeTaskIds.has(taskId)) remotePresenceByTask.delete(taskId);
    }
    for (const key of [...remoteUnreachableNotified]) {
      if (!activeTaskIds.has(Number(key.slice(0, key.indexOf(':'))))) {
        remoteUnreachableNotified.delete(key);
      }
    }
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
