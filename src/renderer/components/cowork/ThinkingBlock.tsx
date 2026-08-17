import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRightIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { CoworkMessage } from '../../types/cowork';

const pinScrollToBottom = (element: HTMLElement | null): void => {
  if (!element) return;
  element.scrollTop = element.scrollHeight;
};

const OPEN_RE = /<think(?:ing)?>/i;
const CLOSE_RE = /<\/think(?:ing)?>/i;

export type SplitThinkTaggedContent = {
  thinking: string;
  text: string;
};

/**
 * Split assistant text that embeds chain-of-thought in <think>/<thinking>
 * tags so the visible reply can reuse Claude's ThinkingBlock chrome.
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

export const ThinkingBlock: React.FC<{
  message: CoworkMessage;
  mapDisplayText?: (value: string) => string;
}> = ({ message, mapDisplayText }) => {
  const isCurrentlyStreaming = Boolean(message.metadata?.isStreaming);
  const [isExpanded, setIsExpanded] = useState(isCurrentlyStreaming);
  const bodyRef = useRef<HTMLDivElement>(null);
  const displayContent = mapDisplayText ? mapDisplayText(message.content) : message.content;

  useEffect(() => {
    if (isCurrentlyStreaming) {
      setIsExpanded(true);
    } else {
      setIsExpanded(false);
    }
  }, [isCurrentlyStreaming]);

  useLayoutEffect(() => {
    if (!isCurrentlyStreaming) return;
    pinScrollToBottom(bodyRef.current);
  }, [isCurrentlyStreaming, displayContent]);

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
        <span className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('reasoning')}
        </span>
        {isCurrentlyStreaming && (
          <span className="w-1.5 h-1.5 rounded-full bg-claude-accent animate-pulse" />
        )}
      </button>
      {isExpanded && (
        <div ref={bodyRef} className="px-3 pb-3 max-h-64 overflow-y-auto overflow-anchor-none">
          <div className="text-xs leading-relaxed dark:text-claude-darkTextSecondary/80 text-claude-textSecondary/80 whitespace-pre-wrap">
            {displayContent}
          </div>
        </div>
      )}
    </div>
  );
};
