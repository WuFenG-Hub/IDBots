/**
 * RSI 爬梯卡（跟踪任务顶层星标卡）— 共享类型。
 *
 * 契约来源：《RSI 爬梯卡需求稿 v1（判据与登记口径 · 冻结稿）》
 * pin://8f14471ccc2a7340893e142f3391de9be701e4ffcd4ce6c8bb7d5644fd5ef552i0
 * （§1.2 登记字段 / §1.5 抽验效力 / §2.1–2.2 窗口与分层 / §2.4 可见项 / §2.5 数据契约）。
 *
 * 本文件只放类型与常量：main 侧计算、preload/electron.d.ts 桥类型共用。
 * 计算逻辑在 src/main/services/rsiLadderCompute.ts（纯函数，nowMs 注入）。
 */

/** 卡锚定键（需求稿头部：本卡全部链上登记与抽验回写记录挂此键）。 */
export const RSI_LADDER_TASKKEY = 'local:88';

/** 登记记录的 step（§1.2 冻结）。 */
export const RSI_LADDER_STEP = 'rsi-improvement-registered';

/** 滚动窗口长度：7×24h（§2.1）。 */
export const RSI_LADDER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** 主判据 J：c(W) ≥ 3（§2.1）。 */
export const RSI_LADDER_J_THRESHOLD = 3;

/** improvement_id：commit 全量 sha 或 pin 64hex+i0（§1.2；短 sha 只进展示层）。 */
export const RSI_LADDER_IMPROVEMENT_ID_RE = /^(?:[0-9a-f]{64}|[0-9a-f]{64}i0)$/;

/** 层级（§2.2）。 */
export type RsiLadderLevel = 0 | 1 | 2 | 3 | 4;

/** 登记来源：链上记录 / 本机登记索引回执（缓存兜底，链上为准）。 */
export type RsiLadderSource = 'chain' | 'index';

/** §1.2 extra.evidence 单条。 */
export interface RsiLadderEvidence {
  type: string;
  uri_or_ref: string;
  verify_cmd?: string;
}

/** 一次改进落地登记（§1.2 字段冻结；解析后的视图内形状）。 */
export interface RsiLadderRegistration {
  pinId: string;
  createdAtMs: number;
  source: RsiLadderSource;
  time: string | null;
  timeMs: number | null;
  improvementId: string;
  improvementKind: 'commit' | 'pin' | 'clause' | null;
  initiator: 'owner' | 'bot' | null;
  initiatorId: string;
  reasonSummary: string;
  evidence: RsiLadderEvidence[];
  refs: string[];
  /** 字段契约完整性（§1.2）：缺字段/格式不符 → 异常条目，不参与任何计数。 */
  fieldValid: boolean;
  fieldErrors: string[];
  /** meta 改进（§2.3：改进对象为「改进机制本身」，按 reason_summary 明示判定）。 */
  isMeta: boolean;
  /** 抽验结论（§1.5：待验 / 通过 / 无效；index 兜底条目恒为 unverified）。 */
  reviewState: 'unverified' | 'passed' | 'invalid';
}

/** §1.5 复算步骤 5 的抽验回写记录（kind=review）。 */
export interface RsiLadderReview {
  pinId: string;
  createdAtMs: number;
  source: RsiLadderSource;
  verdict: '通过' | '无效' | null;
  improvementId: string | null;
  refs: string[];
}

/** 链上/index 原始记录（解析 payload 后的中间形状）。 */
export interface RsiLadderChainRecord {
  pinId: string;
  createdAtMs: number;
  source: RsiLadderSource;
  payload: Record<string, unknown>;
}

/** 一条计数的展示行（登记 + 判定结果）。 */
export interface RsiLadderEntry {
  registration: RsiLadderRegistration;
  counted: boolean;
  exclusionReason: string | null;
}

/** 五层之一（§2.2/§2.4）。 */
export interface RsiLadderLayer {
  level: RsiLadderLevel;
  met: boolean;
  /** 支撑该层判据的有效登记 pin 直链（取登记 refs）。 */
  evidenceUris: string[];
}

/** 视图快照（§2.4 五项可见 + §2.5 视图职责）。 */
export interface RsiLadderSnapshot {
  computedAtMs: number;
  /** 数据是否来自链上（false = 链上读取失败，展示本地缓存/索引兜底）。 */
  fromChain: boolean;
  chainError: string | null;
  windows: {
    w0StartMs: number;
    w1StartMs: number;
    w3StartMs: number;
    windowMs: number;
  };
  counts: {
    /** c(W0)：W0 内落地、initiator=bot、抽验通过的有效登记数。 */
    c: number;
    /** p(W0)：W0 内 bot 发起、尚未抽验的登记数（只展示，不计入判据）。 */
    p: number;
    /** c_owner(W0)：对照量，展示用。 */
    cOwner: number;
    /** W0 内被判无效的登记数（展示）。 */
    invalid: number;
  };
  judgment: {
    met: boolean;
    current: number;
    needed: number;
  };
  badge: {
    level: RsiLadderLevel;
  };
  metaCount: {
    w0: number;
    w1: number;
  };
  /** 五层（L4→L0 排序展示）。 */
  layers: RsiLadderLayer[];
  /** 当窗条目明细（含被剔除条目与剔除原因，供巡检复核）。 */
  entries: RsiLadderEntry[];
}

/** IPC 返回（rsiLadder:snapshot）。 */
export interface RsiLadderSnapshotResult {
  success: boolean;
  snapshot?: RsiLadderSnapshot;
  error?: string;
}
