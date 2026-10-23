import React, { useCallback, useState } from 'react';
import { useSelector } from 'react-redux';
import { HandThumbUpIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { RootState } from '../../store';
import { i18nService } from '../../services/i18n';
import { CoworkMessage } from '../../types/cowork';
import {
  readFeedbackNudgeDismissed,
  shouldShowFeedbackNudge,
  writeFeedbackNudgeDismissed,
} from './feedbackNudge';

/**
 * The feedback-desert nudge (dream review P2-2): one quiet, dismissible line
 * near the message controls when a session has ≥5 assistant messages and no
 * thumbs yet. Deliberately NOT a toast/popup — it rides the bottom area like
 * the quota banner and never covers content. Any feedback in the session
 * suppresses it permanently; dismissing suppresses it for this session.
 */
const FeedbackNudgeHint: React.FC<{
  sessionId: string;
  messages: Pick<CoworkMessage, 'id' | 'type'>[];
  /**
   * Review Minor 5: false while the session's feedback rows are still loading
   * — the hint must not flash for a rated session mid-hydration.
   */
  feedbackLoaded: boolean;
}> = ({ sessionId, messages, feedbackLoaded }) => {
  const feedbackByMessageId = useSelector(
    (state: RootState) => state.cowork.feedbackByMessageId,
  );
  const [dismissed, setDismissed] = useState(() =>
    readFeedbackNudgeDismissed(window.localStorage, sessionId),
  );

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    writeFeedbackNudgeDismissed(window.localStorage, sessionId);
  }, [sessionId]);

  const assistantMessageCount = messages.reduce(
    (count, message) => (message.type === 'assistant' ? count + 1 : count),
    0,
  );
  const sessionFeedbackCount = messages.reduce(
    (count, message) => (feedbackByMessageId[message.id] ? count + 1 : count),
    0,
  );

  if (
    !feedbackLoaded
    || !shouldShowFeedbackNudge({ assistantMessageCount, sessionFeedbackCount, dismissed })
  ) {
    return null;
  }

  return (
    <div className="px-4 pb-1.5 shrink-0" data-feedback-nudge="true">
      <div className="max-w-[clamp(680px,64%,920px)] mx-auto flex items-center gap-2 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset px-3 py-1.5">
        <HandThumbUpIcon className="h-3.5 w-3.5 shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
        <span className="flex-1 text-[11px] leading-snug dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('coworkFeedbackNudge')}
        </span>
        <button
          type="button"
          onClick={handleDismiss}
          className="p-0.5 rounded-md dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary transition-colors"
          title={i18nService.t('close')}
          aria-label={i18nService.t('close')}
        >
          <XMarkIcon className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};

export default FeedbackNudgeHint;
