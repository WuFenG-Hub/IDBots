/**
 * OpenTeam guest daemon (M1): watches group_chat_messages for every active
 * openteam_memberships row and lets the invited bot answer when @-mentioned,
 * exactly like a local group-task worker would. M3/P1-2 adds a periodic
 * on-chain membership self-check (default 5 min) that marks the membership
 * left when this bot has disappeared from the group member list — the fallback
 * for the chair's one-way [OPENTEAM_KICK] simplemsg. Two guards keep indexer
 * lag from killing a healthy membership: a fresh (re-)activation skips the
 * check for a grace window (default 15 min, anchored at activated_at), and
 * only 2 consecutive absence reads mark the membership left.
 *
 * Modeled on groupTaskDaemon's structure (5s tick, single-tick re-entry guard,
 * module-level start/stop singleton, same mention gating via
 * groupChatMentionUtils) but deliberately leaner: no chair/worker protocol, no
 * orchestration, no session channel. Loop prevention comes from the per-
 * membership cursor (openteam_memberships.last_processed_msg_id, monotonic),
 * the self-message skip, and a per-membership reply cooldown. The cursor only
 * advances past messages that were actually processed: a cooldown-blocked
 * mention is re-evaluated on a later tick (answered once the cooldown has
 * elapsed), and a send/generation failure is retried next tick — bounded, so
 * the same message is abandoned after 3 consecutive failures. A reply starting
 * with [NO_REPLY] is suppressed (not sent on-chain), same escape hatch as the
 * group-task daemon.
 *
 * M3 scope note: chat-skill turns are wired through the same narrow seams the
 * group-task daemon uses (getChatSkillsRoutingPrompt + runSkillTurn, backed by
 * runSkillTurnInExistingSession in main.ts). Routing stays on the bot's OWN
 * assigned skills (widened is never set — external group members are
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
import { metabotBrainOptions, normalizeMetabotLlmId } from './llmFallback';
import { isMentioned } from './groupChatMentionUtils';
import { isOpenTeamTaskStatusTerminal, parseOpenTeamTaskStatusTag } from '../libs/openTeamTaskStatus';
import { buildOpenTeamGuestPrompt } from './openTeamGuestPrompt';
import { ensureOpenTeamGuestSession } from './groupTaskSession';
import {
  buildGuestMetafileDeliverableLine,
  buildGuestNoteDeliverableLine,
  collectGuestDeliverableFiles,
  DEFAULT_MAX_DELIVERABLE_FILES,
} from './openTeamGuestDeliverables';
import { isTextDocumentDeliverable } from './deliverableTextNote';

/** Escape hatch: a reply starting with the [NO_REPLY] tag is suppressed (not sent on-chain). */
const NO_REPLY_PATTERN = /^\[NO_REPLY\]/i;

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_COOLDOWN_MS = 20_000;
const DEFAULT_CONTEXT_MESSAGE_COUNT = 20;
/** Bounded retry: consecutive failures on one message before the cursor gives up and advances past it. */
const MAX_CONSECUTIVE_MESSAGE_FAILURES = 3;
/**
 * P1-2 self-check fallback: how often each active membership re-verifies on-chain
 * that this bot is still a group member (the KICK simplemsg may never arrive).
 */
const DEFAULT_MEMBERSHIP_CHECK_INTERVAL_MS = 5 * 60_000;
/**
 * Activation grace: a fresh (re-)activation skips the self-check for this long.
 * The indexer takes minutes to absorb the join pin into the member list (the
 * inviter-side join-confirmation budget is 10 min for the same reason), so an
 * early absence read would mark a brand-new membership left by mistake.
 */
const DEFAULT_MEMBERSHIP_SELF_CHECK_GRACE_MS = 15 * 60_000;
/**
 * Confirmed-absence threshold: a single missing member-list read can be
 * indexer lag; only this many CONSECUTIVE absence results mark the membership
 * left.
 */
const MEMBERSHIP_SELF_CHECK_ABSENCE_THRESHOLD = 2;

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
  options?: {
    llmProvider?: string | null;
    fallbackLlmId?: string | null;
    fallbackLlmProvider?: string | null;
    effort?: 'off' | 'low' | 'high' | 'max' | null;
    fallbackEffort?: 'off' | 'low' | 'high' | 'max' | null;
    thinking?: 'enabled' | 'disabled';
  },
) => Promise<string>;

export type OpenTeamGuestSendGroupMessageFn = (
  metabotId: number,
  groupId: string,
  opts: { content: string; nickName?: string },
) => Promise<{ pinId: string }>;

/** Narrow skill-routing seam (same shape as groupTaskDaemon's; wired to skillManager.buildChatSkillsRoutingPrompt). */
export type OpenTeamGuestSkillRoutingFn = (input: {
  metabotId?: number | null;
  widened?: boolean;
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

/**
 * Narrow simplenote publish seam (wired to
 * deliverableTextNote.publishTextFileAsNote in main.ts). MetaWeb URI
 * convention: readable text deliverables (Markdown / plain text) go on-chain
 * as simplenote notes cited pin:// — metafile:// is reserved for binary
 * payloads. The GUEST bot's own wallet pays the note pin.
 */
export type OpenTeamGuestPublishTextFn = (input: {
  metabotId: number;
  filePath: string;
  contentType?: string;
}) => Promise<{ pinId?: string } | null | undefined>;

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
  getChatSkillsRoutingPrompt?: OpenTeamGuestSkillRoutingFn;
  runSkillTurn?: OpenTeamGuestRunSkillTurnFn;
  /** M3 file delivery; unwired = skill turns run but files are not uploaded/delivered. */
  uploadDeliverableFile?: OpenTeamGuestUploadFileFn;
  /**
   * M3 text-document delivery: readable text files (Markdown / plain text)
   * are published as simplenote notes (pin://) instead of /file metafiles.
   * Unwired (or returning null) = text documents fall back to the metafile
   * upload path.
   */
  publishTextDeliverable?: OpenTeamGuestPublishTextFn;
  /**
   * P1-2 self-check fallback: group member-list read (wired to
   * groupChatTransport.fetchGroupMembers in main.ts). Unwired = the periodic
   * on-chain membership self-check stays off.
   */
  fetchGroupMembers?: (groupId: string) => Promise<string[] | null>;
  /** Self-check cadence per membership (default 5 min). */
  membershipCheckIntervalMs?: number;
  /**
   * Post-activation grace during which the self-check is skipped entirely
   * (default 15 min; covers the indexer lag in absorbing the join pin).
   */
  membershipSelfCheckGraceMs?: number;
  /** Cap on metafile deliverables appended per turn (default DEFAULT_MAX_DELIVERABLE_FILES). */
  maxDeliverableFilesPerTurn?: number;
  emitLog?: (message: string) => void;
  now?: () => number;
  intervalMs?: number;
  cooldownMs?: number;
  contextMessageCount?: number;
  /**
   * P1-3: when wired, guest turns are logged into the eager session created at
   * invite-accept time (context continuity; the session also carries the
   * injected group context snapshot). Also used by the M3 skill-turn path.
   */
  getCoworkStore?: () => CoworkStore;
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

/** sqlite UTC text ('YYYY-MM-DD HH:MM:SS', optionally with .SSS) -> epoch ms. */
const parseSqliteUtcMs = (value: string | null): number => {
  if (!value) return Number.NaN;
  const parsed = Date.parse(`${value.trim().replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

export function createOpenTeamGuestDaemonLoop(deps: OpenTeamGuestDaemonDeps): OpenTeamGuestDaemonLoop {
  const intervalMs = Math.max(1_000, Math.trunc(deps.intervalMs ?? DEFAULT_INTERVAL_MS));
  const cooldownMs = Math.max(0, Math.trunc(deps.cooldownMs ?? DEFAULT_COOLDOWN_MS));
  const contextMessageCount = Math.max(1, Math.trunc(deps.contextMessageCount ?? DEFAULT_CONTEXT_MESSAGE_COUNT));
  const membershipCheckIntervalMs = Math.max(
    1_000,
    Math.trunc(deps.membershipCheckIntervalMs ?? DEFAULT_MEMBERSHIP_CHECK_INTERVAL_MS),
  );
  const membershipSelfCheckGraceMs = Math.max(
    0,
    Math.trunc(deps.membershipSelfCheckGraceMs ?? DEFAULT_MEMBERSHIP_SELF_CHECK_GRACE_MS),
  );
  const emitLog = deps.emitLog ?? (() => undefined);
  const now = deps.now ?? (() => Date.now());

  // Loop prevention state (in-memory, per loop instance; the durable half is
  // the membership cursor in openteam_memberships).
  const lastReplyAtByMembership = new Map<number, number>();
  /** Consecutive send/generation failure streak per membership (bounded retry). */
  const consecutiveFailuresByMembership = new Map<number, { messageId: number; count: number }>();
  /** P1-2 self-check: last on-chain membership verification per membership. */
  const membershipCheckedAtByMembership = new Map<number, number>();
  /** P1-2 self-check: consecutive absence streak per membership (confirmed kick). */
  const membershipAbsenceStreakByMembership = new Map<number, number>();

  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;
  /** One-time-per-run transcript backfill of the host-task status (below). */
  let taskStatusBackfillDone = false;

  /**
   * Host-task status sync: the chair drives the host-side state machine with
   * `[STATUS:EXECUTING|REVIEW]` group messages and closeGroupTask posts a
   * deterministic `[STATUS:DONE|CANCELLED]` close-out. The newest chair-sent
   * tag in the transcript is the membership's task_status. Legacy rows (tag
   * pre-dates this feature) are re-derived once per daemon start from the
   * already-indexed transcript — this is what un-sticks the eternal "active"
   * badge for pre-existing memberships.
   */
  const backfillTaskStatusesFromTranscript = (): void => {
    const membershipStore = deps.getOpenTeamMembershipStore();
    for (const membership of membershipStore.listMembershipsWithUnknownTaskStatus()) {
      try {
        const derived = membershipStore.deriveLatestChairTaskStatus(
          membership.groupId,
          membership.inviterGlobalmetaid,
        );
        if (derived && membershipStore.updateMembershipTaskStatus(membership.groupId, membership.metabotId, derived)) {
          emitLog(
            `[OpenTeamGuestDaemon] Group ${membership.groupId}: host task status backfilled ` +
            `from the transcript: ${derived}`,
          );
        }
      } catch (error) {
        emitLog(
          `[OpenTeamGuestDaemon] Group ${membership.groupId}: task-status backfill failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

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
   * M3 file delivery: publish the skill turn's file artifact(s) on-chain and
   * append one `[DELIVERABLE]` line per file. Protocol follows content kind
   * (MetaWeb URI convention): readable text documents become simplenote notes
   * (`note: pin://<pinId>`), binary files become metafiles
   * (`metafile: metafile://<pinId><ext>`). Upload problems never suppress or
   * rewrite the text reply — failed files are called out in a plain
   * (untagged) sentence so no fake deliverable rows can be ingested on the
   * inviter side.
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
        // MetaWeb URI convention: readable text documents (Markdown / plain
        // text) are published as simplenote notes and delivered as pin://;
        // metafile:// is reserved for binary payloads. A note publish yielding
        // no pinId (oversized/unreadable doc) falls through to the metafile
        // upload so the file still gets delivered on-chain.
        const preferTextNote = deps.publishTextDeliverable != null
          && isTextDocumentDeliverable(file.filePath, file.contentType);
        let line: string | null = null;
        if (preferTextNote) {
          const published = await deps.publishTextDeliverable!({
            metabotId: input.bot.id,
            filePath: file.filePath,
            contentType: file.contentType,
          });
          const notePinId = typeof published?.pinId === 'string' ? published.pinId.trim() : '';
          line = notePinId
            ? buildGuestNoteDeliverableLine({ pinId: notePinId, fileName: file.fileName })
            : null;
        }
        if (!line && deps.uploadDeliverableFile) {
          const upload = await deps.uploadDeliverableFile({
            metabotId: input.bot.id,
            filePath: file.filePath,
            contentType: file.contentType,
          });
          const pinId = typeof upload?.pinId === 'string' ? upload.pinId.trim() : '';
          line = pinId
            ? buildGuestMetafileDeliverableLine({
              pinId,
              fileName: file.fileName,
              contentType: file.contentType,
            })
            : null;
        }
        if (line) {
          deliverableLines.push(line);
        } else {
          failedNames.push(file.fileName);
          emitLog(
            `[OpenTeamGuestDaemon] Bot ${input.bot.id}: on-chain publish for ${file.fileName} produced no deliverable line`,
          );
        }
      } catch (error) {
        failedNames.push(file.fileName);
        emitLog(
          `[OpenTeamGuestDaemon] Bot ${input.bot.id}: on-chain publish for ${file.fileName} failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (deliverableLines.length === 0 && failedNames.length === 0) return input.reply;
    return [
      input.reply,
      ...deliverableLines,
      ...(failedNames.length > 0
        ? [`(On-chain publish failed for: ${failedNames.join(', ')} — generated locally but not delivered on-chain; ask me to retry if needed.)`]
        : []),
    ].join('\n');
  };

  const generateAndSendGuestReply = async (
    membership: OpenTeamMembership,
    bot: Metabot,
    message: OpenTeamGuestDaemonMessage,
  ): Promise<void> => {
    const db = deps.getStore().getDatabase();
    // #13: the guest prompt carries WHY this bot was invited (goal summary +
    // required skills from the guest-side invite history row, looked up by the
    // invite pin echoed on the membership) — plus the greet-first rule in the
    // playbook, so the guest's first group message is a presence greeting.
    let whyContext: { goalSummary?: string | null; requiredSkills?: string[] } = {};
    if (membership.invitePinId) {
      try {
        const guestInvite = deps.getOpenTeamMembershipStore().getGuestInviteByPinId(membership.invitePinId);
        whyContext = {
          goalSummary: guestInvite?.goalSummary ?? undefined,
          requiredSkills: guestInvite?.requiredSkills?.length ? guestInvite.requiredSkills : undefined,
        };
      } catch {
        whyContext = {};
      }
    }
    const systemPrompt = buildOpenTeamGuestPrompt({
      metabot: bot,
      membership: {
        groupId: membership.groupId,
        taskTitle: membership.taskTitle,
        inviterGlobalmetaid: membership.inviterGlobalmetaid,
        ...whyContext,
      },
    });
    const userMessage = buildGroupLogUserMessage(db, membership, message);

    // Skill routing (mirrors groupTaskDaemon): when the bot has chat skills
    // enabled and routing hits, run ONE skill turn in the guest's cowork
    // session; otherwise (or on any routing failure) fall back to the plain
    // completion path.
    let routing: { prompt: string | null; activeSkillIds: string[] } = { prompt: null, activeSkillIds: [] };
    if (deps.getChatSkillsRoutingPrompt && deps.runSkillTurn && deps.getCoworkStore) {
      try {
        routing = await deps.getChatSkillsRoutingPrompt({
          metabotId: bot.id,
          // External group members are never the owner: only the bot's
          // assigned skills are routable — the exact permission surface a
          // non-owner private-chat peer gets. Nothing is widened.
          widened: false,
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
      const brain = metabotBrainOptions(bot);
      const llmId = brain.llmId ?? undefined;
      const fallbackLlmId = brain.fallbackLlmId;
      reply = (
        await deps.performChat(systemPrompt, userMessage, llmId, {
          llmProvider: brain.llmProvider,
          fallbackLlmId,
          fallbackLlmProvider: brain.fallbackLlmProvider,
          effort: brain.effort,
          fallbackEffort: brain.fallbackEffort,
          thinking: 'enabled',
        })
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

    if (skillTurn && (deps.uploadDeliverableFile || deps.publishTextDeliverable)) {
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
    // P1-3: log the turn into the guest session (the one eagerly created at
    // invite-accept time) so the invitee's host has context continuity.
    if (deps.getCoworkStore) {
      try {
        const coworkStore = deps.getCoworkStore();
        const { session } = ensureOpenTeamGuestSession(
          coworkStore,
          bot.id,
          bot.name?.trim() || `bot-${bot.id}`,
          { groupId: membership.groupId, taskTitle: membership.taskTitle },
        );
        coworkStore.addMessage(session.id, { type: 'user', content: userMessage });
        coworkStore.addMessage(session.id, { type: 'assistant', content: reply });
      } catch (error) {
        emitLog(
          `[OpenTeamGuestDaemon] Group ${membership.groupId}: session logging failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  /**
   * P1-2 self-check fallback: the chair's [OPENTEAM_KICK] simplemsg may never
   * arrive (offline, indexer lag), so every membershipCheckIntervalMs each
   * active membership re-verifies on-chain that this bot is still a member of
   * the group. Two guards keep an indexer-lag false absence from killing a
   * healthy membership: (1) a fresh (re-)activation is not checked at all for
   * membershipSelfCheckGraceMs (anchored at activated_at, which the upsert
   * restamps on revival — created_at would survive a re-invite); (2) only
   * MEMBERSHIP_SELF_CHECK_ABSENCE_THRESHOLD consecutive absence reads mark the
   * membership left. Marking left stops the daemon consuming the group, stops
   * backfill pulling it, shows Left in the collab view, and lets a re-invite
   * land cleanly. A failed lookup silently skips the round.
   * Returns true when the membership was just marked left.
   */
  const runMembershipSelfCheck = async (
    membership: OpenTeamMembership,
    bot: Metabot,
  ): Promise<boolean> => {
    if (!deps.fetchGroupMembers) return false;
    // Activation grace: the indexer takes minutes to list a fresh join.
    const activatedMs = parseSqliteUtcMs(membership.activatedAt);
    if (Number.isFinite(activatedMs) && now() - activatedMs < membershipSelfCheckGraceMs) return false;
    const lastCheckedAt = membershipCheckedAtByMembership.get(membership.id) ?? 0;
    if (now() - lastCheckedAt < membershipCheckIntervalMs) return false;
    membershipCheckedAtByMembership.set(membership.id, now());
    let members: string[] | null = null;
    try {
      members = await deps.fetchGroupMembers(membership.groupId);
    } catch (error) {
      members = null;
      emitLog(
        `[OpenTeamGuestDaemon] Group ${membership.groupId}: membership self-check failed; ` +
        `skipping this round: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!members) return false; // indexer unreachable — try again next interval
    const identities = new Set(
      [bot.globalmetaid, bot.metaid, membership.globalmetaid]
        .map((value) => String(value ?? '').trim().toLowerCase())
        .filter(Boolean),
    );
    if (identities.size === 0) return false;
    if (members.some((member) => identities.has(member.trim().toLowerCase()))) {
      membershipAbsenceStreakByMembership.delete(membership.id);
      return false;
    }
    // One absence read can be indexer lag; only a confirmed streak marks left.
    const absenceStreak = (membershipAbsenceStreakByMembership.get(membership.id) ?? 0) + 1;
    if (absenceStreak < MEMBERSHIP_SELF_CHECK_ABSENCE_THRESHOLD) {
      membershipAbsenceStreakByMembership.set(membership.id, absenceStreak);
      emitLog(
        `[OpenTeamGuestDaemon] Group ${membership.groupId}: bot ${bot.id} missing from the on-chain ` +
        `member list (absence ${absenceStreak}/${MEMBERSHIP_SELF_CHECK_ABSENCE_THRESHOLD}); ` +
        'confirming on the next round before marking left',
      );
      return false;
    }
    membershipAbsenceStreakByMembership.delete(membership.id);
    deps.getOpenTeamMembershipStore().markLeft(membership.groupId, membership.metabotId, { cause: 'self_check' });
    emitLog(
      `[OpenTeamGuestDaemon] Group ${membership.groupId}: bot ${bot.id} is no longer an on-chain ` +
      'member; membership marked left (kick self-check)',
    );
    return true;
  };

  const processMembership = async (membership: OpenTeamMembership): Promise<void> => {
    const metabotStore = deps.getMetabotStore();
    const membershipStore = deps.getOpenTeamMembershipStore();
    const bot = metabotStore.getMetabotById(membership.metabotId);
    if (!bot || bot.enabled === false) return;
    if (!bot.globalmetaid?.trim()) return;
    const db = deps.getStore().getDatabase();

    // Kick self-check before consuming new messages (P1-2 fallback path).
    if (await runMembershipSelfCheck(membership, bot)) return;

    // Host-task status sync: the chair's `[STATUS:...]` tags ride the ordinary
    // transcript. Once a close-out tag ([STATUS:DONE|CANCELLED]) has landed the
    // task is over — the daemon keeps consuming messages (advancing the cursor)
    // but never speaks in the group again.
    let taskTerminal = isOpenTeamTaskStatusTerminal(membership.taskStatus);
    const chairGlobalMetaId = (membership.inviterGlobalmetaid ?? '').trim();

    const rows = queryNewMessages(db, membership.groupId, membership.lastProcessedMsgId);
    for (const row of rows) {
      const message = toDaemonMessage(row);
      // Status tags are parsed BEFORE the mention gating so a close-out tag is
      // picked up even while a reply cooldown is running. Only the chair (the
      // membership's recorded inviter — the kick handler's trust anchor) may
      // set the host-task status; tags quoted by other members never count.
      if (chairGlobalMetaId && (message.senderGlobalMetaId ?? '').trim() === chairGlobalMetaId) {
        const statusTag = parseOpenTeamTaskStatusTag(message.content);
        if (statusTag) {
          try {
            if (membershipStore.updateMembershipTaskStatus(membership.groupId, membership.metabotId, statusTag)) {
              emitLog(
                `[OpenTeamGuestDaemon] Group ${membership.groupId}: host task status -> ${statusTag} (chair transcript tag)`,
              );
            }
          } catch (error) {
            emitLog(
              `[OpenTeamGuestDaemon] Group ${membership.groupId}: task-status update failed: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            );
          }
          if (isOpenTeamTaskStatusTerminal(statusTag)) taskTerminal = true;
        }
      }
      let advanceCursor = false;
      try {
        if (taskTerminal) {
          // Terminal host task: consume the message without any reply path.
          advanceCursor = true;
        } else {
          const decision = decideOpenTeamGuestResponse({
            message,
            bot,
            lastReplyAt: lastReplyAtByMembership.get(membership.id) ?? 0,
            now: now(),
            cooldownMs,
          });
          if (!decision.respond && decision.reason === 'cooldown') {
            // Cooldown is transient: keep the cursor BEFORE this message so the
            // next tick re-evaluates it once the cooldown has elapsed instead of
            // dropping a legitimate mention forever. Later messages wait to keep
            // processing order.
            break;
          }
          if (decision.respond) {
            await generateAndSendGuestReply(membership, bot, message);
            lastReplyAtByMembership.set(membership.id, now());
          }
          consecutiveFailuresByMembership.delete(membership.id);
          advanceCursor = true;
        }
      } catch (error) {
        // A send/generation failure must not silently drop the mention: hold
        // the cursor and retry on the next tick, giving up after a bounded run
        // of consecutive failures on the SAME message so one poisonous message
        // cannot stall the membership forever.
        const previous = consecutiveFailuresByMembership.get(membership.id);
        const failures = previous?.messageId === message.id ? previous.count + 1 : 1;
        if (failures >= MAX_CONSECUTIVE_MESSAGE_FAILURES) {
          consecutiveFailuresByMembership.delete(membership.id);
          advanceCursor = true;
          emitLog(
            `[OpenTeamGuestDaemon] Group ${membership.groupId}: message ${message.id} failed ` +
            `${failures} times in a row; giving up on it (cursor advances): ` +
            `${error instanceof Error ? error.message : String(error)}`,
          );
        } else {
          consecutiveFailuresByMembership.set(membership.id, { messageId: message.id, count: failures });
          emitLog(
            `[OpenTeamGuestDaemon] Group ${membership.groupId}: message ${message.id} failed ` +
            `(retry ${failures}/${MAX_CONSECUTIVE_MESSAGE_FAILURES} next tick): ` +
            `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (!advanceCursor) break;
      membershipStore.updateLastProcessedMsgId(
        membership.groupId,
        membership.metabotId,
        message.id,
      );
    }
  };

  const runTick = async (): Promise<void> => {
    const membershipStore = deps.getOpenTeamMembershipStore();
    const activeMemberships = membershipStore.listActiveMemberships();
    // Drop in-memory loop-prevention state of memberships that are no longer
    // active (kick / owner opt-out): the maps are keyed by membership id and
    // would otherwise grow monotonically — and a later re-join must not
    // inherit a stale cooldown or failure streak.
    const activeIds = new Set(activeMemberships.map((membership) => membership.id));
    for (const id of [...lastReplyAtByMembership.keys()]) {
      if (!activeIds.has(id)) lastReplyAtByMembership.delete(id);
    }
    for (const id of [...consecutiveFailuresByMembership.keys()]) {
      if (!activeIds.has(id)) consecutiveFailuresByMembership.delete(id);
    }
    for (const id of [...membershipCheckedAtByMembership.keys()]) {
      if (!activeIds.has(id)) membershipCheckedAtByMembership.delete(id);
    }
    for (const id of [...membershipAbsenceStreakByMembership.keys()]) {
      if (!activeIds.has(id)) membershipAbsenceStreakByMembership.delete(id);
    }
    for (const membership of activeMemberships) {
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
      if (!taskStatusBackfillDone) {
        taskStatusBackfillDone = true;
        // One-time-per-run repair of legacy memberships: re-derive the host
        // task status from chair `[STATUS:...]` tags already in the transcript.
        backfillTaskStatusesFromTranscript();
      }
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
