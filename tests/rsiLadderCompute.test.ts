/**
 * RSI 爬梯卡纯计算层单测（判据冻结稿 §1.5/§2.1/§2.2/§2.3）。
 *
 * 被测对象：src/main/services/rsiLadderCompute.ts（纯函数，nowMs 注入）。
 * 设计纪律：每个「不成立/被剔除」的阴性断言都配有对应的阳性对照——
 * 同一构造器换个参数就能让判据翻真，证明判据本身能看见阳性。
 *
 * 复跑：npx tsx --test tests/rsiLadderCompute.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyReviews,
  buildModels,
  computeSnapshot,
  markDuplicateSuperseded,
} from '../src/main/services/rsiLadderCompute';
import type { RsiLadderChainRecord } from '../src/renderer/types/rsiLadder';

const NOW = Date.UTC(2026, 8, 18, 0, 0, 0); // 2026-09-18T00:00Z
const DAY = 24 * 60 * 60 * 1000;

let seq = 0;
const nextPin = (): string => `${String(seq++).padStart(4, '0')}000000000000000000000000000000000000000000000000000000000000i0`.slice(-66);

/** 构造一条 taskkey=local:88 的链上登记记录（默认字段全合规）。 */
function registrationRecord(overrides?: {
  improvementId?: string;
  initiator?: 'owner' | 'bot';
  time?: string;
  timeMs?: number;
  reasonSummary?: string;
  isMeta?: boolean;
  omit?: string[];
  payloadOverride?: Record<string, unknown>;
  pinId?: string;
  createdAtMs?: number;
}): RsiLadderChainRecord {  const timeMs = overrides?.timeMs ?? NOW - 2 * DAY;
  const time = overrides?.time ?? new Date(timeMs).toISOString().replace('Z', '+00:00');
  const improvementId = overrides?.improvementId ?? `${'ab'.repeat(32)}`;
  const reasonSummary =
    overrides?.reasonSummary ??
    (overrides?.isMeta ? '改进改进机制本身：把抽验方法的断言口径补全' : '把看板列宽恢复成画布口径统一的规格');
  const extra: Record<string, unknown> = {
    time,
    improvement_id: improvementId,
    improvement_kind: 'commit',
    initiator: overrides?.initiator ?? 'bot',
    initiator_id: overrides?.initiator === 'owner' ? 'idq1owner' : 'idq1bot',
    reason_summary: reasonSummary,
    evidence: [{ type: 'commit', uri_or_ref: `${'cd'.repeat(32)} → ${'ef'.repeat(32)}`, verify_cmd: 'git show x' }],
  };
  for (const key of overrides?.omit ?? []) delete extra[key];
  return {
    pinId: overrides?.pinId ?? nextPin(),
    createdAtMs: overrides?.createdAtMs ?? timeMs + 60_000,
    source: 'chain',
    payload:
      overrides?.payloadOverride ?? {
        kind: 'status',
        taskkey: 'local:88',
        step: 'rsi-improvement-registered',
        status: 'done',
        summary: `改进落地登记 initiator=${overrides?.initiator ?? 'bot'} improvement_id=${improvementId} 测试`,
        extra,
        refs: [`pin://${improvementId}i0`],
      },
  };
}

function reviewRecord(input: {
  improvementId: string;
  verdict: '通过' | '无效';
  timeMs?: number;
  pinId?: string;
  /** 「更正：」等前缀（更正形态回写，v1 按普通回写计量）。 */
  summaryPrefix?: string;
  /** 指向被更正 review 的 refs（缺省为无关证据 pin）。 */
  refs?: string[];
}): RsiLadderChainRecord {
  const timeMs = input.timeMs ?? NOW - DAY;
  return {
    pinId: input.pinId ?? nextPin(),
    createdAtMs: timeMs,
    source: 'chain',
    payload: {
      kind: 'review',
      taskkey: 'local:88',
      summary: `${input.summaryPrefix ?? ''}抽验 ${input.verdict} improvement_id=${input.improvementId}`,
      refs: input.refs ?? ['pin://feed000000000000000000000000000000000000000000000000000000000000i0'],
    },
  };
}

const level = (snapshot: ReturnType<typeof computeSnapshot>, level_: number) =>
  snapshot.layers.find((layer) => layer.level === level_)!;

test('分类：taskkey 不符的记录被丢弃；无关 kind 不入模', () => {
  const other = registrationRecord({ payloadOverride: { kind: 'status', taskkey: 'local:99', step: 'rsi-improvement-registered', extra: {} } });
  const noise = registrationRecord({ payloadOverride: { kind: 'buzz', taskkey: 'local:88', extra: {} } });
  const { registrations } = buildModels([other, noise, registrationRecord()]);
  assert.equal(registrations.length, 1);
});

test('§1.2 字段契约：缺字段 → 异常条目，不计数', () => {
  const bad = registrationRecord({ omit: ['evidence'] });
  const good = registrationRecord();
  const snapshot = computeSnapshot({ nowMs: NOW, records: [bad, good, reviewRecord({ improvementId: good.payload.extra.improvement_id, verdict: '通过' })] });
  const badEntry = snapshot.entries.find((entry) => entry.registration.pinId === bad.pinId)!;
  assert.equal(badEntry.counted, false);
  assert.ok(badEntry.exclusionReason!.includes('evidence'));
  assert.equal(snapshot.counts.c, 1, '阳性对照：同窗好条目照常计入，剔除只针对坏字段');
});

test('§1.5 抽验效力：待验不计入 c(W)，通过后计入；阳性对照就位', () => {
  const reg = registrationRecord();
  const id = reg.payload.extra.improvement_id as string;
  const pending = computeSnapshot({ nowMs: NOW, records: [reg] });
  assert.equal(pending.counts.c, 0);
  assert.equal(pending.counts.p, 1);
  const passed = computeSnapshot({ nowMs: NOW, records: [reg, reviewRecord({ improvementId: id, verdict: '通过' })] });
  assert.equal(passed.counts.c, 1);
  assert.equal(passed.judgment.met, false, '1 条不足以过 J=3');
});

test('§1.5 复算步骤4：同 improvement_id 重复登记，后者无效；先登记者保留计数', () => {
  const first = registrationRecord({ timeMs: NOW - 3 * DAY });
  const second = registrationRecord({ timeMs: NOW - 2 * DAY, pinId: nextPin() });
  const id = first.payload.extra.improvement_id as string;
  const snapshot = computeSnapshot({
    nowMs: NOW,
    records: [first, second, reviewRecord({ improvementId: id, verdict: '通过' })],
  });
  const secondEntry = snapshot.entries.find((entry) => entry.registration.pinId === second.pinId)!;
  assert.equal(secondEntry.counted, false);
  assert.ok(secondEntry.exclusionReason!.includes('重复登记'));
  assert.equal(snapshot.counts.c, 1);
});

test('§1.5：判无效即剔除且不复活——无效后再补「通过」仍不计入', () => {
  const reg = registrationRecord();
  const id = reg.payload.extra.improvement_id as string;
  const models = buildModels([
    reg,
    reviewRecord({ improvementId: id, verdict: '无效', timeMs: NOW - DAY }),
    reviewRecord({ improvementId: id, verdict: '通过', timeMs: NOW - 1000 }),
  ]);
  applyReviews(models.registrations, models.reviews);
  assert.equal(models.registrations[0].reviewState, 'invalid');
  const superseded = markDuplicateSuperseded(models.registrations);
  assert.equal(superseded.size, 0);
});

test('v1 验收口径（chair C 组基准）：无效后任何后续回写——含「更正：」前缀+refs 指向——不得翻转状态', () => {
  const reg = registrationRecord();
  const id = reg.payload.extra.improvement_id as string;
  const invalidReview = reviewRecord({ improvementId: id, verdict: '无效', timeMs: NOW - DAY });
  const correction = reviewRecord({
    improvementId: id,
    verdict: '通过',
    timeMs: NOW - 3600_000,
    summaryPrefix: '更正：',
    refs: [`pin://${invalidReview.pinId}`],
  });
  const models = buildModels([reg, invalidReview, correction]);
  applyReviews(models.registrations, models.reviews);
  assert.equal(models.registrations[0].reviewState, 'invalid', '冻结稿 §1.5 字面：不得复活，无例外');
  // 阳性对照：同一更正形态在没有前置无效时正常生效为通过——判据看得见「通过」。
  const solo = buildModels([
    registrationRecord(),
    reviewRecord({ improvementId: id, verdict: '通过', summaryPrefix: '更正：', refs: ['pin://feed000000000000000000000000000000000000000000000000000000000000i0'] }),
  ]);
  applyReviews(solo.registrations, solo.reviews);
  assert.equal(solo.registrations[0].reviewState, 'passed');
});

test('§2.1 窗口：W0 边界内侧计入、外侧只展示不计入', () => {
  const idInside = `${'11'.repeat(32)}`;
  const inside = registrationRecord({ improvementId: idInside, timeMs: NOW - 1 });
  const idOutside = `${'22'.repeat(32)}`;
  const outside = registrationRecord({ improvementId: idOutside, timeMs: NOW - 7 * DAY - 1000 });
  const records = [
    inside,
    outside,
    reviewRecord({ improvementId: idInside, verdict: '通过' }),
    reviewRecord({ improvementId: idOutside, verdict: '通过' }),
  ];
  const snapshot = computeSnapshot({ nowMs: NOW, records });
  assert.equal(snapshot.counts.c, 1, '窗内 1 条计入（L1 阳性对照）');
  assert.equal(level(snapshot, 1).met, true);
  assert.equal(level(snapshot, 2).met, false);
});

test('§2.2 L2：c(W0)≥3 过主判据 J；徽章=L2；层证据为三条登记的 refs 直链', () => {
  const regs = [0, 1, 2].map((i) => registrationRecord({ improvementId: `${String(i).repeat(64)}`, timeMs: NOW - DAY - i }));
  const reviews = regs.map((reg) => reviewRecord({ improvementId: reg.payload.extra.improvement_id as string, verdict: '通过' }));
  const snapshot = computeSnapshot({ nowMs: NOW, records: [...regs, ...reviews] });
  assert.equal(snapshot.counts.c, 3);
  assert.equal(snapshot.judgment.met, true);
  assert.equal(snapshot.badge.level, 2);
  assert.equal(level(snapshot, 2).evidenceUris.length, 3);
  assert.ok(level(snapshot, 2).evidenceUris.every((uri) => uri.startsWith('pin://')));
  assert.equal(level(snapshot, 3).met, false, '只有 W0 达标时 L3 不成立（W1 缺失）');
});

test('§2.2 L3：连续两窗 ≥3 且 W0∪W1 含 meta 改进；无 meta 时只到 L2（阳性对照：补 meta 即翻真）', () => {
  const build = (withMeta: boolean) => {
    const records: RsiLadderChainRecord[] = [];
    let slot = 0;
    for (let window = 0; window < 2; window += 1) {
      for (let i = 0; i < 3; i += 1) {
        const id = `${String(slot++).padStart(2, '0')}`.repeat(32);
        const reg = registrationRecord({
          improvementId: id,
          timeMs: NOW - (window * 7 + 1) * DAY,
          isMeta: withMeta && window === 1,
          reasonSummary: withMeta && window === 1 ? '改进改进机制本身：登记口径补证据断言' : undefined,
        });
        records.push(reg, reviewRecord({ improvementId: id, verdict: '通过' }));
      }
    }
    return computeSnapshot({ nowMs: NOW, records });
  };
  const noMeta = build(false);
  assert.equal(noMeta.badge.level, 2);
  const withMeta = build(true);
  assert.equal(withMeta.badge.level, 3);
  assert.equal(level(withMeta, 3).evidenceUris.length >= 1, true);
});

test('§2.2 L4：连续四窗 ≥3 + ≥2 窗含 meta + 4 窗内零无效；窗内出现无效登记即破', () => {
  const build = (injectInvalid: boolean) => {
    const records: RsiLadderChainRecord[] = [];
    let slot = 0;
    for (let window = 0; window < 4; window += 1) {
      for (let i = 0; i < 3; i += 1) {
        const id = `${String(slot++).padStart(2, '0')}`.repeat(32).slice(0, 64);
        const reg = registrationRecord({
          improvementId: id,
          timeMs: NOW - (window * 7 + 1) * DAY,
          isMeta: i === 0 && window < 2,
          reasonSummary: i === 0 && window < 2 ? '改进改进机制本身：层判据措辞对齐冻结稿' : undefined,
        });
        records.push(reg, reviewRecord({ improvementId: id, verdict: '通过' }));
      }
    }
    if (injectInvalid) {
      const badId = `${'ee'.repeat(32)}`;
      records.push(
        registrationRecord({ improvementId: badId, timeMs: NOW - 2 * DAY }),
        reviewRecord({ improvementId: badId, verdict: '无效' }),
      );
    }
    return computeSnapshot({ nowMs: NOW, records });
  };
  const clean = build(false);
  assert.equal(clean.counts.c, 3);
  assert.equal(clean.badge.level, 4, '阳性对照：四窗全绿+meta 达标 → L4');
  assert.equal(clean.metaCount.w0, 1);
  const broken = build(true);
  assert.ok(broken.badge.level < 4, '窗内无效登记 >0 → L4 不成立（阴性）');
});

test('§2.1 c_owner：owner 发起只进对照量，不进判据（保守归因防梯层虚高）', () => {
  const regs = [0, 1, 2].map((i) =>
    registrationRecord({ improvementId: `${String(i + 5).repeat(64)}`, initiator: i === 0 ? 'owner' : 'bot', timeMs: NOW - DAY - i }),
  );
  const reviews = regs.map((reg) => reviewRecord({ improvementId: reg.payload.extra.improvement_id as string, verdict: '通过' }));
  const snapshot = computeSnapshot({ nowMs: NOW, records: [...regs, ...reviews] });
  assert.equal(snapshot.counts.c, 2);
  assert.equal(snapshot.counts.cOwner, 1);
  assert.equal(snapshot.judgment.met, false);
  assert.equal(snapshot.badge.level, 1);
});

test('§2.3 meta 识别：只认明示改进机制的表述；普通改进不误报', () => {
  const meta = registrationRecord({ reasonSummary: '修订 L0–L4 层判据：把抽验样本规则写进 §1.5' });
  const plain = registrationRecord({ reasonSummary: '修复看板排序在同一时间戳下的不稳定' });
  const models = buildModels([meta, plain]);
  assert.equal(models.registrations.find((r) => r.pinId === meta.pinId)!.isMeta, true);
  assert.equal(models.registrations.find((r) => r.pinId === plain.pinId)!.isMeta, false);
});

test('空数据：徽章 L0 兜底，五层如实显示暂无（不是装饰性链接）', () => {
  const snapshot = computeSnapshot({ nowMs: NOW, records: [] });
  assert.equal(snapshot.badge.level, 0);
  assert.equal(snapshot.counts.c, 0);
  assert.ok(snapshot.layers.every((layer) => layer.evidenceUris.length === 0));
});
