/**
 * OpenTeam M3: collaboration-impression sedimentation. When a group task with
 * remote (OpenTeam) teammates closes, when a remote teammate is kicked, or when
 * a remote teammate's deliverable is accepted/rejected, the chair (twin bot)
 * appends one objective observation per remote collaborator to its MetaID
 * impression ledger. The records are deterministic host-side facts (no LLM),
 * written through MetaIDImpressionStore.appendObservation with stable
 * idempotency keys so retries/restarts never duplicate them. They pave the way
 * for screening future collaboration candidates by collaboration history.
 *
 * Direction is one-way (chair -> remote collaborator); local members keep using
 * the per-message experience pipeline (groupTaskDaemon -> dream). TODO(OpenTeam):
 * the guest side — an invited bot forming impressions of the inviter/task — is
 * intentionally NOT recorded here and is left to the guest's own dream pipeline.
 *
 * Wiring follows the groupTaskService setter-injection style: main.ts installs
 * a deps getter once at startup. Every recorder no-ops silently when unwired or
 * when the chair twin has no GlobalMetaID, and never throws into the caller's
 * main flow — failures are logged with the [OpenTeam] prefix only.
 */

import { createHash } from 'node:crypto';
import type {
  GroupTaskStore,
  GroupTask,
  GroupTaskDeliverable,
} from '../groupTaskStore';
import type { MetaIDExperienceStore } from '../metaidExperienceStore';
import type { MetaIDImpressionStore } from '../metaidImpressionStore';
import type { Metabot } from '../types/metabot';
import { normalizeGlobalMetaID, type GlobalMetaID } from '../shared/globalMetaId';

export type OpenTeamTaskCloseOutcome = 'done' | 'cancelled';
export type OpenTeamDeliverableVerdict = 'accepted' | 'rejected';

export interface OpenTeamImpressionServiceDeps {
  groupTaskStore: GroupTaskStore;
  experienceStore: MetaIDExperienceStore;
  impressionStore: MetaIDImpressionStore;
  /** Resolves the chair (twin) bot row; only its globalmetaid is read. */
  getMetabotById: (id: number) => Metabot | null;
  /** Clock override for tests (epoch ms). */
  now?: () => number;
}

export interface OpenTeamImpressionRecordResult {
  /** Observations confirmed in the ledger (newly written + idempotent hits). */
  recorded: number;
  /** Newly written observations (subset of `recorded`). */
  created: number;
  /** Candidate subjects skipped (local member, missing/invalid identity, self). */
  skipped: number;
}

/** Subject-published message evidences attached alongside the lifecycle evidence. */
const MAX_SUBJECT_MESSAGE_EVIDENCE = 8;

let depsGetter: (() => OpenTeamImpressionServiceDeps | null) | null = null;

export function setOpenTeamImpressionServiceDepsGetter(
  getter: (() => OpenTeamImpressionServiceDeps | null) | null,
): void {
  depsGetter = getter;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveDeps(): OpenTeamImpressionServiceDeps | null {
  try {
    return depsGetter?.() ?? null;
  } catch (error) {
    console.warn(`[OpenTeam] Impression deps resolution failed: ${errorMessage(error)}`);
    return null;
  }
}

/**
 * The chair (observer) identity for one task. Returns null when the twin bot
 * has no GlobalMetaID binding — the recorders skip silently in that case.
 */
function resolveObserverGlobalMetaID(
  deps: OpenTeamImpressionServiceDeps,
  task: GroupTask,
): GlobalMetaID | null {
  try {
    return normalizeGlobalMetaID(deps.getMetabotById(task.chairMetabotId)?.globalmetaid);
  } catch {
    return null;
  }
}

/** Remote teammates of one task, deduped by GlobalMetaID (latest member row wins). */
function listRemoteMemberSubjects(
  deps: OpenTeamImpressionServiceDeps,
  taskId: number,
): Array<{ globalMetaID: GlobalMetaID; removedAt: string | null }> {
  const byGlobalMetaID = new Map<string, { globalMetaID: GlobalMetaID; removedAt: string | null }>();
  for (const member of deps.groupTaskStore.listMembers(taskId, { includeRemoved: true })) {
    if (member.metabotId != null) continue; // local members use the experience pipeline
    const globalMetaID = normalizeGlobalMetaID(member.globalmetaid);
    if (!globalMetaID) continue;
    byGlobalMetaID.set(globalMetaID, { globalMetaID, removedAt: member.removedAt ?? null });
  }
  return [...byGlobalMetaID.values()];
}

/** True when the GlobalMetaID belongs to a REMOTE member row of the task. */
function isRemoteMember(
  deps: OpenTeamImpressionServiceDeps,
  taskId: number,
  globalMetaID: GlobalMetaID,
): boolean {
  return deps.groupTaskStore
    .listMembers(taskId, { includeRemoved: true })
    .some((member) =>
      member.metabotId == null
      && normalizeGlobalMetaID(member.globalmetaid) === globalMetaID,
    );
}

interface SubjectParticipationStats {
  messageCount: number;
  deliverablesTotal: number;
  deliverablesAccepted: number;
  deliverablesRejected: number;
  deliverablesPending: number;
}

function collectSubjectParticipationStats(
  deps: OpenTeamImpressionServiceDeps,
  task: GroupTask,
  subject: GlobalMetaID,
  deliverables?: GroupTaskDeliverable[],
): SubjectParticipationStats {
  const messageCount = task.groupId
    ? deps.groupTaskStore.countGroupChatMessagesBySender(task.groupId, subject)
    : 0;
  const authored = (deliverables ?? deps.groupTaskStore.listDeliverables(task.id))
    .filter((deliverable) =>
      text(deliverable.authorGlobalmetaid).toLowerCase() === subject,
    );
  return {
    messageCount,
    deliverablesTotal: authored.length,
    deliverablesAccepted: authored.filter((deliverable) => deliverable.status === 'accepted').length,
    deliverablesRejected: authored.filter((deliverable) => deliverable.status === 'rejected').length,
    deliverablesPending: authored.filter((deliverable) => deliverable.status === 'pending').length,
  };
}

function formatParticipationStats(stats: SubjectParticipationStats): string {
  const deliverableBreakdown = stats.deliverablesTotal > 0
    ? ` (${stats.deliverablesAccepted} accepted, ${stats.deliverablesRejected} rejected, `
      + `${stats.deliverablesPending} still pending at close)`
    : '';
  return `${stats.messageCount} group message(s) posted; `
    + `${stats.deliverablesTotal} deliverable(s) submitted${deliverableBreakdown}.`;
}

interface AppendEventObservationInput {
  deps: OpenTeamImpressionServiceDeps;
  observer: GlobalMetaID;
  subject: GlobalMetaID;
  task: GroupTask;
  /** Stable per-event evidence sourceKey, e.g. `task:3:close:done`. */
  eventSourceKey: string;
  /** Structured facts persisted as the lifecycle evidence metadata. */
  eventMetadata: Record<string, unknown>;
  observationText: string;
  interpretationText: string;
  dimensions: Record<string, unknown>;
  idempotencyKey: string;
  now: number;
}

/**
 * Append one chair->subject observation anchored to a deterministic lifecycle
 * evidence row in the chair's own task episode (created idempotently, the same
 * `task:<id>` episode the daemon feeds per-message), plus up to
 * MAX_SUBJECT_MESSAGE_EVIDENCE subject-published message evidences when the
 * experience ledger already holds them. Throws on store errors — the callers
 * isolate per subject.
 */
function appendEventObservation(input: AppendEventObservationInput): { created: boolean } {
  const { deps, observer, subject, task, now } = input;
  const episode = deps.experienceStore.createEpisode({
    ownerGlobalMetaID: observer,
    episodeType: 'task_participation',
    sourceChannel: 'group_task',
    sourceKey: `task:${task.id}`,
    externalConversationId: text(task.groupId) || `group-task:${task.id}`,
    taskId: String(task.id),
    status: 'open',
    startedAt: now,
    metadata: {
      interaction: 'group_task',
      taskId: String(task.id),
      groupId: text(task.groupId) || null,
    },
  }).episode;
  deps.experienceStore.addParticipant({
    episodeId: episode.id,
    globalMetaID: observer,
    role: 'observer',
    source: 'group_task_member_identity',
  });
  deps.experienceStore.addParticipant({
    episodeId: episode.id,
    globalMetaID: subject,
    role: 'member',
    source: 'group_task_member_identity',
  });

  const lifecycleEvidence = deps.experienceStore.addEvidence({
    episodeId: episode.id,
    evidenceType: 'group_task_event',
    sourceKey: input.eventSourceKey,
    publisherGlobalMetaID: observer,
    contentHash: sha256(JSON.stringify(input.eventMetadata)),
    occurredAt: now,
    metadata: input.eventMetadata,
  });
  const subjectMessageEvidence = deps.experienceStore
    .listEvidence(episode.id)
    .filter((evidence) =>
      evidence.evidenceType === 'group_task_message'
      && evidence.publisherGlobalMetaID === subject,
    )
    .slice(-MAX_SUBJECT_MESSAGE_EVIDENCE);

  const evidenceIds = [lifecycleEvidence.id, ...subjectMessageEvidence.map((evidence) => evidence.id)];
  const evidenceRelevance: Record<string, string> = {
    [lifecycleEvidence.id]: 'openteam task lifecycle event',
  };
  for (const evidence of subjectMessageEvidence) {
    evidenceRelevance[evidence.id] = 'subject group message';
  }

  const appended = deps.impressionStore.appendObservation({
    observerGlobalMetaID: observer,
    subjectGlobalMetaID: subject,
    episodeId: episode.id,
    evidenceIds,
    evidenceRelevance,
    observationText: input.observationText,
    interpretationText: input.interpretationText,
    dimensions: input.dimensions,
    communicationGuidance: null,
    confidence: {
      level: 'low',
      uncertainty: 'Host-recorded facts from a single group task; no behavioral judgment yet.',
    },
    dreamDate: new Date(now).toISOString().slice(0, 10),
    dreamVersion: 1,
    modelId: null,
    sourceHash: sha256(JSON.stringify({
      idempotencyKey: input.idempotencyKey,
      observationText: input.observationText,
      eventMetadata: input.eventMetadata,
    })),
    idempotencyKey: input.idempotencyKey,
  });
  if (appended.created) {
    try {
      deps.impressionStore.rebuildSnapshot(observer, subject);
    } catch (error) {
      // Observations remain durable; the next dream run repairs the snapshot.
      console.warn(
        `[OpenTeam] Impression snapshot rebuild failed for ${subject}: ${errorMessage(error)}`,
      );
    }
  }
  return { created: appended.created };
}

/**
 * Task close (done/cancelled): the chair records one objective participation
 * observation per remote teammate. Cancelled tasks are recorded too, with the
 * close reason noted when one was given.
 */
export function recordTaskCloseImpressions(
  taskId: number,
  outcome: OpenTeamTaskCloseOutcome,
  reason?: string,
): OpenTeamImpressionRecordResult {
  const result: OpenTeamImpressionRecordResult = { recorded: 0, created: 0, skipped: 0 };
  const deps = resolveDeps();
  if (!deps) return result;
  try {
    const id = Math.trunc(Number(taskId));
    if (!Number.isInteger(id) || id <= 0) return result;
    if (outcome !== 'done' && outcome !== 'cancelled') return result;
    const task = deps.groupTaskStore.getTaskById(id);
    if (!task) return result;
    const observer = resolveObserverGlobalMetaID(deps, task);
    if (!observer) return result; // twin has no GlobalMetaID — silent skip
    const now = deps.now?.() ?? Date.now();
    const closeReason = text(reason);
    const deliverables = deps.groupTaskStore.listDeliverables(task.id);

    for (const subject of listRemoteMemberSubjects(deps, task.id)) {
      if (subject.globalMetaID === observer) {
        result.skipped += 1;
        continue;
      }
      try {
        const stats = collectSubjectParticipationStats(deps, task, subject.globalMetaID, deliverables);
        const removedNote = subject.removedAt
          ? ' The subject had been removed from the task before it closed.'
          : '';
        const outcomeText = outcome === 'done'
          ? 'closed with outcome "done"'
          : `closed with outcome "cancelled"${closeReason ? ` (recorded reason: "${closeReason}")` : ''}`;
        const appended = appendEventObservation({
          deps,
          observer,
          subject: subject.globalMetaID,
          task,
          eventSourceKey: `task:${task.id}:close:${outcome}`,
          eventMetadata: {
            event: 'task_close',
            taskId: task.id,
            title: task.title,
            outcome,
            reason: closeReason || null,
            subject: subject.globalMetaID,
            ...stats,
            removedBeforeClose: Boolean(subject.removedAt),
          },
          observationText:
            `OpenTeam collaboration record: group task #${task.id} "${task.title}" ${outcomeText}. `
            + `The subject joined as a remote teammate. Host-recorded participation: `
            + formatParticipationStats(stats) + removedNote,
          interpretationText: outcome === 'done'
            ? 'The subject took part in a remote collaboration that reached completion; '
              + 'the figures above are host-recorded facts, not a quality judgment.'
            : 'The collaboration ended by cancellation, which is not by itself a negative signal '
              + 'about the subject; the figures above are host-recorded facts.',
          dimensions: {
            cooperationContext: 'openteam_remote_group_task',
            taskId: task.id,
            outcome,
            messageCount: stats.messageCount,
            deliverablesTotal: stats.deliverablesTotal,
            deliverablesAccepted: stats.deliverablesAccepted,
            deliverablesRejected: stats.deliverablesRejected,
            deliverablesPending: stats.deliverablesPending,
            removedBeforeClose: Boolean(subject.removedAt),
          },
          idempotencyKey: `openteam:task-close:${task.id}:${subject.globalMetaID}`,
          now,
        });
        result.recorded += 1;
        if (appended.created) result.created += 1;
      } catch (error) {
        result.skipped += 1;
        console.warn(
          `[OpenTeam] Task-close impression failed for task ${task.id}, subject ${subject.globalMetaID}: `
          + errorMessage(error),
        );
      }
    }
  } catch (error) {
    console.warn(`[OpenTeam] Task-close impressions failed for task ${taskId}: ${errorMessage(error)}`);
  }
  return result;
}

/**
 * Member kick: the chair records one negative observation about the kicked
 * REMOTE member, including the stated reason. Local members are skipped (they
 * are covered by the per-message experience pipeline).
 */
export function recordKickImpression(
  taskId: number,
  memberGlobalMetaId: string,
  reason?: string,
): OpenTeamImpressionRecordResult {
  const result: OpenTeamImpressionRecordResult = { recorded: 0, created: 0, skipped: 0 };
  const deps = resolveDeps();
  if (!deps) return result;
  try {
    const id = Math.trunc(Number(taskId));
    const subject = normalizeGlobalMetaID(memberGlobalMetaId);
    if (!Number.isInteger(id) || id <= 0 || !subject) return result;
    const task = deps.groupTaskStore.getTaskById(id);
    if (!task) return result;
    if (!isRemoteMember(deps, task.id, subject)) return result; // local member or non-member
    const observer = resolveObserverGlobalMetaID(deps, task);
    if (!observer || observer === subject) return result;
    const now = deps.now?.() ?? Date.now();
    const kickReason = text(reason);

    const appended = appendEventObservation({
      deps,
      observer,
      subject,
      task,
      eventSourceKey: `task:${task.id}:kick:${subject}`,
      eventMetadata: {
        event: 'member_kick',
        taskId: task.id,
        title: task.title,
        subject,
        reason: kickReason || null,
      },
      observationText:
        `OpenTeam moderation record: the subject was removed (kicked) from group task `
        + `#${task.id} "${task.title}" by the observer side.`
        + (kickReason ? ` Recorded reason: "${kickReason}".` : ' No reason was recorded.'),
      interpretationText:
        'Removal from a group task is a negative collaboration signal recorded by the host; '
        + 'weigh it against any later positive facts.',
      dimensions: {
        cooperationContext: 'openteam_remote_group_task',
        relationshipTemperature: 'negative',
        taskId: task.id,
        event: 'member_kick',
        reason: kickReason || null,
      },
      idempotencyKey: `openteam:kick:${task.id}:${subject}`,
      now,
    });
    result.recorded += 1;
    if (appended.created) result.created += 1;
  } catch (error) {
    console.warn(
      `[OpenTeam] Kick impression failed for task ${taskId}, member ${memberGlobalMetaId}: `
      + errorMessage(error),
    );
  }
  return result;
}

/**
 * Deliverable verdict: the chair records one observation about a REMOTE
 * author's deliverable being accepted/rejected. Local authors are skipped (the
 * canonical orchestration evidence + dream pipeline covers them).
 */
export function recordDeliverableVerdictImpression(
  taskId: number,
  authorGlobalMetaId: string,
  verdict: OpenTeamDeliverableVerdict,
  uri?: string | null,
): OpenTeamImpressionRecordResult {
  const result: OpenTeamImpressionRecordResult = { recorded: 0, created: 0, skipped: 0 };
  const deps = resolveDeps();
  if (!deps) return result;
  try {
    const id = Math.trunc(Number(taskId));
    const subject = normalizeGlobalMetaID(authorGlobalMetaId);
    if (!Number.isInteger(id) || id <= 0 || !subject) return result;
    if (verdict !== 'accepted' && verdict !== 'rejected') return result;
    const task = deps.groupTaskStore.getTaskById(id);
    if (!task) return result;
    if (!isRemoteMember(deps, task.id, subject)) return result; // local author or non-member
    const observer = resolveObserverGlobalMetaID(deps, task);
    if (!observer || observer === subject) return result;
    const now = deps.now?.() ?? Date.now();
    const deliverableUri = text(uri) || null;

    // Anchor the idempotency key to the deliverable row when it can be found,
    // so one deliverable yields exactly one verdict observation per verdict.
    const deliverable = deps.groupTaskStore
      .listDeliverables(task.id)
      .filter((candidate) => text(candidate.authorGlobalmetaid).toLowerCase() === subject)
      .reverse()
      .find((candidate) => (text(candidate.uri) || null) === deliverableUri);
    const deliverableDiscriminator = deliverable
      ? `deliverable:${deliverable.id}`
      : `uri:${sha256(deliverableUri ?? '').slice(0, 16)}`;
    const deliverableLabel = deliverable
      ? `${deliverable.kind ?? 'text'} deliverable${deliverableUri ? ` (${deliverableUri})` : ''}`
      : `deliverable${deliverableUri ? ` (${deliverableUri})` : ''}`;

    const appended = appendEventObservation({
      deps,
      observer,
      subject,
      task,
      eventSourceKey: `task:${task.id}:${deliverableDiscriminator}:${verdict}`,
      eventMetadata: {
        event: 'deliverable_verdict',
        taskId: task.id,
        title: task.title,
        subject,
        verdict,
        deliverableId: deliverable?.id ?? null,
        kind: deliverable?.kind ?? null,
        uri: deliverableUri,
        msgPinId: deliverable?.msgPinId ?? null,
      },
      observationText:
        `OpenTeam delivery record: the subject's ${deliverableLabel} in group task `
        + `#${task.id} "${task.title}" was ${verdict} by the observer side.`,
      interpretationText: verdict === 'accepted'
        ? 'An accepted delivery from this remote collaborator (host-recorded fact).'
        : 'A rejected delivery from this remote collaborator (host-recorded fact).',
      dimensions: {
        cooperationContext: 'openteam_remote_group_task',
        relationshipTemperature: verdict === 'accepted' ? 'positive' : 'negative',
        taskId: task.id,
        event: 'deliverable_verdict',
        verdict,
        deliverableId: deliverable?.id ?? null,
        uri: deliverableUri,
      },
      idempotencyKey: `openteam:deliverable-verdict:${task.id}:${deliverableDiscriminator}:${verdict}`,
      now,
    });
    result.recorded += 1;
    if (appended.created) result.created += 1;
  } catch (error) {
    console.warn(
      `[OpenTeam] Deliverable-verdict impression failed for task ${taskId}, author ${authorGlobalMetaId}: `
      + errorMessage(error),
    );
  }
  return result;
}
