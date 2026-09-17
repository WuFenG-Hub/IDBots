/**
 * CLI 子命令分发回归测试（P1 修复锁）。
 *
 * 历史 bug（小明同学实测 5 次复现）：分发条件 `command === 'dedup' || args['improvement-id']`
 * 非互斥——receipt 按契约必须携带 --improvement-id，于是每次 receipt 调用都被
 * dedup 分支拦截、静默按 dedup 执行并 exit 0，落地方误以为回执成功而索引从未
 * 落行。修复后分发互斥且 fail-closed：无/未知子命令一律 usage exit 1。
 *
 * 复跑：npx tsx --test tests/rsiLadderRegistryCli.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveCommand } from '../scripts/rsi-ladder-registry';

test('P1 回归锁：receipt 全参数调用（必带 --improvement-id）解析为 receipt，不再被 dedup 吞掉', () => {
  const argv = [
    'receipt',
    '--registered-pin', `${'ab'.repeat(32)}i0`,
    '--improvement-id', 'cd'.repeat(32),
    '--initiator', 'bot',
    '--time', '2026-09-18T01:50:55+08:00',
  ];
  assert.equal(resolveCommand(argv), 'receipt');
});

test('dedup 调用解析为 dedup（阳性对照：判据看得见 dedup）', () => {
  assert.equal(resolveCommand(['dedup', '--improvement-id', 'cd'.repeat(32)]), 'dedup');
});

test('fail-closed：无/未知/仅旗标调用一律 null（usage exit 1，绝不静默串命令）', () => {
  assert.equal(resolveCommand(['--improvement-id', 'cd'.repeat(32)]), null);
  assert.equal(resolveCommand([]), null);
  assert.equal(resolveCommand(['deploy', '--x', 'y']), null);
});
