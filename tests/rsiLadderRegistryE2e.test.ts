/**
 * CLI 子进程端到端回归（loop 收口验收标准②的完整形态）。
 *
 * 断言三条（chair 批准的终版 pass 清单②）：
 *   1. 合法 receipt 参数 → 真追加索引行 + exit 0 + 无 dedup 输出；
 *   2. dedup 命中（索引已有同 improvement_id）→ exit 2；
 *   3. 非法参数 → exit 1。
 * 另锁重复回执 exit 2（幂等第一层实测）与 fail-closed usage exit 1。
 *
 * 说明：receipt/dedup 的链上查重按契约以链上为准（§1.4），本测试需要可达的
 * manapi；所有写入通过 --data-dir 指向 mkdtemp 临时目录，真实 userData 零污染。
 *
 * 复跑：npx tsx --test tests/rsiLadderRegistryE2e.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const scriptPath = path.join(repoRoot, 'scripts', 'rsi-ladder-registry.ts');
const VALID_PIN = `${'ab'.repeat(32)}i0`;
const VALID_ID = 'cd'.repeat(32);

function run(args: string[], dataDir: string): spawnSync.SpawnSyncReturns<string> {
  return spawnSync(tsxBin, [scriptPath, ...args, '--data-dir', dataDir], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
  });
}

test('e2e ①：合法 receipt → exit 0 + 索引行真实追加（snake_case 四要素）+ 无 dedup 输出', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-e2e-receipt-'));
  const result = run(
    ['receipt', '--registered-pin', VALID_PIN, '--improvement-id', VALID_ID, '--initiator', 'bot', '--time', '2026-09-18T03:30:00+08:00', '--reason', 'e2e 回归测试数据'],
    dataDir,
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.ok(result.stdout.includes('回执已追加'), '必须有回执成功输出');
  assert.ok(!result.stdout.includes('dedup'), 'receipt 调用不得出现 dedup 分支输出（P1 回归）');
  const indexPath = path.join(dataDir, 'rsi-ladder', 'rsi-ladder-registrations.jsonl');
  const rawLine = JSON.parse(fs.readFileSync(indexPath, 'utf8').trim()) as Record<string, unknown>;
  assert.equal(rawLine.registered_pin, VALID_PIN);
  assert.equal(rawLine.improvement_id, VALID_ID);
  assert.equal(rawLine.initiator, 'bot');
  assert.ok(typeof rawLine.time === 'string' && Number.isFinite(Date.parse(String(rawLine.time))));
  assert.ok(!('registeredPin' in rawLine), '不得出现 camelCase 键');
});

test('e2e ②：dedup 命中（索引已含同 improvement_id）→ exit 2', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-e2e-dedup-'));
  const first = run(
    ['receipt', '--registered-pin', VALID_PIN, '--improvement-id', VALID_ID, '--initiator', 'bot', '--time', '2026-09-18T03:30:00+08:00'],
    dataDir,
  );
  assert.equal(first.status, 0, `前置回执失败 stderr: ${first.stderr}`);
  const dedup = run(['dedup', '--improvement-id', VALID_ID], dataDir);
  assert.equal(dedup.status, 2, `stdout: ${dedup.stdout} stderr: ${dedup.stderr}`);
  assert.ok(dedup.stdout.includes('已存在登记') || dedup.stdout.includes('命中'), '命中输出应明示');
});

test('e2e ③：重复回执 → exit 2 幂等拒绝；非法参数 → exit 1', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-e2e-repeat-'));
  const first = run(
    ['receipt', '--registered-pin', VALID_PIN, '--improvement-id', VALID_ID, '--initiator', 'bot', '--time', '2026-09-18T03:30:00+08:00'],
    dataDir,
  );
  assert.equal(first.status, 0, `前置回执失败 stderr: ${first.stderr}`);
  const repeat = run(
    ['receipt', '--registered-pin', `${'ef'.repeat(32)}i0`, '--improvement-id', VALID_ID, '--initiator', 'bot', '--time', '2026-09-18T03:31:00+08:00'],
    dataDir,
  );
  assert.equal(repeat.status, 2, '重复 improvement_id 必须幂等拒绝');
  const invalid = run(
    ['receipt', '--registered-pin', 'shortsha', '--improvement-id', VALID_ID, '--initiator', 'bot', '--time', '2026-09-18T03:32:00+08:00'],
    dataDir,
  );
  assert.equal(invalid.status, 1);
  assert.ok(invalid.stderr.includes('不合法'), '非法参数必须显式报错');
});
