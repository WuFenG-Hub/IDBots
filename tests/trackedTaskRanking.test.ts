/**
 * 清单视图排序/筛选的纯函数单测。
 *
 * 被测对象：src/renderer/components/trackedTasks/trackedTaskRanking.ts
 *   —— 只消费后端投影给出的 `actionRank` / `updatedAt` / `needsOwnerAction`。
 *   本测试同时锁住一条边界：**前端不得用 card.state 重推排序**（否则等于第二套口径）。
 *
 * 复跑：npx tsx --test tests/trackedTaskRanking.test.ts
 *
 * 注意：本文件是实现方的自测，不构成独立验收证据（独立验收由验收方另出脚本）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  orderCardsForBoardList,
  filterNeedsOwnerAction,
} from '../src/renderer/components/trackedTasks/trackedTaskRanking';
import type { TrackedCardSummary, TrackedCardState } from '../src/renderer/types/trackedTask';

function card(
  overrides: Partial<TrackedCardSummary> & { id: string; actionRank: number }
): TrackedCardSummary {
  return {
    title: overrides.id,
    goal: overrides.id,
    state: 'in_progress' as TrackedCardState,
    stateLabelKey: 'trackedTask.column.inProgress',
    ledgerStatus: 'running',
    closureWarn: false,
    closureDue: false,
    closureSuggestion: '',
    closureConclusion: null,
    lastActivityAtMs: null,
    idleMs: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    sourceSessionId: null,
    sourceKind: 'session',
    groupTaskId: null,
    scheduledTaskId: null,
    needsOwnerAction: false,
    reasons: [],
    ...overrides,
  };
}

test('清单顺序复现台账投影：actionRank 升序，同档 updatedAt 降序', () => {
  const ranked = orderCardsForBoardList([
    card({ id: 'rank3-old', actionRank: 3, updatedAt: '2026-09-10T00:00:00.000Z' }),
    card({ id: 'rank0', actionRank: 0 }),
    card({ id: 'rank3-new', actionRank: 3, updatedAt: '2026-09-16T00:00:00.000Z' }),
    card({ id: 'rank1', actionRank: 1 }),
  ]);
  assert.deepEqual(
    ranked.map((c) => c.id),
    ['rank0', 'rank1', 'rank3-new', 'rank3-old']
  );
});

test('排序不改入参，返回新数组', () => {
  const input = [
    card({ id: 'b', actionRank: 2 }),
    card({ id: 'a', actionRank: 0 }),
  ];
  const snapshot = input.map((c) => c.id);
  const ranked = orderCardsForBoardList(input);
  assert.deepEqual(input.map((c) => c.id), snapshot);
  assert.notEqual(ranked, input);
  assert.deepEqual(ranked.map((c) => c.id), ['a', 'b']);
});

test('「需要我出手」用后端标志，不按 state 重推', () => {
  const cards = [
    // 后端说 needsOwnerAction=true（例如 closureDue 的进行中卡）
    card({ id: 'due-running', actionRank: 1, state: 'in_progress', closureDue: true, needsOwnerAction: true }),
    // 后端说 false：即使 state=waiting_decision 也不由前端翻案
    card({ id: 'decide-but-flag-off', actionRank: 4, state: 'waiting_decision', needsOwnerAction: false }),
    card({ id: 'closed', actionRank: 4, state: 'closed', needsOwnerAction: false }),
  ];
  assert.deepEqual(
    filterNeedsOwnerAction(cards).map((c) => c.id),
    ['due-running']
  );
});
