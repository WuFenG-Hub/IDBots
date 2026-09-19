/**
 * RSI 爬梯卡 — 登记索引（§1.4 步骤3 的本机落点，随卡归档）。
 *
 * 落地方手动执行登记三步（查重→写入→回执）中的「回执」追加进本文件；
 * 「查重」由 CLI 对链上登记链 + 本索引双源比对。本文件只是缓存与巡检入口：
 * 与链上冲突时以链上为准（§2.5），视图永不从索引发明链上没有的登记效力。
 *
 * 格式：JSONL，每行一条回执，落盘键为冻结四要素 snake_case 原文
 * {registered_pin, improvement_id, initiator, time}，另有增强字段
 * {initiator_id, reason_summary, recorded_at_ms}（内存形状见 RsiLadderReceipt）。
 */
import * as fs from 'fs';
import * as path from 'path';

export interface RsiLadderReceipt {
  registeredPin: string;
  improvementId: string;
  initiator: 'owner' | 'bot';
  initiatorId: string;
  time: string;
  reasonSummary?: string;
  recordedAtMs: number;
}

export interface RsiLadderReadResult {
  receipts: RsiLadderReceipt[];
  malformedLines: number;
}

const PINID_RE = /^[0-9a-f]{64}i0$/;
const IMPROVEMENT_ID_RE = /^(?:[0-9a-f]{64}|[0-9a-f]{64}i0)$/;

/**
 * 索引默认落点：<userData>/rsi-ladder/rsi-ladder-registrations.jsonl。
 * 文件名自含 rsi-ladder 字样（chair Q1 裁定的可发现性约定）。
 * 行格式为冻结四要素的 snake_case 原文 {registered_pin, improvement_id, initiator, time}
 * （chair Q1「与 §1.4 步骤3 四要素一字不差」），另有三个增强字段：
 * initiator_id / reason_summary / recorded_at_ms。纯回执流水：append-only、
 * 行写定后不改、不带任何有效性字段——有效性只活在链上抽验回写里（§2.5）。
 */
export function registrationIndexPathFor(userDataPath: string): string {
  return path.join(userDataPath, 'rsi-ladder', 'rsi-ladder-registrations.jsonl');
}

/** 回执行在文件里的落盘形状（snake_case 原文键，与裁定口径一字不差）。 */
interface ReceiptLine {
  registered_pin: string;
  improvement_id: string;
  initiator: 'owner' | 'bot';
  initiator_id?: string;
  time: string;
  reason_summary?: string;
  recorded_at_ms: number;
}

export function readReceipts(filePath: string): RsiLadderReadResult {
  const receipts: RsiLadderReceipt[] = [];
  let malformedLines = 0;
  let text = '';
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { receipts, malformedLines };
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed) as Partial<ReceiptLine>;
      if (
        typeof value.registered_pin === 'string' &&
        PINID_RE.test(value.registered_pin) &&
        typeof value.improvement_id === 'string' &&
        IMPROVEMENT_ID_RE.test(value.improvement_id) &&
        (value.initiator === 'owner' || value.initiator === 'bot') &&
        typeof value.time === 'string' &&
        Number.isFinite(Date.parse(value.time))
      ) {
        receipts.push({
          registeredPin: value.registered_pin,
          improvementId: value.improvement_id,
          initiator: value.initiator,
          initiatorId: typeof value.initiator_id === 'string' ? value.initiator_id : '',
          time: value.time,
          reasonSummary: typeof value.reason_summary === 'string' ? value.reason_summary : undefined,
          recordedAtMs:
            typeof value.recorded_at_ms === 'number' && Number.isFinite(value.recorded_at_ms)
              ? value.recorded_at_ms
              : 0,
        });
      } else {
        malformedLines += 1;
      }
    } catch {
      malformedLines += 1;
    }
  }
  return { receipts, malformedLines };
}

export function hasImprovementId(filePath: string, improvementId: string): boolean {
  return readReceipts(filePath).receipts.some((receipt) => receipt.improvementId === improvementId);
}

export type AppendOutcome =
  | { ok: true; receipt: RsiLadderReceipt }
  | { ok: false; reason: 'duplicate' | 'invalid-field'; detail: string };

/**
 * 幂等回执：追加前按 improvement_id 查本索引，命中即拒绝（重复触发只落一条）。
 * 与链上查重（CLI dedup 的链上分支）共同构成「先查后写」双层幂等的第一层。
 */
export function appendReceipt(filePath: string, input: Omit<RsiLadderReceipt, 'recordedAtMs'>): AppendOutcome {
  if (!PINID_RE.test(input.registeredPin)) {
    return { ok: false, reason: 'invalid-field', detail: 'registeredPin 不是 64hex+i0' };
  }
  if (!IMPROVEMENT_ID_RE.test(input.improvementId)) {
    return { ok: false, reason: 'invalid-field', detail: 'improvementId 不是全量 64hex/64hex+i0' };
  }
  if (input.initiator !== 'owner' && input.initiator !== 'bot') {
    return { ok: false, reason: 'invalid-field', detail: 'initiator 不是 owner|bot' };
  }
  if (hasImprovementId(filePath, input.improvementId)) {
    return { ok: false, reason: 'duplicate', detail: `improvement_id 已登记过：${input.improvementId}` };
  }
  const receipt: RsiLadderReceipt = { ...input, recordedAtMs: Date.now() };
  const line: ReceiptLine = {
    registered_pin: receipt.registeredPin,
    improvement_id: receipt.improvementId,
    initiator: receipt.initiator,
    initiator_id: receipt.initiatorId,
    time: receipt.time,
    reason_summary: receipt.reasonSummary,
    recorded_at_ms: receipt.recordedAtMs,
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(line)}\n`, 'utf8');
  return { ok: true, receipt };
}
