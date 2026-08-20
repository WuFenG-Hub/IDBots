import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { ClockIcon, XMarkIcon, TrashIcon, PaperClipIcon, FolderIcon } from '@heroicons/react/24/outline';
import ComposeIcon from '../../components/icons/ComposeIcon';
import MarkdownContent from '../../components/MarkdownContent';
import CoworkPromptInput, { type CoworkPromptInputRef } from '../../components/cowork/CoworkPromptInput';
import FolderSelectorPopover from '../../components/cowork/FolderSelectorPopover';
import MetaBotSelector, { type MetaBotForSelector } from '../../components/cowork/MetaBotSelector';
import ModelEffortPicker from '../../components/ModelEffortPicker';
import { convertLegacyEffortLevel } from '../../services/modelCatalog';
import { SkillsButton, ActiveSkillBadge } from '../../components/skills';
import { RootState } from '../../store';
import { toggleActiveSkill } from '../../store/slices/skillSlice';
import { browserCoworkService } from '../../services/browserCowork';
import { i18nService } from '../../services/i18n';
import { getCompactFolderName } from '../../utils/path';
import type { CoworkMessage } from '../../types/cowork';
import type { Skill } from '../../types/skill';

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

type PanelMetabot = MetaBotForSelector & { llm_id?: string | null; llm_provider?: string | null; llm_effort?: string | null };

/**
 * Minimal rendering contract for the side panel: user messages and final
 * agent answers only. Tool calls, tool results, system messages, thinking
 * blocks, and delegation-internal chatter are intentionally hidden.
 */
export function filterVisiblePanelMessages(messages: CoworkMessage[]): CoworkMessage[] {
  return messages.filter((message) => {
    if (message.metadata?.isDelegationInternal) return false;
    if (message.type === 'user') return true;
    if (message.type === 'assistant') return !message.metadata?.isThinking;
    return false;
  });
}

const PanelMessage: React.FC<{ message: CoworkMessage; onOpenUri: (uri: string) => void }> = ({ message, onOpenUri }) => {
  if (message.type === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[90%] min-w-0 whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-[13px] dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text shadow-subtle">
          {message.content}
        </div>
      </div>
    );
  }
  if (message.type !== 'assistant' || !message.content.trim()) return null;
  return (
    <div className="min-w-0 text-[13px] leading-5 dark:text-claude-darkText text-claude-text [&_h1]:text-sm [&_h1]:mt-3 [&_h1]:mb-1.5 [&_h2]:text-[13px] [&_h2]:mt-2.5 [&_h2]:mb-1 [&_h3]:text-[13px] [&_h3]:mt-2 [&_h3]:mb-1 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:text-xs [&_code]:break-all [&_a]:break-all">
      <MarkdownContent content={message.content} compact onOpenBotBrowserUri={onOpenUri} />
    </div>
  );
};

interface BotBrowserCoworkPanelProps {
  onShowSkills?: () => void;
}

/**
 * Co-Work chat panel embedded in the sidebar under the Bot Browser item when
 * the Bot Internet surface is showing the browser pane. Talks to the local Agent through
 * `browserCoworkService`; the Agent controls the browser via bot_browser_*
 * tools. Rendering is intentionally minimal: user messages and final agent
 * answers only — tool calls, thinking, and system noise stay out of view.
 * History is a toggleable overlay; sessions remember the browser URI they
 * were about.
 */
const BotBrowserCoworkPanel: React.FC<BotBrowserCoworkPanelProps> = ({ onShowSkills }) => {
  const dispatch = useDispatch();
  const currentSession = useSelector((state: RootState) => state.browserCowork.currentSession);
  const isStreaming = useSelector((state: RootState) => state.browserCowork.isStreaming);
  const sessions = useSelector((state: RootState) => state.cowork.sessions);
  const [showHistory, setShowHistory] = useState(false);
  const [metabots, setMetabots] = useState<PanelMetabot[]>([]);
  const [selectedMetabotId, setSelectedMetabotId] = useState<number | null>(null);
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [showFolderMenu, setShowFolderMenu] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const promptInputRef = useRef<CoworkPromptInputRef>(null);
  const folderButtonRef = useRef<HTMLButtonElement>(null);

  const browserSessions = useMemo(
    () => sessions.filter((session) => session.sessionType === 'browser'),
    [sessions]
  );

  const messages = currentSession?.messages ?? [];
  const visibleMessages = useMemo(
    () => filterVisiblePanelMessages(messages),
    [messages]
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await window.electron?.metabot?.list?.();
      if (cancelled || !result?.success || !result.list) return;
      const selectable = result.list
        .filter(
          (metabot) => metabot.enabled && typeof metabot.llm_id === 'string' && metabot.llm_id.trim()
        )
        .sort((a, b) => a.id - b.id);
      setMetabots(selectable);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // An existing session's MetaBot wins for display; otherwise fall back to the first available.
  useEffect(() => {
    if (currentSession?.metabotId != null) {
      setSelectedMetabotId(currentSession.metabotId);
    }
  }, [currentSession?.metabotId]);

  const effectiveMetabotId = selectedMetabotId ?? metabots[0]?.id ?? null;
  const selectedMetabot = metabots.find((m) => m.id === effectiveMetabotId) ?? null;
  // Pending model+effort for the session about to start from this panel;
  // nulls = follow the selected bot's brain (its model and effort).
  const [pendingModelEffort, setPendingModelEffort] = useState<{
    modelId: string | null;
    providerKey?: string | null;
    effort: string | null;
  } | null>(null);

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
      await browserCoworkService.start(prompt, effectiveMetabotId, workingDirectory || undefined, {
        model: pendingModelEffort?.modelId ?? undefined,
        modelProvider: pendingModelEffort?.providerKey ?? undefined,
        effort: pendingModelEffort?.effort ?? undefined,
      });
      setPendingModelEffort(null);
    }
  };

  const handleSelectHistory = async (sessionId: string) => {
    setShowHistory(false);
    await browserCoworkService.loadSession(sessionId);
  };

  const handleDeleteHistory = async (sessionId: string) => {
    await browserCoworkService.archiveSession(sessionId);
  };

  const handleOpenUri = (uri: string) => {
    window.dispatchEvent(new CustomEvent('botBrowser:openUri', { detail: { uri } }));
  };

  const renderMessage = (message: CoworkMessage) => (
    <PanelMessage key={message.id} message={message} onOpenUri={handleOpenUri} />
  );

  const handleSelectSkill = (skill: Skill) => {
    dispatch(toggleActiveSkill(skill.id));
  };

  const handleAddFile = async () => {
    try {
      const result = await window.electron.dialog.selectFile({
        title: i18nService.t('coworkAddFile'),
      });
      if (result.success && result.path) {
        promptInputRef.current?.addAttachments([result.path]);
      }
    } catch (error) {
      console.error('Failed to select file:', error);
    }
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
            setSelectedMetabotId(null);
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

      <div ref={listRef} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto overflow-x-hidden px-1 pb-2">
        {visibleMessages.length === 0 ? (
          <div className="rounded-lg border border-dashed dark:border-claude-darkBorder border-claude-border px-3 py-4 text-xs leading-5 dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('botBrowserCoworkEmpty')}
          </div>
        ) : (
          visibleMessages.map(renderMessage)
        )}
        {isStreaming ? (
          <div className="flex items-center gap-1 px-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current [animation-delay:150ms]" />
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current [animation-delay:300ms]" />
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-0.5 px-1 pb-1.5">
        {metabots.length > 0 ? (
          <div className="min-w-0 max-w-[60%]">
            <MetaBotSelector
              metabots={metabots}
              selectedId={effectiveMetabotId}
              onSelect={setSelectedMetabotId}
              label={i18nService.t('coworkMetaBotLabel')}
              placeholder={i18nService.t('coworkMetaBotPlaceholder')}
              compact
              dropdownDirection="up"
            />
          </div>
        ) : null}
        <div className="flex shrink-0 items-center gap-0.5">
          <ModelEffortPicker
            dropdownDirection="up"
            compact
            value={{
              modelId: pendingModelEffort?.modelId ?? selectedMetabot?.llm_id ?? null,
              providerKey: pendingModelEffort?.modelId == null
                ? (selectedMetabot?.llm_provider ?? null)
                : (pendingModelEffort?.providerKey ?? null),
              effort: (pendingModelEffort?.effort
                ?? (selectedMetabot?.llm_effort ? convertLegacyEffortLevel(selectedMetabot.llm_effort) : null)) as ReturnType<typeof convertLegacyEffortLevel>,
            }}
            onChange={(value) => {
              setPendingModelEffort({
                modelId: value.modelId,
                providerKey: value.providerKey ?? null,
                effort: value.effort,
              });
            }}
          />
          <button
            type="button"
            onClick={() => void handleAddFile()}
            className="shrink-0 p-1.5 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:hover:text-claude-darkText hover:text-claude-text transition-colors"
            title={i18nService.t('coworkAddFile')}
            aria-label={i18nService.t('coworkAddFile')}
          >
            <PaperClipIcon className="h-4 w-4" />
          </button>
          <SkillsButton
            onSelectSkill={handleSelectSkill}
            onManageSkills={() => onShowSkills?.()}
            className="shrink-0 !p-1.5 [&_svg]:h-4 [&_svg]:w-4"
          />
          <ActiveSkillBadge />
          <button
            ref={folderButtonRef}
            type="button"
            onClick={() => setShowFolderMenu((value) => !value)}
            className="shrink-0 p-1.5 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:hover:text-claude-darkText hover:text-claude-text transition-colors"
            title={workingDirectory ? getCompactFolderName(workingDirectory, 40) : i18nService.t('coworkSelectFolderFirst')}
            aria-label={i18nService.t('coworkSelectFolderFirst')}
          >
            <FolderIcon className="h-4 w-4" />
          </button>
          <FolderSelectorPopover
            isOpen={showFolderMenu}
            onClose={() => setShowFolderMenu(false)}
            onSelectFolder={(folderPath) => {
              setWorkingDirectory(folderPath);
              setShowFolderMenu(false);
            }}
            anchorRef={folderButtonRef as React.RefObject<HTMLElement>}
            currentFolder={workingDirectory}
          />
        </div>
      </div>

      <CoworkPromptInput
        ref={promptInputRef}
        onSubmit={handleSubmit}
        onStop={() => void browserCoworkService.stop()}
        isStreaming={isStreaming}
        placeholder={i18nService.t('botBrowserCoworkPlaceholder')}
        size="normal"
        scopeKey="botBrowser"
        showFolderSelector={false}
        showModelSelector={false}
        showAttachmentButton={false}
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
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1.5 pb-2">
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
                    <div className="truncate text-xs dark:text-claude-darkText text-claude-text">
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
