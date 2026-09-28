import React, { useCallback, useState } from 'react';
import { i18nService } from '../../services/i18n';

interface GroupTaskComposerProps {
  sending: boolean;
  sendError: string | null;
  sentHint: boolean;
  /** Sends one trimmed message; resolves true when it was accepted. */
  onSend: (text: string) => Promise<boolean>;
}

/**
 * Group-task message composer. The draft lives here (not in the transcript
 * panel) so typing re-renders the composer alone instead of the whole
 * transcript; the parent owns the send lifecycle (in-flight, error, hint).
 */
const GroupTaskComposer: React.FC<GroupTaskComposerProps> = ({
  sending,
  sendError,
  sentHint,
  onSend,
}) => {
  const [input, setInput] = useState('');

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    if (await onSend(text)) setInput('');
  }, [input, sending, onSend]);

  return (
    <div className="shrink-0 border-t dark:border-claude-darkBorder border-claude-border px-4 py-3">
      <div className="flex items-end gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Same contract as the new-task composer: Enter sends,
            // Shift+Enter inserts a newline. Enter during IME
            // composition confirms the candidate instead of sending.
            const isComposing = e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229;
            if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
              e.preventDefault();
              void handleSend();
            }
          }}
          rows={2}
          className="flex-1 rounded-2xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface px-3 py-2 text-sm leading-relaxed dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/50 resize-none"
          placeholder={i18nService.t('groupTasksSendPlaceholder')}
        />
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={!input.trim() || sending}
          className="btn-idchat-primary-filled px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {sending ? i18nService.t('groupTasksSending') : i18nService.t('groupTasksSend')}
        </button>
      </div>
      {sendError && <p className="text-xs text-red-500 mt-1">{sendError}</p>}
      {sentHint && !sendError && (
        <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-1">
          {i18nService.t('groupTasksSentHint')}
        </p>
      )}
    </div>
  );
};

export default GroupTaskComposer;
