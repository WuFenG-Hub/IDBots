// 清单视图的排序/筛选 —— **只消费后端投影给的字段**，并逐档复现台账的排序键。
//
// 权威来源：src/main/services/trackedTaskBoard.ts `listCards()`（契约 v1.4 + 附录 A-4）：
//   ① actionRank 升序
//   ② 同权重按 activityAtMs 升序（null 视为最大，排最后）
//   ③ 仍相等按 id 升序（为 limit/offset 稳定分页而加的终键）
//   `needsOwnerAction ≡ (waiting_decision ∨ closureDue)`，由后端给出。
//
// 因此本文件**不是第二套排序口径**：它逐档复现同一组键，用于「详情合并后重排」与
// 「只看需要我出手」的筛选。前端不重算卡面状态——`state` 是后端派生结果，
// 禁止在前端用状态重推 actionRank。若与后端顺序不一致，以 `actionRank` 那棵树为准。

import type { TrackedCardSummary } from '../../types/trackedTask';

const NO_ACTIVITY = Number.MAX_SAFE_INTEGER;

/**
 * 台账清单顺序：actionRank ↑ → activityAtMs ↑（null 最后）→ id ↑。
 * 结果是**输入的确定性函数**：把同一批卡打乱顺序喂进来，输出必须逐行相同。
 */
export function orderCardsForBoardList(cards: TrackedCardSummary[]): TrackedCardSummary[] {
  return [...cards].sort((a, b) => {
    const byRank = a.actionRank - b.actionRank;
    if (byRank !== 0) return byRank;

    const aAt = a.activityAtMs ?? NO_ACTIVITY;
    const bAt = b.activityAtMs ?? NO_ACTIVITY;
    if (aAt !== bAt) return aAt - bAt;

    return a.id.localeCompare(b.id);
  });
}

/** 「只看需要我出手」：用后端给的 needsOwnerAction 标志，不重新推导。 */
export function filterNeedsOwnerAction(cards: TrackedCardSummary[]): TrackedCardSummary[] {
  return cards.filter((card) => card.needsOwnerAction);
}
