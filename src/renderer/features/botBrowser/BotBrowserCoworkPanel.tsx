import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { ClockIcon, XMarkIcon, TrashIcon, WrenchIcon } from '@heroicons/react/24/outline';
import ComposeIcon from '../../components/icons/ComposeIcon';
import MarkdownContent from '../../components/MarkdownContent';
import CoworkPromptInput from '../../components/cowork/CoworkPromptInput';
import { RootState } from '../../store';
import { browserCoworkService } from '../../services/browserCowork';
import { i18nService } from '../../services/i18n';
import type { CoworkMessage } from '../../types/cowork';

const formatRelativeTime = (timestamp: number): string => {
  const deltaMs = Date.now() - timestamp;
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
};

const PanelMessage: React.FC<{ message: CoworkMessage }> = ({ message }) => {
  if (message.type === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[90%] whitespace-pre-wrap break-words rounded-xl rounded-br-sm bg-claude-accent/90 px-3 py-2 text-sm text-white">
          {message.content}
        </div>
      </div>
    );
  }
  if (message.type === 'tool_use') {
    const toolName = message.metadata?.toolName ?? '';
    return (
      <div className="flex items-center gap-1.5 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
        <WrenchIcon className="h-3 w-3 shrink-0" />
        <span className="truncate">{toolName || 'tool'}</span>
      </div>
    );
  }
  if (message.type !== 'assistant') return null;
  if (!message.content.trim()) return null;
  return (
    <div className="text-sm dark:text-claude-darkText text-claude-text [&_pre]:text-xs [&_pre]:max-w-full [&_pre]:overflow-x-auto">
      <MarkdownContent content={message.content} />
    </div>
  );
};

/**
 * Co-Work chat panel embedded in the sidebar under the "New Tab" button when
 * the Bot Browser surface is active. Talks to the local Agent through
 * `browserCoworkService`; the Agent controls the browser via bot_browser_*
 * tools. History is a toggleable overlay; sessions remember the browser URI
 * they were about.
 */
const BotBrowserCoworkPanel: React.FC = () => {
  const currentSession = useSelector((state: RootState) => state.browserCowork.currentSession);
  const isStreaming = useSelector((state: RootState) => state.browserCowork.isStreaming);
  const sessions = useSelector((state: RootState) => state.cowork.sessions);
  const [showHistory, setShowHistory] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const browserSessions = useMemo(
    () => sessions.filter((session) => session.sessionType === 'browser'),
    [sessions]
  );

  const messages = currentSession?.messages ?? [];
  const visibleMessages = useMemo(
    () => messages.filter((message) => (
      (message.type === 'user' || message.type === 'assistant' || message.type === 'tool_use')
      && !message.metadata?.isDelegationInternal
    )),
    [messages]
  );

  useEffect(() => {
    const list = listRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }, [visibleMessages.length, isStreaming]);

  const handleSubmit = async (prompt: string) => {
    setShowHistory(false);
    if (currentSession) {
      await browserCoworkService.send(prompt);
    } else {
      await browserCoworkService.start(prompt);
    }
  };

  const handleSelectHistory = async (sessionId: string) => {
    setShowHistory(false);
    await browserCoworkService.loadSession(sessionId);
  };

  const handleDeleteHistory = async (sessionId: string) => {
    await browserCoworkService.deleteSession(sessionId);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-1 pb-2">
        <span className="flex-1 truncate text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('botBrowserCoworkTitle')}
        </span>
        <button
          type="button"
          onClick={() => {
            setShowHistory(false);
            browserCoworkService.startNewDraft();
          }}
          className="h-6 w-6 inline-flex items-center justify-center rounded-md dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          aria-label={i18nService.t('botBrowserCoworkNew')}
          title={i18nService.t('botBrowserCoworkNew')}
        >
          <ComposeIcon className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setShowHistory((value) => !value)}
          className={`h-6 w-6 inline-flex items-center justify-center rounded-md transition-colors ${
            showHistory
              ? 'dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkText text-claude-text'
              : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
          }`}
          aria-label={i18nService.t('botBrowserCoworkHistory')}
          title={i18nService.t('botBrowserCoworkHistory')}
        >
          <ClockIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-1 pb-2">
        {visibleMessages.length === 0 ? (
          <div className="rounded-lg border border-dashed dark:border-claude-darkBorder border-claude-border px-3 py-4 text-xs leading-5 dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('botBrowserCoworkEmpty')}
          </div>
        ) : (
          visibleMessages.map((message) => <PanelMessage key={message.id} message={message} />)
        )}
        {isStreaming ? (
          <div className="flex items-center gap-1 px-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current [animation-delay:150ms]" />
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current [animation-delay:300ms]" />
          </div>
        ) : null}
      </div>

      <CoworkPromptInput
        onSubmit={handleSubmit}
        onStop={() => void browserCoworkService.stop()}
        isStreaming={isStreaming}
        placeholder={i18nService.t('botBrowserCoworkPlaceholder')}
        size="normal"
        scopeKey="botBrowser"
        showFolderSelector={false}
        showModelSelector={false}
      />

      {showHistory ? (
        <div className="absolute inset-x-0 top-7 bottom-0 z-10 flex flex-col rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted shadow-lg">
          <div className="flex items-center justify-between px-3 py-2 text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
            <span>{i18nService.t('botBrowserCoworkHistory')}</span>
            <button
              type="button"
              onClick={() => setShowHistory(false)}
              className="h-5 w-5 inline-flex items-center justify-center rounded-md hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
              aria-label={i18nService.t('close')}
            >
              <XMarkIcon className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            {browserSessions.length === 0 ? (
              <div className="px-2 py-3 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('coworkNoSessions')}
              </div>
            ) : (
              browserSessions.map((session) => (
                <div
                  key={session.id}
                  className={`group flex items-start gap-1 rounded-md px-2 py-1.5 text-sm transition-colors cursor-pointer hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover ${
                    currentSession?.id === session.id ? 'dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover' : ''
                  }`}
                  onClick={() => void handleSelectHistory(session.id)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] dark:text-claude-darkText text-claude-text">
                      {session.title}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {(session.browserTitle || session.browserUri) ?? ''}
                    </div>
                  </div>
                  <span className="shrink-0 pt-0.5 text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {formatRelativeTime(session.updatedAt)}
                  </span>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleDeleteHistory(session.id);
                    }}
                    className="hidden h-5 w-5 shrink-0 items-center justify-center rounded-md text-claude-textSecondary hover:text-red-500 group-hover:inline-flex"
                    aria-label={i18nService.t('delete')}
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default BotBrowserCoworkPanel;
