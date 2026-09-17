// 长期任务看板 v1（跟踪任务）— 渲染层类型
//
// 权威来源（两份，都必须对表）：
//   1) 架构规格 pin://4c560264d874a569645142d671258908c26492509b9e03c813edae2035be1503i0
//   2) 主进程契约实现 src/main/services/trackedTaskBoard.ts（TrackedCardSummary / Detail / Board / CloseResult）
//      —— renderer 只消费，不自己推导卡面状态（规格 §2.1：纯派生、零漂移）。
//
// 本文件**逐字镜像**主进程的字段名与枚举值。字段级争议回读上列两处，不按本文件的注释裁决。

/** §2.2 卡面四态。字符串值即契约枚举，禁止改写成中文标识。 */
export type TrackedCardState =
  | 'waiting_decision' // 待你拍板
  | 'in_progress' // 进行中
  | 'blocked_external' // 等外部·阻塞
  | 'closed'; // 已收口

/** 看板列显示顺序的兜底值；有 board.columns 时以后端给的顺序为准。 */
export const TRACKED_BOARD_COLUMN_FALLBACK: TrackedCardState[] = [
  'waiting_decision',
  'in_progress',
  'blocked_external',
  'closed',
];

/** 卡的生命周期来源（§1.2）：群任务 / 定时任务 / 会话。 */
export type TrackedCardSourceKind = 'group_task' | 'scheduled_task' | 'session';

/** §4 关联会话的 role（5 路 UNION 的判别列）。 */
export type TrackedCardSessionRole =
  | 'source'
  | 'worker_attempt'
  | 'scheduled_run'
  | 'group_chat'
  | 'scheduled_home';

export interface TrackedCardSessionLink {
  sessionId: string;
  role: TrackedCardSessionRole;
}

export const TRACKED_SESSION_ROLE_LABEL_KEYS: Record<TrackedCardSessionRole, string> = {
  source: 'trackedTask.sessionRole.source',
  worker_attempt: 'trackedTask.sessionRole.workerAttempt',
  scheduled_run: 'trackedTask.sessionRole.scheduledRun',
  group_chat: 'trackedTask.sessionRole.groupChat',
  scheduled_home: 'trackedTask.sessionRole.scheduledHome',
};

export const TRACKED_SOURCE_KIND_LABEL_KEYS: Record<TrackedCardSourceKind, string> = {
  group_task: 'trackedTask.sourceKind.groupTask',
  scheduled_task: 'trackedTask.sourceKind.scheduledTask',
  session: 'trackedTask.sourceKind.session',
};

/** 看板列里的一张卡（= orchestration_tasks 一行的投影）。 */
export interface TrackedCardSummary {
  id: string;
  /** 抽屉「目标」主字段（owner_intent）。 */
  title: string;
  goal: string;
  state: TrackedCardState;
  /** 后端给的列名 i18n key（trackedTask.column.*）——渲染层照用，不另立一份。 */
  stateLabelKey: string;
  /** 台账原生 status，看板永不改写它。 */
  ledgerStatus: string;
  closureWarn: boolean;
  closureDue: boolean;
  closureSuggestion: string;
  closureConclusion: string | null;
  lastActivityAtMs: number | null;
  idleMs: number | null;
  createdAt: string;
  updatedAt: string;
  sourceSessionId: string | null;
  sourceKind: TrackedCardSourceKind;
  groupTaskId: number | null;
  scheduledTaskId: string | null;
  /** 「需要我出手」的权威判定（后端给出），前端不重算。 */
  needsOwnerAction: boolean;
  /** 「需要我出手」的权威排序键（后端给出），前端只用它排序。 */
  actionRank: number;
  /** 当前权威状态摘要（后端已截前 5 条）。 */
  reasons: string[];
}

export interface TrackedCardDetail extends TrackedCardSummary {
  enrichedGoal: string | null;
  acceptanceCriteria: unknown[];
  owner: { twinMetabotId: number; ownerGlobalMetaId: string };
  planVersion: number;
  completedAt: string | null;
  nextCheckpointAt: string | null;
  checkpoints: Array<{ topic: string | null; status: string; createdAt: string | null }>;
  dependencies: Array<{
    stepId: string;
    title: string;
    status: string;
    dependsOn: string[];
    unmet: string[];
  }>;
  steps: Array<{
    id: string;
    ordinal: number;
    title: string;
    status: string;
    assigneeMetabotId: number | null;
  }>;
  sessions: TrackedCardSessionLink[];
  deliverables: Array<{ uri: string; status: string; confirmation: string }>;
  events: Array<{ at: string | null; kind: string; detail: string }>;
  closure: { conclusion: string | null; by: string | null; at: string | null; pinId: string | null };
}

/** 一次 list 的完整看板投影。 */
export interface TrackedCardBoard {
  ledger: 'orchestration_tasks';
  generatedAtMs: number;
  /** 列顺序与列名 key 由后端给定：前端不再自行维护第二份列定义。 */
  columns: Array<{ state: TrackedCardState; labelKey: string; cardIds: string[] }>;
  cards: TrackedCardSummary[];
  closureDueCardIds: string[];
  closureDueCount: number;
}

export interface TrackedCardCloseResult {
  ok: boolean;
  code?: 'NOT_FOUND' | 'VALIDATION' | 'TRANSITION_NOT_ALLOWED';
  error?: string;
  card?: TrackedCardSummary;
}

/** 收口入参（走 orchestrationStore.updateTaskStatus + TASK_TRANSITIONS 白名单）。 */
export interface TrackedCardClosureInput {
  cardId: string;
  conclusion: string;
  by: 'owner' | 'twin';
  targetStatus?: 'completed' | 'cancelled';
}

/** 长期任务页的内层视图（看板 / 清单）。 */
export type TrackedTaskViewMode = 'board' | 'list';

/** 跟踪任务页的外层 Tab：「长期任务」默认在前，「定时任务」原样保留。 */
export type TrackingTabId = 'longTerm' | 'scheduled';
