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

/** v1.1 准入规则（冻结件 §2）。宽口径 = 任一条；严口径 = ADM-1 ∨ ADM-3。 */
export type TrackedAdmissionRule = 'ADM-1' | 'ADM-2' | 'ADM-3' | 'ADM-4' | 'ADM-5';

/** 准入口径开关；持久化在既有 `kv` 表，改它不动任何数据结构。 */
export type TrackedAdmissionMode = 'wide' | 'strict';

export const TRACKED_ADMISSION_RULE_LABEL_KEYS: Record<TrackedAdmissionRule, string> = {
  'ADM-1': 'trackedTask.admission.adm1',
  'ADM-2': 'trackedTask.admission.adm2',
  'ADM-3': 'trackedTask.admission.adm3',
  'ADM-4': 'trackedTask.admission.adm4',
  'ADM-5': 'trackedTask.admission.adm5',
};

/** closureDue 的三级来源：跨列正交标志，不是第 5 列（chair D1）。 */
export type TrackedClosureDueLevel = 'zombie' | 'terminal_no_conclusion' | 'sessions_ended';

export const TRACKED_DUE_LEVEL_LABEL_KEYS: Record<TrackedClosureDueLevel, string> = {
  zombie: 'trackedTask.dueLevel.zombie',
  terminal_no_conclusion: 'trackedTask.dueLevel.terminalNoConclusion',
  sessions_ended: 'trackedTask.dueLevel.sessionsEnded',
};

/**
 * v1.2：把结论标为「已处理」的人。不含 `system_backfill` —— 迁移补写的结论
 * 不是指令，永不入待执行队列（冻结件 §3.1 T2）。
 */
export type TrackedClosureProcessedBy = 'owner' | 'twin';

/** 状态摘要事实的 code（主进程 TrackedReasonCode 的逐字镜像）。 */
export type TrackedReasonCode =
  | 'ledger_review'
  | 'steps_waiting_input'
  | 'open_checkpoints'
  | 'blocked_unmet_dependencies'
  | 'steps_active'
  | 'attempts_open'
  | 'deliverables_verifiable'
  | 'terminal_without_conclusion'
  | 'idle_days'
  | 'linked_sessions';

/** 一句话收口建议的 code（主进程 TrackedSuggestionCode 的逐字镜像）。 */
export type TrackedSuggestionCode =
  | 'terminal_no_conclusion'
  | 'deliverables_verifiable'
  | 'unresolved_dependencies'
  | 'session_ended'
  | 'stale_inactivity';

export type TrackedFactCode = TrackedReasonCode | TrackedSuggestionCode;

/**
 * 结构化事实：code + **`params`**（字段名 = 契约字面，定稿于 chair 14:45 改判；
 * 主进程同名字段见 `TrackedFact.params` / `closureSuggestionParams`）。
 * **界面文案由 renderer 按 i18n 渲染**，不直接显示后端英文串。
 * 跨端字段名一致性由 `tests/trackedTaskFactText.test.ts` 的行为断言守住（按主进程
 * 声明的字段名构造载荷再喂给 renderer，读错字段就取不到值、测试即红）。
 */
export interface TrackedFact {
  code: TrackedFactCode;
  params: Record<string, string | number>;
}

/** 收口建议 code 的参数（与 code 一同构成权威事实）；无建议时为 null。 */
export type TrackedSuggestionParams = Record<string, string | number>;

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
  /** 后端事实串（英文，供日志/排障）；界面文案一律由 reasonCodes 渲染。 */
  closureSuggestion: string;
  /** 结构化收口建议 code —— 界面文案归 renderer。 */
  closureSuggestionCode: TrackedSuggestionCode | null;
  /** 收口建议参数；code 为 null 时为 null（附录 B B-5.3）。 */
  closureSuggestionParams: TrackedSuggestionParams | null;
  closureConclusion: string | null;
  /**
   * v1.2 读时投影（冻结件 §2.3）：这条结论**尚未被执行**。
   * 与 `closureDue`（该收口了）正交 —— 一个问「还有指令没执行」，一个问「该收口了吗」。
   */
  closurePending: boolean;
  closureProcessedAt: string | null;
  closureProcessedBy: TrackedClosureProcessedBy | null;
  closureReceipt: string | null;
  closureReceiptPinId: string | null;
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
  /**
   * v1.1 准入判定（后端读时投影）：`archived := ¬admitted`。
   * v1.3 起手工归档 override 也把本位压成 false（kv 单行，可逆）。
   * 归档卡不出现在看板/全量视图，但仍可经 `scope:'archived'` 与 `getCard` 查到。
   */
  admitted: boolean;
  /**
   * 命中的准入规则（ADM-1..ADM-5）。¬admitted 且无 v1.3 override 时为空数组；
   * 手工归档的卡保留命中记录——准入判定是事实，override 只是叠加开关。
   */
  admissionMatched: TrackedAdmissionRule[];
  /** 诊断位：本卡的准入输入不是布尔（漏传）。正常路径恒为 false。 */
  admissionInputMissing: boolean;
  /** 「需要我出手」的权威判定（后端给出），前端不重算。 */
  needsOwnerAction: boolean;
  /** 「需要我出手」的权威排序键（后端给出），前端只用它排序。 */
  actionRank: number;
  /** 当前权威状态摘要的**事实串**（英文，硬截前 5 条）；界面显示请用 reasonCodes。 */
  reasons: string[];
  /** 当上摘要的结构化事实，与 reasons 一一对应。 */
  reasonCodes: TrackedFact[];
  /** 被 ≤5 硬截断丢掉的条数——抽屉显示「…另有 N 条」。 */
  reasonOverflow: number;
}

export interface TrackedCardCounts {
  total: number;
  visible: number;
  /** 被默认范围折叠掉的卡；必须可达，不得静默隐藏（D3）。 */
  folded: number;
  /** v1.1：通过准入的卡数；只有它们可能 closureDue。 */
  admitted: number;
  /** v1.1：`¬admitted` 的卡数；`admitted + archived === total` 是硬不变量。 */
  archived: number;
  /** 诊断用：登记名册里已不存在于台账的 id 数（冻结件 §2 ADM-1）。 */
  staleRegistration: number;
  /** 诊断用：准入输入漏传的卡数。正常路径恒为 0，非 0 即「静默不排队」的告警。 */
  admissionInputMissing: number;
  closureDue: number;
  /** 第 1 级：超过僵尸阈值。 */
  zombieLevel: number;
  /** 第 2 级：终态但没有结论。 */
  terminalNoConclusionLevel: number;
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

/**
 * 看板范围：`default` = 近期活动 ∪ 全部 closureDue；`all` = 全部**已准入**卡（不折叠）；
 * `archived` = 恰好 `¬admitted` 的行（只读归档视图，永不进收口队列）。
 */
export type TrackedCardScope = 'default' | 'all' | 'archived';

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
  /** 原样回显调用方所传的范围；省略时为 null。 */
  scopeRequested: string | null;
  /** 回显实际生效的范围，界面据此标注筛选并提供一键清除。 */
  scopeApplied: TrackedCardScope;
  /** true = 所传范围不是三个已知值；界面必须显式标注，不得当作正常 default。 */
  scopeFallback: boolean;
  scopeWindowMs: number;
  /** 进程内单调序列，供 renderer 去重。 */
  seq: number;
  columns: Array<{ state: TrackedCardState; labelKey: string; cardIds: string[] }>;
  cards: TrackedCardSummary[];
  /**
   * 页内基数（PAGE），不是可见集：只覆盖当前页，**禁止**用于看板级总计或横幅。
   * 看板级数字读 `counts.closureDue` / `counts.zombieLevel` /
   * `counts.terminalNoConclusionLevel` / `counts.sessionsEndedLevel`。
   */
  closureDueCardIdsPage: string[];
  closureDueCountPage: number;
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

/**
 * v1.3 手工归档结果（主进程 trackedTaskBoard.archiveCard 的逐字镜像）。
 * kv 单行 override：无新列新表、可逆，ledger 行本身不动。
 */
export interface TrackedCardArchiveResult {
  ok: boolean;
  code?: 'NOT_FOUND' | 'VALIDATION';
  error?: string;
  /** 刷新后的卡摘要；归档成功时 admitted 已经是 false。 */
  card?: TrackedCardSummary;
}

/** 收口入参（经主进程白名单写入，前端不直写 status）。 */
export interface TrackedCardClosureInput {
  cardId: string;
  /** v1.4：结论选填——空/留空归一为 NULL，语义＝仅确认验收、无执行指令。 */
  conclusion: string | null;
  /** v1.4：弹窗收口固定 owner；保留字段以兼容历史调用（twin）。 */
  by?: 'owner' | 'twin';
  targetStatus?: 'completed' | 'cancelled';
}

/** 收口回执（UI 要区分「状态已推进」与「结论已记录、状态保留」）。 */
export interface TrackedCardClosureReceipt {
  cardId: string;
  statusMoved: boolean;
  statusNote: string;
}

/** 长期任务页的内层视图（看板 / 清单 / 归档）。归档视图是只读列表。 */
export type TrackedTaskViewMode = 'board' | 'list' | 'archive';

/** 跟踪任务页的外层 Tab：「长期任务」默认在前，「定时任务」原样保留。 */
export type TrackingTabId = 'longTerm' | 'scheduled';
