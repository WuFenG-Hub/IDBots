/**
 * Group Task (任务导向群聊) renderer types — mirror of the main-process shapes
 * returned by the groupTask:* IPC surface.
 */

export type GroupTaskStatus = 'planning' | 'executing' | 'review' | 'done' | 'cancelled';
export type GroupTaskMemberRole = 'chair' | 'worker';
export type GroupTaskDeliverableStatus = 'pending' | 'accepted' | 'rejected';

export interface GroupTask {
  id: number;
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
}

export interface GroupTaskMember {
  id: number;
  taskId: number;
  metabotId: number | null;
  globalmetaid: string | null;
  role: GroupTaskMemberRole;
  joinedPinId: string | null;
  createdAt: string | null;
  name: string | null;
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
}

export interface GroupTaskDetail extends GroupTask {
  members: GroupTaskMember[];
  deliverables: GroupTaskDeliverable[];
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
}

export interface GroupTaskStatusEvent {
  type: 'groupTask:statusChanged';
  taskId: number;
  status: string;
  at: number;
}

export interface GroupTaskCreateInput {
  title: string;
  goal: string;
  acceptanceCriteria?: string;
  memberMetabotIds?: number[];
}

export type GroupTaskListTab = 'active' | 'done' | 'cancelled' | 'all';
