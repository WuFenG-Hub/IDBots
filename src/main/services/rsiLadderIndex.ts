/**
 * RSI 爬梯卡 — 登记索引（§1.4 步骤3 的本机落点，随卡归档）。
 *
 * 落地方手动执行登记三步（查重→写入→回执）中的「回执」追加进本文件；
 * 「查重」由 CLI 对链上登记链 + 本索引双源比对。本文件只是缓存与巡检入口：
 * 与链上冲突时以链上为准（§2.5），视图永不从索引发明链上没有的登记效力。
 *
 * 格式：JSONL，每行一条回执 {registeredPin, improvementId, initiator, initiatorId, time, reasonSummary, recordedAtMs}。
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

/** 索引默认落点：<userData>/rsi-ladder/registration-index.jsonl。 */
export function registrationIndexPathFor(userDataPath: string): string {
  return path.join(userDataPath, 'rsi-ladder', 'registration-index.jsonl');
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
      const value = JSON.parse(trimmed) as Partial<RsiLadderReceipt>;
      if (
        typeof value.registeredPin === 'string' &&
        PINID_RE.test(value.registeredPin) &&
        typeof value.improvementId === 'string' &&
        IMPROVEMENT_ID_RE.test(value.improvementId) &&
        (value.initiator === 'owner' || value.initiator === 'bot') &&
        typeof value.time === 'string' &&
        Number.isFinite(Date.parse(value.time))
      ) {
        receipts.push({
          registeredPin: value.registeredPin,
          improvementId: value.improvementId,
          initiator: value.initiator,
          initiatorId: typeof value.initiatorId === 'string' ? value.initiatorId : '',
          time: value.time,
          reasonSummary: typeof value.reasonSummary === 'string' ? value.reasonSummary : undefined,
          recordedAtMs:
            typeof value.recordedAtMs === 'number' && Number.isFinite(value.recordedAtMs)
              ? value.recordedAtMs
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
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(receipt)}\n`, 'utf8');
  return { ok: true, receipt };
}
