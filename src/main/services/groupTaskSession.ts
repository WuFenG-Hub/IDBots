/**
 * Shared Group Task worker-session helpers (P1-3 invite immediate wake-up).
 *
 * The invite-wakeup problem: after a member joins (local join or OpenTeam
 * invite ACCEPT), the worker session used to be created LAZILY on the first
 * daemon reply — with no group context preloaded, and nothing visible to the
 * host until the worker actually answered. These helpers create the cowork
 * session EAGERLY (within the join/invite call, i.e. well under a minute)
 * and inject the group context (goal + acceptance + roster + recent
 * transcript) so the invited bot can answer immediately with full context.
 *
 * Used by: groupTaskService (create/join/invite), groupTaskDaemon
 * (its per-turn session lookup delegates here so there is exactly ONE
 * session-creation code path), and openTeamGuestService (invitee-side host).
 */

import type { CoworkStore, CoworkSession } from '../coworkStore';
import type { GroupTask, GroupTaskStore } from '../groupTaskStore';
import { resolveSessionWorkingDirectory } from '../libs/botWorkspace';

/** Group Task conversation channel (same value the daemon uses). */
export const GROUP_TASK_CONVERSATION_CHANNEL = 'metaweb_group_task';

/** Minimal task shape the session helpers need (GroupTask or a guest subset). */
export interface GroupTaskSessionTaskLike {
  id: number;
  title: string;
  groupId: string | null;
}

/** Metadata stamped on the conversation mapping (display/debug only). */
export interface GroupTaskSessionOptions {
  channel?: string;
  externalConversationId?: string;
  metadata?: Record<string, unknown>;
  title?: string;
}

/**
 * Find or create the cowork session bound to a (task, bot) conversation
 * mapping. Same mapping convention as the daemon's historical lazy path:
 * channel 'metaweb_group_task', externalConversationId 'group-task:<taskId>'.
 * Returns { session, created } so callers can decide whether to inject
 * context (fresh sessions only).
 */
export function ensureGroupTaskSession(
  coworkStore: CoworkStore,
  task: GroupTaskSessionTaskLike,
  botId: number,
  botName: string,
  opts?: GroupTaskSessionOptions,
): { session: CoworkSession; created: boolean } {
  const channel = opts?.channel ?? GROUP_TASK_CONVERSATION_CHANNEL;
  const externalConversationId = opts?.externalConversationId ?? `group-task:${task.id}`;
  const existing = coworkStore.getConversationMapping(channel, externalConversationId, botId);
  if (existing) {
    const session = coworkStore.getSession(existing.coworkSessionId);
    if (session) return { session, created: false };
  }
  const config = coworkStore.getConfig();
  const workspaceRoot = resolveSessionWorkingDirectory(
    (config.workingDirectory ?? '').trim() || process.cwd(),
    botId,
  );
  const session = coworkStore.createSession(
    opts?.title ?? `Group Task #${task.id} (${botName})`,
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
    channel,
    externalConversationId,
    metabotId: botId,
    coworkSessionId: session.id,
    metadataJson: JSON.stringify(opts?.metadata ?? { taskId: task.id, groupId: task.groupId }),
  });
  return { session, created: true };
}

/** Roster line for the injected context snapshot (name + role). */
export interface GroupTaskContextMember {
  name: string | null;
  role: 'chair' | 'worker';
}

/** One recent transcript row for the injected context snapshot. */
export interface GroupTaskContextMessage {
  senderName: string | null;
  content: string | null;
}

/**
 * Inject the group context (goal, acceptance, roster, recent transcript)
 * into the member's session as one clearly-marked [SYSTEM] user message.
 * Only injects into sessions that have no messages yet — re-injection would
 * duplicate the context on every eager-join retry.
 */
export function injectGroupTaskContext(input: {
  coworkStore: CoworkStore;
  sessionId: string;
  task: {
    title: string;
    goal: string;
    acceptanceCriteria?: string | null;
  };
  members: GroupTaskContextMember[];
  recentMessages: GroupTaskContextMessage[];
  recentCount?: number;
}): void {
  const session = input.coworkStore.getSession(input.sessionId);
  if (!session || session.messages.length > 0) return;
  const recentCount = Math.max(1, Math.min(50, Math.trunc(input.recentCount ?? 20)));
  const membersText = input.members.length > 0
    ? input.members.map((member) => `- ${member.name ?? '(unnamed)'} [${member.role}]`).join('\n')
    : '- (chair only)';
  const recent = input.recentMessages.slice(-recentCount);
  const logLines = recent.length > 0
    ? recent.map((message) => `${message.senderName ?? 'Unknown'}: ${message.content ?? ''}`)
    : ['(no messages yet)'];
  const acceptance = (input.task.acceptanceCriteria ?? '').trim() || '(none specified)';
  const snapshot = [
    '[SYSTEM group context snapshot — injected by the host at join time, not a group participant message]',
    `Task: ${input.task.title}`,
    `Goal: ${input.task.goal}`,
    `Acceptance criteria: ${acceptance}`,
    '',
    'Roster:',
    membersText,
    '',
    `Recent group log (last ${recentCount} messages):`,
    ...logLines,
  ].join('\n');
  input.coworkStore.addMessage(input.sessionId, { type: 'user', content: snapshot });
}

/**
 * Guest-side variant (OpenTeam invitee host): the invitee has no local
 * GroupTask row, so the session binds to the on-chain group id
 * (externalConversationId 'openteam:<groupId>') and the injected context is
 * task title + recent transcript.
 */
export function ensureOpenTeamGuestSession(
  coworkStore: CoworkStore,
  botId: number,
  botName: string,
  membership: { groupId: string; taskTitle?: string | null },
): { session: CoworkSession; created: boolean } {
  return ensureGroupTaskSession(
    coworkStore,
    { id: -1, title: membership.taskTitle?.trim() || 'OpenTeam group task', groupId: membership.groupId },
    botId,
    botName,
    {
      externalConversationId: `openteam:${membership.groupId}`,
      metadata: { groupId: membership.groupId, openTeam: true },
      title: `OpenTeam Group Task (${botName})`,
    },
  );
}

/** Inject the guest context snapshot into the invitee's session. */
export function injectOpenTeamGuestContext(input: {
  coworkStore: CoworkStore;
  sessionId: string;
  taskTitle?: string | null;
  inviterGlobalmetaid?: string | null;
  recentMessages: GroupTaskContextMessage[];
  recentCount?: number;
}): void {
  const session = input.coworkStore.getSession(input.sessionId);
  if (!session || session.messages.length > 0) return;
  const recentCount = Math.max(1, Math.min(50, Math.trunc(input.recentCount ?? 20)));
  const inviter = (input.inviterGlobalmetaid ?? '').trim();
  const recent = input.recentMessages.slice(-recentCount);
  const logLines = recent.length > 0
    ? recent.map((message) => `${message.senderName ?? 'Unknown'}: ${message.content ?? ''}`)
    : ['(no messages yet)'];
  const snapshot = [
    '[SYSTEM OpenTeam context snapshot — injected by the host at invite-accept time, not a group participant message]',
    `You were invited${inviter ? ` by \`${inviter}\`` : ''} to an external group task: "${input.taskTitle?.trim() || '(untitled task)'}".`,
    'Your replies come from your own machine as a remote teammate.',
    '',
    `Recent group log (last ${recentCount} messages):`,
    ...logLines,
  ].join('\n');
  input.coworkStore.addMessage(input.sessionId, { type: 'user', content: snapshot });
}

/** Convenience: full eager-session setup for one local group-task member. */
export function ensureGroupTaskMemberReady(input: {
  coworkStore: CoworkStore;
  groupTaskStore: GroupTaskStore;
  task: GroupTask;
  botId: number;
  botName: string;
  recentCount?: number;
}): { sessionId: string; created: boolean } {
  const { session, created } = ensureGroupTaskSession(
    input.coworkStore,
    input.task,
    input.botId,
    input.botName,
  );
  if (created) {
    const members = input.groupTaskStore.listMembers(input.task.id);
    const recentMessages = input.task.groupId
      ? input.groupTaskStore.listGroupChatMessages(input.task.groupId, { limit: input.recentCount ?? 20 })
      : [];
    injectGroupTaskContext({
      coworkStore: input.coworkStore,
      sessionId: session.id,
      task: {
        title: input.task.title,
        goal: input.task.goal,
        acceptanceCriteria: input.task.acceptanceCriteria,
      },
      members: members.map((member) => ({ name: member.name, role: member.role })),
      recentMessages,
      recentCount: input.recentCount,
    });
  }
  return { sessionId: session.id, created };
}
