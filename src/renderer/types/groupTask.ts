/**
 * Group Task (任务导向群聊) renderer types — mirror of the main-process shapes
 * returned by the groupTask:* IPC surface.
 */

export type GroupTaskStatus = 'planning' | 'executing' | 'review' | 'done' | 'cancelled';
export type GroupTaskMemberRole = 'chair' | 'worker';
export type GroupTaskMemberStatus = 'assigned' | 'working' | 'standby' | 'done' | 'unreachable';
export type GroupTaskDeliverableStatus = 'pending' | 'accepted' | 'rejected';

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
}

export interface GroupTaskDetail extends GroupTask {
  members: GroupTaskMember[];
  deliverables: GroupTaskDeliverable[];
  /** P0-5: state-transition audit log. */
  transitions?: GroupTaskTransition[];
  /** P0-8: public integrity declarations (honest corrections/reports). */
  integrityEvents?: GroupTaskIntegrityEvent[];
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
  at: number;
}

export interface GroupTaskCreateInput {
  title: string;
  goal: string;
  acceptanceCriteria?: string;
  memberMetabotIds?: number[];
}

export type GroupTaskListTab = 'active' | 'done' | 'cancelled' | 'all';
