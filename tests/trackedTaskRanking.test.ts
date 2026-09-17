/**
 * 清单视图排序/筛选的纯函数单测。
 *
 * 被测对象：src/renderer/components/trackedTasks/trackedTaskRanking.ts
 *   —— 逐档复现主进程 `listCards()` 的排序键（actionRank ↑ → activityAtMs ↑ → id ↑）。
 *   本测试同时锁住两条边界：
 *     ① 前端不得用 card.state 重推排序（否则等于第二套口径）；
 *     ② 顺序必须是**输入的确定性函数**——同批卡打乱输入，输出逐行相同（分页稳定的前提）。
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
    closureDueLevel: null,
    closureSuggestion: '',
    closureConclusion: null,
    activityAtMs: null,
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
    reasonOverflow: 0,
    ...overrides,
  };
}

const MS = (n: number) => new Date(2026, 8, 1, 0, 0, 0).getTime() + n;

test('第一档：actionRank 升序', () => {
  const ranked = orderCardsForBoardList([
    card({ id: 'r3', actionRank: 3 }),
    card({ id: 'r0', actionRank: 0 }),
    card({ id: 'r1', actionRank: 1 }),
  ]);
  assert.deepEqual(ranked.map((c) => c.id), ['r0', 'r1', 'r3']);
});

test('第二档：同权重按 activityAtMs 升序，null 排最后', () => {
  const ranked = orderCardsForBoardList([
    card({ id: 'no-activity', actionRank: 2, activityAtMs: null }),
    card({ id: 'late', actionRank: 2, activityAtMs: MS(2000) }),
    card({ id: 'early', actionRank: 2, activityAtMs: MS(1000) }),
  ]);
  assert.deepEqual(ranked.map((c) => c.id), ['early', 'late', 'no-activity']);
});

test('第三档：名次与活动时间全等时按 id 升序（分页稳定）', () => {
  const ranked = orderCardsForBoardList([
    card({ id: 'b', actionRank: 2, activityAtMs: MS(1000) }),
    card({ id: 'a', actionRank: 2, activityAtMs: MS(1000) }),
    card({ id: 'c', actionRank: 2, activityAtMs: MS(1000) }),
  ]);
  assert.deepEqual(ranked.map((c) => c.id), ['a', 'b', 'c']);
});

test('输出是输入的确定性函数：打乱输入后逐行相同', () => {
  const base = [
    card({ id: 'x1', actionRank: 0, activityAtMs: MS(500) }),
    card({ id: 'x2', actionRank: 0, activityAtMs: MS(500) }),
    card({ id: 'x3', actionRank: 1, activityAtMs: MS(100) }),
    card({ id: 'x4', actionRank: 4 }),
    card({ id: 'x5', actionRank: 2, activityAtMs: null }),
  ];
  const shuffled = [base[4], base[2], base[0], base[3], base[1]];
  assert.deepEqual(
    orderCardsForBoardList(base).map((c) => c.id),
    orderCardsForBoardList(shuffled).map((c) => c.id)
  );
  assert.deepEqual(
    orderCardsForBoardList(shuffled).map((c) => c.id),
    ['x1', 'x2', 'x3', 'x5', 'x4']
  );
});

test('排序不改入参，返回新数组', () => {
  const input = [card({ id: 'b', actionRank: 2 }), card({ id: 'a', actionRank: 0 })];
  const snapshot = input.map((c) => c.id);
  const ranked = orderCardsForBoardList(input);
  assert.deepEqual(input.map((c) => c.id), snapshot);
  assert.notEqual(ranked, input);
  assert.deepEqual(ranked.map((c) => c.id), ['a', 'b']);
});

test('「需要我出手」用后端标志，不按 state 重推', () => {
  const cards = [
    card({ id: 'due-running', actionRank: 1, state: 'in_progress', closureDue: true, needsOwnerAction: true }),
    card({ id: 'decide-but-flag-off', actionRank: 4, state: 'waiting_decision', needsOwnerAction: false }),
    card({ id: 'closed', actionRank: 4, state: 'closed', needsOwnerAction: false }),
  ];
  assert.deepEqual(filterNeedsOwnerAction(cards).map((c) => c.id), ['due-running']);
});
