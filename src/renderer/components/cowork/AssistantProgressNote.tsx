import React, { useLayoutEffect, useRef } from 'react';
import type { CoworkMessage } from '../../types/cowork';
import { thinkingSummaryLine } from './ThinkingBlock';

/**
 * Assistant-mode rendering of a thinking segment: a single quiet status line
 * instead of the expandable professional-mode ThinkingBlock. While the
 * segment streams it tracks the latest reasoning line with a pulsing accent
 * dot; once settled it keeps the first line with a dimmed dot. Not clickable,
 * not expandable — a progress note, not a card.
 */
export const AssistantProgressNote: React.FC<{
  message: CoworkMessage;
  mapDisplayText?: (value: string) => string;
  live?: boolean;
}> = ({ message, mapDisplayText, live }) => {
  const isCurrentlyStreaming = live ?? Boolean(message.metadata?.isStreaming);
  const displayContent = mapDisplayText ? mapDisplayText(message.content) : message.content;
  const summary = thinkingSummaryLine(displayContent, isCurrentlyStreaming);
  const summaryRef = useRef<HTMLSpanElement>(null);

  // While streaming, keep the tail of the latest line in view (the summary
  // follows the newest text, same convention as ThinkingBlock).
  useLayoutEffect(() => {
    if (!isCurrentlyStreaming) return;
    const element = summaryRef.current;
    if (!element) return;
    element.scrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
  }, [isCurrentlyStreaming, summary]);

  if (!summary) return null;

  return (
    <div className="flex items-center gap-1.5 py-0.5">
      <span
        className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
          isCurrentlyStreaming
            ? 'bg-claude-accent animate-pulse'
            : 'dark:bg-claude-darkTextSecondary/40 bg-claude-textSecondary/40'
        }`}
        aria-hidden
      />
      <span
        ref={summaryRef}
        className="min-w-0 flex-1 text-xs leading-5 whitespace-nowrap dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70"
        style={{ overflow: 'hidden', textOverflow: isCurrentlyStreaming ? 'clip' : 'ellipsis' }}
      >
        {summary}
      </span>
    </div>
  );
};
