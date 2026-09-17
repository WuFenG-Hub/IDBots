/**
 * RSI 爬梯卡 — 纯计算层（窗口 / 计数 / 五层判据 / 徽章）。
 *
 * 契约来源：《RSI 爬梯卡需求稿 v1（冻结稿）》
 * pin://8f14471ccc2a7340893e142f3391de9be701e4ffcd4ce6c8bb7d5644fd5ef552i0
 *
 * 硬规则（§2.5 视图职责）：按 §2.1/§2.2 从登记链重算 c/p/徽章；不内置登记写入；
 * 不发明计数来源。本模块为纯函数：所有时间以 `nowMs` 注入，同输入必同输出。
 */
import type {
  RsiLadderChainRecord,
  RsiLadderEntry,
  RsiLadderEvidence,
  RsiLadderLayer,
  RsiLadderLevel,
  RsiLadderRegistration,
  RsiLadderReview,
  RsiLadderSnapshot,
} from '../../renderer/types/rsiLadder';
import {
  RSI_LADDER_IMPROVEMENT_ID_RE,
  RSI_LADDER_J_THRESHOLD,
  RSI_LADDER_STEP,
  RSI_LADDER_TASKKEY,
  RSI_LADDER_WINDOW_MS,
} from '../../renderer/types/rsiLadder';

/** §1.2 improvement_kind 闭集。 */
const IMPROVEMENT_KINDS = ['commit', 'pin', 'clause'] as const;

const PINID_RE = /^[0-9a-f]{64}i0$/;

/**
 * §2.3 meta 改进判定：登记 reason_summary 明示改进对象（改进机制本身）。
 * 保守关键词表——只认 §2.3 枚举对象的显式表述；抽验时核对实际变更（人审），
 * 视图只做关键词级识别并在 UI 暴露计数供巡检复核。
 */
const META_REASON_RE = /改进改进机制|改进机制本身|登记字段|判定口径|登记口径|抽验方法|层判据|视图数据契约|爬梯视图数据契约|L0[–-]L4/;

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseTimeMs(value: unknown): number | null {
  const raw = asString(value);
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/** 链上记录按 taskkey 过滤并分类（登记 kind=status / 抽验回写 kind=review）。 */
export function classifyRecord(record: RsiLadderChainRecord): 'registration' | 'review' | null {
  const payload = record.payload;
  if (asString(payload?.taskkey) !== RSI_LADDER_TASKKEY) return null;
  const kind = asString(payload?.kind);
  if (kind === 'status' && asString(payload?.step) === RSI_LADDER_STEP) return 'registration';
  if (kind === 'review' && asString(payload?.summary).startsWith('抽验')) return 'review';
  return null;
}

function validateRegistrationFields(payload: Record<string, unknown>): {
  fieldValid: boolean;
  fieldErrors: string[];
  evidence: RsiLadderEvidence[];
  improvementId: string;
} {
  const extra = (payload?.extra ?? null) as Record<string, unknown> | null;
  const fieldErrors: string[] = [];
  const improvementId = asString(extra?.improvement_id);
  if (!RSI_LADDER_IMPROVEMENT_ID_RE.test(improvementId)) {
    fieldErrors.push('improvement_id 不是全量 64hex/64hex+i0');
  }
  const kind = asString(extra?.improvement_kind);
  if (!(IMPROVEMENT_KINDS as readonly string[]).includes(kind)) {
    fieldErrors.push('improvement_kind 不在闭集 commit|pin|clause');
  }
  const initiator = asString(extra?.initiator);
  if (initiator !== 'owner' && initiator !== 'bot') {
    fieldErrors.push('initiator 不是 owner|bot');
  }
  if (parseTimeMs(extra?.time) === null) {
    fieldErrors.push('extra.time 缺失或非 ISO8601');
  }
  if (!asString(extra?.initiator_id)) {
    fieldErrors.push('initiator_id 缺失');
  }
  if (!asString(extra?.reason_summary)) {
    fieldErrors.push('reason_summary 缺失');
  }
  const evidenceRaw = Array.isArray(extra?.evidence) ? extra.evidence : [];
  const evidence: RsiLadderEvidence[] = [];
  if (evidenceRaw.length < 1) {
    fieldErrors.push('evidence 至少 1 条');
  }
  for (const item of evidenceRaw) {
    if (item && typeof item === 'object') {
      const entry = item as Record<string, unknown>;
      evidence.push({
        type: asString(entry.type),
        uri_or_ref: asString(entry.uri_or_ref),
        verify_cmd: asString(entry.verify_cmd) || undefined,
      });
    }
  }
  return { fieldValid: fieldErrors.length === 0, fieldErrors, evidence, improvementId };
}

/** 链上记录 → 登记视图模型（字段契约校验 + meta 识别）。 */
export function buildRegistration(record: RsiLadderChainRecord): RsiLadderRegistration {
  const extra = (record.payload?.extra ?? null) as Record<string, unknown> | null;
  const { fieldValid, fieldErrors, evidence, improvementId } = validateRegistrationFields(record.payload);
  const timeMs = parseTimeMs(extra?.time);
  return {
    pinId: record.pinId,
    createdAtMs: record.createdAtMs,
    source: record.source,
    time: asString(extra?.time) || null,
    timeMs,
    improvementId,
    improvementKind: (asString(extra?.improvement_kind) || null) as RsiLadderRegistration['improvementKind'],
    initiator: (asString(extra?.initiator) || null) as RsiLadderRegistration['initiator'],
    initiatorId: asString(extra?.initiator_id),
    reasonSummary: asString(extra?.reason_summary),
    evidence,
    refs: Array.isArray(record.payload?.refs)
      ? (record.payload.refs as unknown[]).map((ref) => asString(ref)).filter(Boolean)
      : [],
    fieldValid,
    fieldErrors,
    isMeta: META_REASON_RE.test(asString(extra?.reason_summary)),
    // index 兜底条目没有链上抽验回写可对（§2.5 链上为准），恒为待验。
    reviewState: record.source === 'index' ? 'unverified' : 'unverified',
  };
}

/** 抽验回写记录 → review 视图模型（§1.5 步骤5：summary=抽验 <通过|无效> improvement_id=<id>）。 */
export function buildReview(record: RsiLadderChainRecord): RsiLadderReview {
  const summary = asString(record.payload?.summary);
  const verdict = summary.includes('无效') ? ('无效' as const) : summary.includes('通过') ? ('通过' as const) : null;
  const idMatch = /improvement_id=([0-9a-f]{64}(?:i0)?)/.exec(summary);
  let improvementId = idMatch ? idMatch[1] : '';
  const extra = (record.payload?.extra ?? null) as Record<string, unknown> | null;
  const extraId = asString(extra?.improvement_id);
  if (RSI_LADDER_IMPROVEMENT_ID_RE.test(extraId)) improvementId = extraId;
  return {
    pinId: record.pinId,
    createdAtMs: record.createdAtMs,
    source: record.source,
    verdict,
    improvementId: improvementId || null,
    refs: Array.isArray(record.payload?.refs)
      ? (record.payload.refs as unknown[]).map((ref) => asString(ref)).filter(Boolean)
      : [],
  };
}

/**
 * 把原始记录分类并建模；输出登记 + 抽验两组视图模型。
 * 输入顺序无关：内部按 (createdAtMs, pinId) 升序重排，保证幂等与去重确定性。
 */
export function buildModels(records: RsiLadderChainRecord[]): {
  registrations: RsiLadderRegistration[];
  reviews: RsiLadderReview[];
} {
  const sorted = [...records].sort((a, b) => a.createdAtMs - b.createdAtMs || (a.pinId < b.pinId ? -1 : 1));
  const registrations: RsiLadderRegistration[] = [];
  const reviews: RsiLadderReview[] = [];
  for (const record of sorted) {
    const kind = classifyRecord(record);
    if (kind === 'registration') registrations.push(buildRegistration(record));
    if (kind === 'review') reviews.push(buildReview(record));
  }
  return { registrations, reviews };
}

/**
 * 幂等第一层镜像（§1.5 步骤4）：同一 improvement_id 存在第二条有效登记 → 后者无效。
 * 「后者」按 (createdAtMs, pinId) 升序判定；重复 id 的第一条保留。
 */
export function markDuplicateSuperseded(registrations: RsiLadderRegistration[]): Set<string> {
  const superseded = new Set<string>();
  const seen = new Map<string, RsiLadderRegistration>();
  for (const registration of registrations) {
    if (!registration.fieldValid) continue;
    const first = seen.get(registration.improvementId);
    if (first) {
      superseded.add(registration.pinId);
    } else {
      seen.set(registration.improvementId, registration);
    }
  }
  return superseded;
}

/** 抽验效力（§1.5）：任一「无效」→ 永久无效（不得复活）；有「通过」且无「无效」→ 通过。 */
export function applyReviews(registrations: RsiLadderRegistration[], reviews: RsiLadderReview[]): void {
  const byId = new Map<string, RsiLadderReview[]>();
  for (const review of reviews) {
    if (!review.improvementId || !review.verdict) continue;
    const list = byId.get(review.improvementId) ?? [];
    list.push(review);
    byId.set(review.improvementId, list);
  }
  for (const registration of registrations) {
    const list = byId.get(registration.improvementId);
    if (!list) continue;
    if (list.some((review) => review.verdict === '无效')) {
      registration.reviewState = 'invalid';
    } else if (list.some((review) => review.verdict === '通过')) {
      registration.reviewState = 'passed';
    }
  }
}

/**
 * 全量快照计算（§2.1 窗口与计数 + §2.2 五层谓词 + §2.4 可见项）。
 *
 * W0 = [now-7d, now]，W1/W2/W3 依次向前的不重叠 7 天窗。
 * 有效登记 = 字段契约通过 ∧ 未被重复登记压制 ∧ 抽验通过。
 */
export function computeSnapshot(input: {
  nowMs: number;
  records: RsiLadderChainRecord[];
}): RsiLadderSnapshot {
  const { nowMs } = input;
  const { registrations, reviews } = buildModels(input.records);
  applyReviews(registrations, reviews);
  const superseded = markDuplicateSuperseded(registrations);

  const w0StartMs = nowMs - RSI_LADDER_WINDOW_MS;
  const w1StartMs = w0StartMs - RSI_LADDER_WINDOW_MS;
  const w2StartMs = w1StartMs - RSI_LADDER_WINDOW_MS;
  const w3StartMs = w2StartMs - RSI_LADDER_WINDOW_MS;

  const inWindow = (registration: RsiLadderRegistration, startMs: number, endMs: number): boolean =>
    registration.timeMs !== null && registration.timeMs >= startMs && registration.timeMs < endMs;

  const entries: RsiLadderEntry[] = registrations.map((registration) => {
    let counted = false;
    let exclusionReason: string | null = null;
    if (!registration.fieldValid) {
      exclusionReason = registration.fieldErrors.join('；');
    } else if (superseded.has(registration.pinId)) {
      exclusionReason = '同一 improvement_id 的重复登记，后者无效（§1.5 复算步骤4）';
    } else if (registration.reviewState === 'invalid') {
      exclusionReason = '抽验判无效（§1.5，不得复活）';
    } else if (registration.reviewState === 'unverified') {
      exclusionReason = '待验：抽验通过前不计入 c(W)（§1.5 效力）';
    } else if (registration.timeMs === null || registration.timeMs > nowMs) {
      exclusionReason = '落地时刻无法解析或晚于计算时刻';
    } else if (!inWindow(registration, w0StartMs, nowMs)) {
      exclusionReason = '落地时刻不在当前判据窗口 W0 内';
    } else {
      counted = true;
    }
    return { registration, counted, exclusionReason };
  });

  const validInW = (startMs: number, endMs: number) =>
    registrations.filter(
      (registration) =>
        registration.fieldValid &&
        !superseded.has(registration.pinId) &&
        registration.reviewState === 'passed' &&
        inWindow(registration, startMs, endMs),
    );

  const w0Valid = validInW(w0StartMs, nowMs);
  const cOwner = w0Valid.filter((registration) => registration.initiator === 'owner').length;
  const p = registrations.filter(
    (registration) =>
      registration.fieldValid &&
      !superseded.has(registration.pinId) &&
      registration.reviewState === 'unverified' &&
      registration.initiator === 'bot' &&
      inWindow(registration, w0StartMs, nowMs),
  ).length;
  const invalid = registrations.filter(
    (registration) =>
      (registration.reviewState === 'invalid' || superseded.has(registration.pinId)) &&
      inWindow(registration, w0StartMs, nowMs),
  ).length;

  const metaValidIn = (startMs: number, endMs: number) =>
    validInW(startMs, endMs).filter((registration) => registration.isMeta);
  const metaW0 = metaValidIn(w0StartMs, nowMs).length;
  const metaW1 = metaValidIn(w1StartMs, w0StartMs).length;

  const cWin = (index: number): number => {
    const endMs = nowMs - index * RSI_LADDER_WINDOW_MS;
    const startMs = endMs - RSI_LADDER_WINDOW_MS;
    return validInW(startMs, endMs).filter((registration) => registration.initiator === 'bot').length;
  };
  const cW0 = cWin(0);
  const cW1 = cWin(1);
  const cW2 = cWin(2);
  const cW3 = cWin(3);
  const metaInSpan = (startMs: number, endMs: number): boolean => metaValidIn(startMs, endMs).length > 0;

  // §2.2 五层谓词（判据冻结）。L0 恒真兜底；徽章=谓词成立的最高层。
  const l3Predicate = cW0 >= RSI_LADDER_J_THRESHOLD && cW1 >= RSI_LADDER_J_THRESHOLD && metaInSpan(w1StartMs, nowMs);
  const w0W3Valid = validInW(w3StartMs, nowMs);
  const w0W3Invalid = registrations.filter(
    (registration) =>
      (registration.reviewState === 'invalid' || superseded.has(registration.pinId)) &&
      registration.timeMs !== null &&
      registration.timeMs >= w3StartMs &&
      registration.timeMs < nowMs,
  ).length;
  const windowsWithMeta = [0, 1, 2, 3].filter((index) => {
    const endMs = nowMs - index * RSI_LADDER_WINDOW_MS;
    return metaInSpan(endMs - RSI_LADDER_WINDOW_MS, endMs);
  }).length;
  const l4Predicate =
    l3Predicate &&
    cW0 >= RSI_LADDER_J_THRESHOLD &&
    cW1 >= RSI_LADDER_J_THRESHOLD &&
    cW2 >= RSI_LADDER_J_THRESHOLD &&
    cW3 >= RSI_LADDER_J_THRESHOLD &&
    windowsWithMeta >= 2 &&
    w0W3Invalid === 0;

  const layerDefs: Array<{ level: RsiLadderLevel; met: boolean; evidenceUris: string[] }> = [
    {
      level: 4,
      met: l4Predicate,
      evidenceUris: l4Predicate ? collectLayerEvidence(w0W3Valid) : [],
    },
    {
      level: 3,
      met: l3Predicate,
      evidenceUris: l3Predicate
        ? collectLayerEvidence([...validInW(w0StartMs, nowMs), ...validInW(w1StartMs, w0StartMs)].filter((r) => r.isMeta || r.initiator === 'bot'))
        : [],
    },
    {
      level: 2,
      met: cW0 >= RSI_LADDER_J_THRESHOLD,
      evidenceUris: cW0 >= RSI_LADDER_J_THRESHOLD ? collectLayerEvidence(w0Valid.filter((r) => r.initiator === 'bot')) : [],
    },
    {
      level: 1,
      met: cW0 >= 1 && cW0 <= 2,
      evidenceUris: cW0 >= 1 ? collectLayerEvidence(w0Valid.filter((r) => r.initiator === 'bot')) : [],
    },
    { level: 0, met: true, evidenceUris: [] },
  ];
  const layers: RsiLadderLayer[] = layerDefs;
  const badgeLevel = layerDefs.find((layer) => layer.met)?.level ?? 0;

  return {
    computedAtMs: nowMs,
    fromChain: true,
    chainError: null,
    windows: { w0StartMs, w1StartMs, w3StartMs, windowMs: RSI_LADDER_WINDOW_MS },
    counts: { c: cW0, p, cOwner, invalid },
    judgment: {
      met: cW0 >= RSI_LADDER_J_THRESHOLD,
      current: cW0,
      needed: RSI_LADDER_J_THRESHOLD,
    },
    badge: { level: badgeLevel },
    metaCount: { w0: metaW0, w1: metaW1 },
    layers,
    entries,
  };
}

/** 层证据直链：登记 refs 中的链上 URI（pin:// 等），去重保序。 */
function collectLayerEvidence(registrations: RsiLadderRegistration[]): string[] {
  const uris: string[] = [];
  for (const registration of registrations) {
    for (const ref of registration.refs) {
      if (/^(pin|metafile|metaapp):\/\//.test(ref) && !uris.includes(ref)) uris.push(ref);
    }
  }
  return uris;
}
