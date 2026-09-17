// 清单视图的排序/筛选 —— **只消费后端投影给的两个字段**。
//
// 权威来源：src/main/services/trackedTaskBoard.ts
//   `listCards()` 已按 `actionRank ASC, updatedAt DESC` 排序，并给出逐卡的
//   `needsOwnerAction` / `actionRank`；
//   `needsOwnerAction = state === 'waiting_decision' || closureDue`。
//
// 因此本文件**不是第二套排序口径**：它只复现台账投影的顺序（用于详情合并后重排、
// 以及「只看需要我出手」的筛选），一旦与后端顺序不一致即以 `actionRank` 为准。
// 前端不重算卡面状态——`state` 是后端派生结果，禁止在前端用状态重推 actionRank。

import type { TrackedCardSummary } from '../../types/trackedTask';

/** 台账投影的清单顺序：actionRank 升序，同档按 updatedAt 降序（与主进程 listCards 一致）。 */
export function orderCardsForBoardList(cards: TrackedCardSummary[]): TrackedCardSummary[] {
  return [...cards].sort(
    (a, b) => a.actionRank - b.actionRank || b.updatedAt.localeCompare(a.updatedAt)
  );
}

/** 「只看需要我出手」：用后端给的 needsOwnerAction 标志，不重新推导。 */
export function filterNeedsOwnerAction(cards: TrackedCardSummary[]): TrackedCardSummary[] {
  return cards.filter((card) => card.needsOwnerAction);
}
