// 长期任务看板 v1（跟踪任务）— 渲染层类型
//
// 权威来源（两份，都必须对表）：
//   1) 架构契约 v1.4（唯一冻结引用）pin://2c890396c8b57c3229ab0d8a6085db579954e877e9e373eea68fbdaa58f3c4c8i0
//   2) 主进程契约实现 src/main/services/trackedTaskBoard.ts（TrackedCardSummary / Detail / Board / CloseResult）
//      —— renderer 只消费，不自己推导卡面状态（契约：落库只放事实，派生一律读时算）。
//
// 本文件逐字镜像主进程的字段名与枚举值。字段级争议回读上列两处，不按本文件的注释裁决。

/** 卡面四态。字符串值即契约枚举，禁止改写成中文标识。 */
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

/** closureDue 的三级来源：跨列正交标志，不是第 5 列（chair D1）。 */
export type TrackedClosureDueLevel = 'zombie' | 'terminal_missing_conclusion' | 'sessions_ended';

export const TRACKED_DUE_LEVEL_LABEL_KEYS: Record<TrackedClosureDueLevel, string> = {
  zombie: 'trackedTask.dueLevel.zombie',
  terminal_missing_conclusion: 'trackedTask.dueLevel.terminalMissingConclusion',
  sessions_ended: 'trackedTask.dueLevel.sessionsEnded',
};

/** 台账原生 status 的取值域（不改 CHECK 的 6 值）。 */
export type TrackedLedgerStatus =
  | 'planning'
  | 'running'
  | 'review'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** 卡的生命周期来源：群任务 / 定时任务 / 会话。 */
export type TrackedCardSourceKind = 'group_task' | 'scheduled_task' | 'session';

/** 关联会话的 role（5 路 UNION 的判别列）。 */
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
  ledgerStatus: TrackedLedgerStatus;
  closureWarn: boolean;
  closureDue: boolean;
  closureDueLevel: TrackedClosureDueLevel | null;
  closureSuggestion: string;
  closureConclusion: string | null;
  /** 计算出的活动锚点（多源 max）；永不落库，也不由心跳喂。 */
  activityAtMs: number | null;
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
  /** 当前权威状态摘要（后端硬截前 5 条）。 */
  reasons: string[];
  /** 被 ≤5 硬截断丢掉的条数——抽屉显示「…另有 N 条」。 */
  reasonOverflow: number;
}

export interface TrackedCardCounts {
  total: number;
  visible: number;
  /** 被默认范围折叠掉的卡；必须可达，不得静默隐藏（D3）。 */
  folded: number;
  closureDue: number;
  /** 第 1 级：超过僵尸阈值。 */
  zombieLevel: number;
  /** 第 2 级：终态但没有结论。 */
  terminalMissingConclusionLevel: number;
  /** 第 3 级：全部关联会话已结束且无排队任务。 */
  sessionsEndedLevel: number;
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
  /** 参与席 metabotId 列表（后端给，已排序）。 */
  participants: number[];
  sessions: TrackedCardSessionLink[];
  deliverables: Array<{ uri: string; status: string; confirmation: string; kind: string }>;
  events: Array<{ at: string | null; kind: string; detail: string }>;
  closure: { conclusion: string | null; by: string | null; at: string | null; pinId: string | null };
}

/** 看板范围：`default` = 近期活动 ∪ 全部 closureDue；`all` = 不折叠。 */
export type TrackedCardScope = 'default' | 'all';

export interface TrackedCardListInput {
  ownerGlobalMetaId?: string;
  scope?: TrackedCardScope;
  limit?: number;
  offset?: number;
}

/** 一次 list 的完整看板投影。 */
export interface TrackedCardBoard {
  ledger: 'orchestration_tasks';
  generatedAtMs: number;
  /** 回显实际生效的范围，界面据此标注筛选并提供一键清除。 */
  scopeApplied: TrackedCardScope;
  scopeWindowMs: number;
  /** 进程内单调序列，供 renderer 去重。 */
  seq: number;
  columns: Array<{ state: TrackedCardState; labelKey: string; cardIds: string[] }>;
  cards: TrackedCardSummary[];
  closureDueCardIds: string[];
  closureDueCount: number;
  counts: TrackedCardCounts;
  /** limit/offset 之外还有卡时为 true。 */
  hasMore: boolean;
}

export interface TrackedCardCloseResult {
  ok: boolean;
  /** F1 两段写之后，「状态迁移被拒」这一错误码已不可达，故不在取值域内。 */
  code?: 'NOT_FOUND' | 'VALIDATION';
  error?: string;
  card?: TrackedCardSummary;
  /** status 是否真的推进了；结论列无论状态是否推进都会写。 */
  statusMoved?: boolean;
  statusNote?: string;
}

/** 收口入参（经主进程白名单写入，前端不直写 status）。 */
export interface TrackedCardClosureInput {
  cardId: string;
  conclusion: string;
  by: 'owner' | 'twin';
  targetStatus?: 'completed' | 'cancelled';
}

/** 收口回执（UI 要区分「状态已推进」与「结论已记录、状态保留」）。 */
export interface TrackedCardClosureReceipt {
  cardId: string;
  statusMoved: boolean;
  statusNote: string;
}

/** 长期任务页的内层视图（看板 / 清单）。 */
export type TrackedTaskViewMode = 'board' | 'list';

/** 跟踪任务页的外层 Tab：「长期任务」默认在前，「定时任务」原样保留。 */
export type TrackingTabId = 'longTerm' | 'scheduled';
