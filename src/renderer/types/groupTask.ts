/**
 * Group Task (任务导向群聊) renderer types — mirror of the main-process shapes
 * returned by the groupTask:* IPC surface.
 */

export type GroupTaskStatus = 'planning' | 'executing' | 'review' | 'done' | 'cancelled';
export type GroupTaskMemberRole = 'chair' | 'worker';
export type GroupTaskMemberStatus = 'assigned' | 'working' | 'standby' | 'done' | 'unreachable';
/** Mirror of the main-process deliverable status ('delivered' = verified on-chain, P3 v1.1). */
export type GroupTaskDeliverableStatus = 'pending' | 'delivered' | 'accepted' | 'rejected';

export interface GroupTask {
  id: number;
  orchestrationTaskId: string | null;
  groupId: string | null;
  title: string;
  goal: string;
  acceptanceCriteria: string | null;
  status: GroupTaskStatus;
  chairMetabotId: number;
  createdBy: string;
  lastProcessedMsgId: number;
  createPinId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  /** Owner acceptance rating (1-5 stars); null for unrated tasks. */
  rating: number | null;
  /** Optional free-text review from the owner alongside the star rating. */
  ratingComment: string | null;
  ratedAt: string | null;
  /** Local-only display name overriding the on-chain title; null = chain title. */
  displayName: string | null;
  /** Local-only pinned flag; pinned tasks sort first in the list. */
  pinned: boolean;
  /** Local-only archive marker (epoch ms; null = active). */
  archivedAt: number | null;
}

export interface GroupTaskMember {
  id: number;
  taskId: number;
  metabotId: number | null;
  globalmetaid: string | null;
  role: GroupTaskMemberRole;
  joinedPinId: string | null;
  createdAt: string | null;
  /** Inviter-side name snapshot for remote members (no local metabots row). */
  displayName?: string | null;
  /** Set when the member was kicked (M3); active members have null. */
  removedAt?: string | null;
  name: string | null;
  /** P0-2: member state-machine status (assigned/working/standby/done/unreachable). */
  status?: GroupTaskMemberStatus;
  /** P0-2: sqlite UTC timestamp of the last status change. */
  statusChangedAt?: string | null;
  /** P0-2: epoch seconds of the member's last chain speech (summary/detail). */
  lastSpeakAt?: number | null;
}


export interface GroupTaskIntegrityEvent {
  id: number;
  taskId: number;
  msgPinId: string | null;
  authorGlobalmetaid: string | null;
  eventType: 'correction' | 'honest_report';
  detail: string | null;
  createdAt: string | null;
}

export interface GroupTaskTransition {
  id: number;
  taskId: number;
  fromStatus: GroupTaskStatus | null;
  toStatus: GroupTaskStatus;
  actor: string | null;
  reason: string | null;
  createdAt: string | null;
}

export interface GroupTaskDeliverable {
  id: number;
  taskId: number;
  msgPinId: string | null;
  authorGlobalmetaid: string | null;
  kind: string | null;
  uri: string | null;
  status: GroupTaskDeliverableStatus;
  createdAt: string | null;
  /** P0-4: JSON verification report (multi-source outcomes). */
  verification?: string | null;
  /**
   * Issue #8: on-chain confirmation state driven by multi-source verification,
   * ORTHOGONAL to `status` (owner acceptance): a deliverable can be
   * on-chain-confirmed while still pending acceptance.
   */
  confirmation?: 'unconfirmed' | 'confirmed';
  /**
   * Body + sender of the [DELIVERABLE] message that produced this row (joined
   * by msg_pin_id on the main side). Lets the UI fold text deliverables (which
   * carry no uri). Absent for callers that do not join the message table.
   */
  sourceContent?: string | null;
  sourceSenderName?: string | null;
}

export type GroupTaskMemberWorkStatus = 'working' | 'error' | 'timeout' | 'idle' | 'unknown';

export type GroupTaskCheckpointStatus = 'open' | 'resolved' | 'cancelled';

/**
 * HITL checkpoint: a mid-task pause point opened by the chair
 * (`[CHECKPOINT: <topic>]`) for the owner's decision, resolved by
 * `[CHECKPOINT_RESOLVED: <decision>]`. At most one is 'open' per task.
 */
export interface GroupTaskCheckpoint {
  id: number;
  taskId: number;
  topic: string | null;
  openedMsgPinId: string | null;
  status: GroupTaskCheckpointStatus;
  resolution: string | null;
  resolvedMsgPinId: string | null;
  createdAt: string | null;
  resolvedAt: string | null;
}

/** One deliverable row inside an acceptance summary (immutable snapshot). */
export interface GroupTaskAcceptanceSummaryDeliverable {
  kind: string | null;
  uri: string | null;
  status: GroupTaskDeliverableStatus;
  confirmation: 'unconfirmed' | 'confirmed';
  authorName: string | null;
}

/** One member row inside an acceptance summary (immutable snapshot). */
export interface GroupTaskAcceptanceSummaryMember {
  name: string | null;
  role: 'chair' | 'worker';
  /** Self-reported status snapshot (host-derived workStatus is a P1/R6 concern). */
  workStatus: string;
}

/**
 * R1: host-generated, deterministic acceptance summary ("把菜端上桌"). Single
 * source of truth for the group's last review message, the owner private
 * report, and the R2 source-session notification. Null before review entry.
 */
export interface GroupTaskAcceptanceSummary {
  id: number;
  taskId: number;
  version: number;
  goal: string;
  acceptanceCriteria: string | null;
  deliverables: GroupTaskAcceptanceSummaryDeliverable[];
  members: GroupTaskAcceptanceSummaryMember[];
  guidance: string;
  /**
   * Improvement #1 (single-card acceptance): the chair's one-line conclusion —
   * the single authoritative string headed on the card, the group summary
   * message, and the source-session notice. Null until captured at review
   * entry (the card then shows a deterministic deliverable-count fallback).
   */
  conclusion: string | null;
  outcome: GroupTaskStatus | null;
  rating: number | null;
  ratingComment: string | null;
  generatedBy: string;
  generatedAt: string | null;
  publishedGroupPinId: string | null;
  notifiedSession: string | null;
}

export interface GroupTaskMemberSummary extends GroupTaskMember {
  /** Epoch seconds of the member's last chain speech (round-4). */
  lastSpeakAt?: number | null;
  /** Epoch ms of the member's last `[WORKING]` tag message (P1-4). */
  lastWorkingAt?: number | null;
  /** Host-computed work state (P1-4): idle/working/error/unknown. */
  workStatus?: GroupTaskMemberWorkStatus;
}

export interface GroupTaskStatusEvent {
  id: number;
  taskId: number;
  fromStatus: string;
  toStatus: string;
  actorKind: 'chair' | 'owner' | 'system';
  actorGlobalMetaId: string | null;
  actorName: string | null;
  /** sqlite datetime('now') text, UTC. */
  createdAt: string | null;
}

export interface GroupTaskDriverInfo {
  instanceId: string;
  atMs: number;
}

export interface GroupTaskDetail extends GroupTask {
  members: GroupTaskMemberSummary[];
  deliverables: GroupTaskDeliverable[];
  /** Round-4/R6: true when a non-terminal task has had no host drive recently. */
  stall?: boolean;
  /** Round-4/R6: the stall threshold in minutes (30 by default). */
  stallAfterMinutes?: number;
  /** P0-5: state-transition audit log. */
  transitions?: GroupTaskTransition[];
  /** P0-8: public integrity declarations (honest corrections/reports). */
  integrityEvents?: GroupTaskIntegrityEvent[];
  /** P1-5: status transition history (newest first). */
  statusEvents?: GroupTaskStatusEvent[];
  /** P2-8: the daemon instance currently driving this task. */
  driver?: GroupTaskDriverInfo | null;
  /** HITL: human checkpoints of the task, oldest first. */
  checkpoints?: GroupTaskCheckpoint[];
  /** R1: latest host-generated acceptance summary (single source of truth). */
  acceptanceSummary?: GroupTaskAcceptanceSummary | null;
  /**
   * HITL: what the owner must decide right now — the tag-free body of the
   * chair's [CHECKPOINT] message that opened the open checkpoint (null when
   * unavailable; the banner then falls back to the checkpoint topic).
   */
  openCheckpointSummary?: string | null;
}

export interface GroupTaskSummary extends GroupTask {
  memberCount: number;
  chairName: string | null;
  memberNames: string[];
}

export interface GroupChatTranscriptMessage {
  id: number;
  pinId: string | null;
  txId: string | null;
  senderName: string | null;
  senderGlobalMetaId: string | null;
  senderAvatar: string | null;
  content: string | null;
  contentType: string | null;
  chainTimestamp: number | null;
  msgIndex: number | null;
  replyPin: string | null;
  /** Round-4 attribution: chain GlobalMetaID is not a task member/owner. */
  senderSuspect?: boolean;
}

export interface GroupTaskStatusEvent {
  type: 'groupTask:statusChanged';
  taskId: number;
  status: string;
  at: number;
}

export interface GroupTaskOwnerReportDeliveryEvent {
  type: 'groupTask:ownerReportDelivery';
  taskId: number;
  outcome: 'sent' | 'failed';
  pinId?: string | null;
  sessionId?: string | null;
  displayError?: string | null;
  error?: string | null;
  /** 'review' (default) = acceptance report; 'checkpoint' = HITL checkpoint request. */
  kind?: 'review' | 'checkpoint';
  checkpointId?: number | null;
  at: number;
}

/** HITL: a checkpoint opened/resolved — the detail view should refetch. */
export interface GroupTaskCheckpointChangedEvent {
  type: 'groupTask:checkpointChanged';
  taskId: number;
  checkpointId: number;
  status: 'open' | 'resolved';
  at: number;
}

export interface GroupTaskCreateInput {
  title: string;
  goal: string;
  acceptanceCriteria?: string;
  memberMetabotIds?: number[];
}

export type GroupTaskListTab = 'active' | 'done' | 'cancelled' | 'all';
