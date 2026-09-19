/**
 * RSI 爬梯卡挂载边界的静态断言（需求稿 §2.5 挂载位置 / §4 与 MetaTask 互不隶属）。
 *
 * 纪律：阴性断言（「不存在某引用」）必须附阳性对照——同一断言机制在已知
 * 存在的字符串上必须命中，否则「找不到」只是尺子失明。
 * 复跑：npx tsx --test tests/rsiLadderMountStatic.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

test('ScheduledTasksView 挂载 RsiLadderCard 于顶层（import + JSX 渲染）', () => {
  const source = read('src/renderer/components/scheduledTasks/ScheduledTasksView.tsx');
  assert.ok(source.includes("import RsiLadderCard from './RsiLadderCard'"), '缺少 import');
  assert.ok(source.includes('<RsiLadderCard />'), '缺少 JSX 挂载');
  // 挂载点在 L1 tabs 注释之前（页头之下、双 Tab 之上 = 顶层星标）。
  const mountAt = source.indexOf('<RsiLadderCard />');
  const tabsAt = source.indexOf('{/* L1 tabs');
  assert.ok(mountAt >= 0 && tabsAt >= 0 && mountAt < tabsAt, '星标卡必须位于 L1 tabs 之前');
});

test('长期任务看板五列表组件不承载爬梯卡（§2.5 不占五列表 / §4 互不隶属）', () => {
  const source = read('src/renderer/components/trackedTasks/TrackedTasksSection.tsx');
  // 阳性对照：同一读法在已知存在的内容上必须命中。
  assert.ok(source.includes('长期任务'), '阳性对照失败：读法失明');
  assert.ok(!source.includes('RsiLadder'), '五列表组件不得引用爬梯卡');
  assert.ok(!source.includes('rsiLadder'), '五列表组件不得引用爬梯卡通道');
});

test('爬梯卡实现文件不触碰 MetaTask 卡数据（§4.2 不读不写）', () => {
  const files = [
    'src/renderer/components/scheduledTasks/RsiLadderCard.tsx',
    'src/main/services/rsiLadderCard.ts',
    'src/main/services/rsiLadderCompute.ts',
    'src/main/services/rsiLadderIndex.ts',
  ];
  for (const rel of files) {
    const source = read(rel);
    // 阳性对照：本文件确实在检查这些实现文件（读法可达）。
    assert.ok(source.length > 0, `读不到 ${rel}`);
    // §4 红线是数据耦合：禁的是 MetaTask 的桥/通道/组件引用，不是文档注释里的概念提及。
    assert.ok(!/electron\.metaTask|'metaTask:|from '.*[Mm]eta[Tt]ask|import.*[Mm]eta[Tt]ask/.test(source), `${rel} 出现 MetaTask 数据耦合（§4 红线）`);
  }
});

test('实现面无自动登记/自动抽验组件（§5.3）：主服务与计算层无链上写入通道', () => {
  for (const rel of ['src/main/services/rsiLadderCard.ts', 'src/main/services/rsiLadderCompute.ts']) {
    const source = read(rel);
    // 阳性对照：写入语义在 simplelog 工具文件里真实存在。
    assert.ok(read('src/main/libs/postSimpleLogAgentTools.ts').includes('SimpleLog record cast on-chain.'), '阳性对照失败：读法失明');
    assert.ok(!/omni_cast|postSimpleLog\(|broadcastTrackedTaskUpdate/.test(source), `${rel} 不得包含任何链上写入通道`);
  }
});
