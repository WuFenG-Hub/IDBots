import React, { useLayoutEffect, useRef, useState } from 'react';
import { ChevronRightIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { CoworkMessage } from '../../types/cowork';

const OPEN_RE = /<think(?:ing)?>/i;
const CLOSE_RE = /<\/think(?:ing)?>/i;

export type SplitThinkTaggedContent = {
  thinking: string;
  text: string;
};

/**
 * Collapsed Think-row summary, matching DSH web `ReasoningRow`:
 * streaming → latest non-blank line; settled → first line.
 */
export function thinkingSummaryLine(text: string, running: boolean): string {
  const visible = (text || '').trimEnd();
  if (!visible) return '';
  if (running) {
    const newline = visible.lastIndexOf('\n');
    return newline === -1 ? visible : visible.slice(newline + 1);
  }
  const newline = visible.indexOf('\n');
  return newline === -1 ? visible : visible.slice(0, newline);
}

/**
 * Split assistant text that embeds chain-of-thought in <think>/<thinking>
 * tags so the visible reply can reuse the Think row chrome.
 */
export function splitThinkTaggedContent(input: string): SplitThinkTaggedContent {
  if (!input) return { thinking: '', text: '' };
  if (!OPEN_RE.test(input) && !CLOSE_RE.test(input)) {
    return { thinking: '', text: input };
  }

  let thinking = '';
  let text = '';
  let remaining = input;
  let inThink = false;

  while (remaining.length > 0) {
    if (inThink) {
      const close = remaining.search(CLOSE_RE);
      if (close === -1) {
        thinking += remaining;
        break;
      }
      thinking += remaining.slice(0, close);
      const matched = remaining.slice(close).match(CLOSE_RE);
      remaining = remaining.slice(close + (matched?.[0].length ?? 0));
      inThink = false;
      continue;
    }

    const open = remaining.search(OPEN_RE);
    if (open === -1) {
      text += remaining;
      break;
    }
    text += remaining.slice(0, open);
    const matched = remaining.slice(open).match(OPEN_RE);
    remaining = remaining.slice(open + (matched?.[0].length ?? 0));
    inThink = true;
  }

  return { thinking, text };
}

/**
 * DSH-kernel Think row (parity with deepseek-harness ReasoningRow).
 * Stays collapsed unless the user opens it — never auto-expands the full
 * chain of thought as body copy, never auto-collapses after a dump.
 * While streaming, the collapsed summary follows the latest line.
 */
export const ThinkingBlock: React.FC<{
  message: CoworkMessage;
  mapDisplayText?: (value: string) => string;
}> = ({ message, mapDisplayText }) => {
  const isCurrentlyStreaming = Boolean(message.metadata?.isStreaming);
  const [isExpanded, setIsExpanded] = useState(false);
  const summaryRef = useRef<HTMLSpanElement>(null);
  const displayContent = mapDisplayText ? mapDisplayText(message.content) : message.content;
  const summary = thinkingSummaryLine(displayContent, isCurrentlyStreaming);

  useLayoutEffect(() => {
    if (!isCurrentlyStreaming || isExpanded) return;
    const element = summaryRef.current;
    if (!element) return;
    element.scrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
  }, [isCurrentlyStreaming, isExpanded, summary]);

  return (
    <div className="rounded-lg border dark:border-claude-darkBorder/50 border-claude-border/50 overflow-hidden">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left dark:hover:bg-claude-darkSurfaceHover/50 hover:bg-claude-surfaceHover/50 transition-colors"
      >
        <ChevronRightIcon
          className={`h-3.5 w-3.5 dark:text-claude-darkTextSecondary text-claude-textSecondary flex-shrink-0 transition-transform duration-200 ${
            isExpanded ? 'rotate-90' : ''
          }`}
        />
        <span className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary flex-shrink-0">
          {i18nService.t('reasoning')}
        </span>
        {isCurrentlyStreaming && (
          <span className="w-1.5 h-1.5 rounded-full bg-claude-accent animate-pulse flex-shrink-0" />
        )}
        {!isExpanded && summary ? (
          <>
            <span
              className="w-0.5 h-0.5 rounded-full flex-shrink-0 dark:bg-claude-darkTextSecondary/50 bg-claude-textSecondary/50"
              aria-hidden
            />
            <span
              ref={summaryRef}
              className="min-w-0 flex-1 text-xs dark:text-claude-darkTextSecondary/80 text-claude-textSecondary/80 whitespace-nowrap"
              style={{ overflow: 'hidden', textOverflow: isCurrentlyStreaming ? 'clip' : 'ellipsis' }}
            >
              {summary}
            </span>
          </>
        ) : null}
      </button>
      {isExpanded && (
        <div className="px-3 pb-3 max-h-64 overflow-y-auto overflow-anchor-none">
          <div className="text-xs leading-relaxed dark:text-claude-darkTextSecondary/80 text-claude-textSecondary/80 whitespace-pre-wrap">
            {displayContent}
          </div>
        </div>
      )}
    </div>
  );
};
