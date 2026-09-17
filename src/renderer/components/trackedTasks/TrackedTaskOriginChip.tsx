import React, { useEffect, useState } from 'react';
import TrackedTaskOriginChipView, { TrackedTaskOriginLink } from './TrackedTaskOriginChipView';

interface TrackedTaskOriginChipProps {
  sessionId: string | null | undefined;
}

/**
 * 会话侧的「所属长期任务」chip（验收⑤ 的反向：会话 → 卡）。
 *
 * 数据来源 `trackedTask:cardsForSession`（只读）。**0 行 = 独立会话：不渲染任何东西**，
 * 不做「可能是某张卡」的猜测——归属是事实，不是推断。
 * 点击后发 `trackedTask:viewCard` 事件，由 App.tsx 切到跟踪任务页并选中该卡。
 */
const TrackedTaskOriginChip: React.FC<TrackedTaskOriginChipProps> = ({ sessionId }) => {
  const [cards, setCards] = useState<TrackedTaskOriginLink[]>([]);

  useEffect(() => {
    let cancelled = false;
    const api = window.electron?.trackedTask;
    if (!sessionId || !api?.cardsForSession) {
      setCards([]);
      return () => {
        cancelled = true;
      };
    }

    void api
      .cardsForSession({ sessionId })
      .then((result) => {
        if (cancelled) return;
        setCards(result?.success && Array.isArray(result.cards) ? result.cards : []);
      })
      .catch(() => {
        if (!cancelled) setCards([]);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return (
    <TrackedTaskOriginChipView
      cards={cards}
      onOpenCard={(cardId) =>
        window.dispatchEvent(new CustomEvent('trackedTask:viewCard', { detail: { cardId } }))
      }
    />
  );
};

export default TrackedTaskOriginChip;
