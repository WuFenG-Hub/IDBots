/**
 * 登记索引（§1.4 步骤3 落点）单测：追加 / 查重 / 幂等拒绝。
 * 复跑：npx tsx --test tests/rsiLadderIndex.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  appendReceipt,
  hasImprovementId,
  readReceipts,
  registrationIndexPathFor,
} from '../src/main/services/rsiLadderIndex';

const COMMIT_ID = 'ab'.repeat(32);

function tempIndexFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-ladder-index-'));
  return path.join(dir, 'registration-index.jsonl');
}

test('registrationIndexPathFor：userData 下 rsi-ladder/rsi-ladder-registrations.jsonl（文件名自含 rsi-ladder 字样）', () => {
  assert.equal(registrationIndexPathFor('/ud'), path.join('/ud', 'rsi-ladder', 'rsi-ladder-registrations.jsonl'));
});

test('追加 → 读回一致；再追加同 improvement_id 被幂等拒绝（重复触发只落一条）', () => {
  const file = tempIndexFile();
  const ok = appendReceipt(file, {
    registeredPin: `${'cd'.repeat(32)}i0`,
    improvementId: COMMIT_ID,
    initiator: 'bot',
    initiatorId: 'idq1bot',
    time: '2026-09-18T01:50:55+08:00',
    reasonSummary: '测试回执',
  });
  assert.equal(ok.ok, true);
  // 阳性对照：四要素 snake_case 原文键确实落在文件里（chair Q1「一字不差」）。
  const rawLine = JSON.parse(fs.readFileSync(file, 'utf8').trim()) as Record<string, unknown>;
  assert.ok('registered_pin' in rawLine && 'improvement_id' in rawLine && 'initiator' in rawLine && 'time' in rawLine);
  assert.ok(!('registeredPin' in rawLine), '不得出现 camelCase 键（与裁定口径分叉）');
  const dup = appendReceipt(file, {
    registeredPin: `${'ef'.repeat(32)}i0`,
    improvementId: COMMIT_ID,
    initiator: 'bot',
    initiatorId: 'idq1bot',
    time: '2026-09-18T01:55:00+08:00',
  });
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.equal(dup.reason, 'duplicate');
  const { receipts, malformedLines } = readReceipts(file);
  assert.equal(receipts.length, 1);
  assert.equal(malformedLines, 0);
  assert.equal(hasImprovementId(file, COMMIT_ID), true);
});

test('字段非法拒绝：pin 形状 / improvement_id 粒度 / initiator 闭集', () => {
  const file = tempIndexFile();
  const base = {
    registeredPin: `${'cd'.repeat(32)}i0`,
    improvementId: COMMIT_ID,
    initiator: 'bot' as const,
    initiatorId: 'idq1bot',
    time: '2026-09-18T01:50:55+08:00',
  };
  assert.equal(appendReceipt(file, { ...base, registeredPin: 'shortsha' }).ok, false);
  assert.equal(appendReceipt(file, { ...base, improvementId: 'ab'.repeat(8) }).ok, false);
  assert.equal(appendReceipt(file, { ...base, initiator: 'twin' as never }).ok, false);
  assert.equal(readReceipts(file).receipts.length, 0);
});

test('坏行跳过且计数，不影响好行读回', () => {
  const file = tempIndexFile();
  appendReceipt(file, {
    registeredPin: `${'cd'.repeat(32)}i0`,
    improvementId: COMMIT_ID,
    initiator: 'bot',
    initiatorId: 'idq1bot',
    time: '2026-09-18T01:50:55+08:00',
  });
  fs.appendFileSync(file, 'not-json\n', 'utf8');
  const { receipts, malformedLines } = readReceipts(file);
  assert.equal(receipts.length, 1);
  assert.equal(malformedLines, 1);
});

test('空文件/缺文件返回空，不抛错', () => {
  assert.deepEqual(readReceipts(tempIndexFile()), { receipts: [], malformedLines: 0 });
  assert.equal(hasImprovementId(tempIndexFile(), COMMIT_ID), false);
});
