import React, { useCallback, useEffect, useRef, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { groupTaskService } from '../../services/groupTaskService';
import type {
  GroupChatTranscriptMessage,
  GroupTaskDetail,
} from '../../types/groupTask';
import GroupTaskMessageItem from './GroupTaskMessageItem';
import GroupTaskCloseConfirmModal from './GroupTaskCloseConfirmModal';
import {
  formatGroupTaskTime,
  groupTaskStatusBadgeClass,
  isActiveGroupTaskStatus,
  mergeTranscriptMessages,
  shouldStickToBottom,
} from './groupTaskUtils';
import { groupTaskStatusLabelKey } from './GroupTasksView';
import { ArrowLeftIcon, ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import WindowTitleBar from '../window/WindowTitleBar';

const MESSAGE_PAGE_LIMIT = 50;

interface GroupTaskDetailViewProps {
  taskId: number;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
  onBack: () => void;
}

const GroupTaskDetailView: React.FC<GroupTaskDetailViewProps> = ({
  taskId,
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  updateBadge,
  onBack,
}) => {
  const isMac = window.electron.platform === 'darwin';
  const [detail, setDetail] = useState<GroupTaskDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(true);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [messages, setMessages] = useState<GroupChatTranscriptMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(true);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [ownerGlobalMetaId, setOwnerGlobalMetaId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sentHint, setSentHint] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'done' | 'cancelled' | null>(null);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const sentHintTimerRef = useRef<number | null>(null);

  const refreshDetail = useCallback(async () => {
    try {
      const task = await groupTaskService.getTask(taskId);
      setDetail(task);
      setDetailError(null);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : String(err));
    }
  }, [taskId]);

  const loadMessages = useCallback(async () => {
    try {
      const page = await groupTaskService.listMessages(taskId, { limit: MESSAGE_PAGE_LIMIT });
      setMessages((current) => mergeTranscriptMessages(current, page));
      setMessagesError(null);
    } catch (err) {
      setMessagesError(err instanceof Error ? err.message : String(err));
    }
  }, [taskId]);

  // Initial detail load + owner identity (for owner-message styling).
  useEffect(() => {
    let cancelled = false;
    setLoadingDetail(true);
    void refreshDetail().finally(() => {
      if (!cancelled) setLoadingDetail(false);
    });
    void (async () => {
      try {
        const result = await window.electron?.userIdentity?.get?.();
        if (!cancelled && result?.success && result.identity?.globalmetaid) {
          setOwnerGlobalMetaId(result.identity.globalmetaid);
        }
      } catch {
        // Owner styling simply stays off when the identity is unavailable.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshDetail]);

  // Transcript: initial load + 5s poll while mounted.
  useEffect(() => {
    let cancelled = false;
    setLoadingMessages(true);
    void loadMessages().finally(() => {
      if (!cancelled) setLoadingMessages(false);
    });
    const timer = window.setInterval(() => {
      void loadMessages();
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loadMessages]);

  // Immediate refresh on task status changes (also keeps the header badge live).
  useEffect(() => {
    const api = window.electron?.groupTask;
    if (!api) return undefined;
    return api.onStatusChanged((event) => {
      if (event?.taskId !== taskId) return;
      void refreshDetail();
      void loadMessages();
    });
  }, [taskId, refreshDetail, loadMessages]);

  // Auto-scroll to bottom on new messages unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  useEffect(() => () => {
    if (sentHintTimerRef.current != null) {
      window.clearTimeout(sentHintTimerRef.current);
    }
  }, []);

  const handleTranscriptScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = shouldStickToBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await groupTaskService.sendUserMessage(taskId, text);
      setInput('');
      setSentHint(true);
      if (sentHintTimerRef.current != null) {
        window.clearTimeout(sentHintTimerRef.current);
      }
      sentHintTimerRef.current = window.setTimeout(() => setSentHint(false), 4000);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const handleConfirmClose = async () => {
    if (!confirmAction || !detail) return;
    setClosing(true);
    setCloseError(null);
    try {
      const updated = await groupTaskService.closeTask({ taskId, status: confirmAction });
      setDetail(updated);
      setConfirmAction(null);
    } catch (err) {
      setCloseError(err instanceof Error ? err.message : String(err));
    } finally {
      setClosing(false);
    }
  };

  if (loadingDetail) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('loading')}
        </div>
      </div>
    );
  }

  if (detailError || !detail) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <p className="text-sm text-red-500">{detailError ?? i18nService.t('groupTasksLoadFailed')}</p>
        <button
          type="button"
          onClick={onBack}
          className="px-4 py-2 text-sm rounded-lg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
        >
          {i18nService.t('back')}
        </button>
      </div>
    );
  }

  const isTerminal = !isActiveGroupTaskStatus(detail.status);
  const chairMember = detail.members.find((member) => member.role === 'chair');
  const deliverableAuthorName = (authorGlobalMetaId: string | null): string => {
    if (!authorGlobalMetaId) return '—';
    const member = detail.members.find((candidate) => candidate.globalmetaid === authorGlobalMetaId);
    if (member?.name) return member.name;
    if (ownerGlobalMetaId && authorGlobalMetaId === ownerGlobalMetaId) {
      return i18nService.t('groupTasksOwnerBadge');
    }
    return `${authorGlobalMetaId.slice(0, 10)}…`;
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="draggable flex h-12 items-center justify-between px-4 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
        <div className="flex items-center space-x-3 h-8 min-w-0">
          {isSidebarCollapsed && (
            <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
              <button
                type="button"
                onClick={onToggleSidebar}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
              </button>
              <button
                type="button"
                onClick={onNewChat}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <ComposeIcon className="h-4 w-4" />
              </button>
              {updateBadge}
            </div>
          )}
          <button
            onClick={onBack}
            className="non-draggable p-2 rounded-lg dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary transition-colors"
            aria-label={i18nService.t('back')}
          >
            <ArrowLeftIcon className="h-5 w-5" />
          </button>
          <h1 className="text-lg font-semibold dark:text-claude-darkText text-claude-text truncate">
            {detail.title}
          </h1>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${groupTaskStatusBadgeClass(detail.status)}`}>
            {i18nService.t(groupTaskStatusLabelKey(detail.status))}
          </span>
        </div>
        <div className="non-draggable flex items-center gap-2">
          {!isTerminal && (
            <>
              <button
                type="button"
                onClick={() => setConfirmAction('done')}
                className="px-3 py-1.5 text-sm font-medium rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 transition-colors"
              >
                {i18nService.t('groupTasksAcceptClose')}
              </button>
              <button
                type="button"
                onClick={() => setConfirmAction('cancelled')}
                className="px-3 py-1.5 text-sm font-medium rounded-lg text-red-500 border border-red-300 dark:border-red-500/40 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
              >
                {i18nService.t('groupTasksCancelTask')}
              </button>
            </>
          )}
          <WindowTitleBar inline />
        </div>
      </div>

      {/* Body: transcript column + right rail */}
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 flex flex-col min-w-0">
          {/* Goal / acceptance */}
          <div className="px-4 py-3 border-b dark:border-claude-darkBorder/50 border-claude-border/50 shrink-0">
            <p className="text-sm dark:text-claude-darkText text-claude-text whitespace-pre-wrap">
              {detail.goal}
            </p>
            {detail.acceptanceCriteria && (
              <details className="mt-1">
                <summary className="text-xs cursor-pointer dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text">
                  {i18nService.t('groupTasksFormAcceptance')}
                </summary>
                <p className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary whitespace-pre-wrap">
                  {detail.acceptanceCriteria}
                </p>
              </details>
            )}
            {isTerminal && (
              <p className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('groupTasksClosedState')}
                {detail.closedAt ? ` · ${formatGroupTaskTime(detail.closedAt)}` : ''}
              </p>
            )}
          </div>

          {/* Transcript */}
          <div
            ref={scrollRef}
            onScroll={handleTranscriptScroll}
            className="flex-1 overflow-y-auto py-2"
          >
            {loadingMessages && messages.length === 0 ? (
              <div className="flex items-center justify-center py-16">
                <div className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('loading')}
                </div>
              </div>
            ) : messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 px-6">
                <ChatBubbleLeftRightIcon className="h-10 w-10 dark:text-claude-darkTextSecondary/40 text-claude-textSecondary/40 mb-3" />
                <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {messagesError ?? i18nService.t('groupTasksTranscriptEmpty')}
                </p>
              </div>
            ) : (
              messages.map((message) => (
                <GroupTaskMessageItem
                  key={message.id}
                  message={message}
                  isChairSender={Boolean(
                    chairMember?.globalmetaid
                    && message.senderGlobalMetaId === chairMember.globalmetaid,
                  )}
                  isOwnerSender={Boolean(
                    ownerGlobalMetaId && message.senderGlobalMetaId === ownerGlobalMetaId,
                  )}
                />
              ))
            )}
          </div>

          {/* Composer (non-terminal only) */}
          {!isTerminal && (
            <div className="shrink-0 border-t dark:border-claude-darkBorder border-claude-border px-4 py-3">
              <div className="flex items-end gap-2">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void handleSend();
                    }
                  }}
                  rows={2}
                  className="flex-1 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-white px-3 py-2 text-sm dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/50 resize-none"
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
          )}
        </div>

        {/* Right rail */}
        <div className="w-60 shrink-0 border-l dark:border-claude-darkBorder border-claude-border overflow-y-auto">
          <div className="px-4 py-3 border-b dark:border-claude-darkBorder/50 border-claude-border/50">
            <h3 className="text-xs font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-2">
              {i18nService.t('groupTasksMembers')}
            </h3>
            <div className="space-y-1.5">
              {detail.members.map((member) => (
                <div key={member.id} className="flex items-center gap-2">
                  <span className="text-sm dark:text-claude-darkText text-claude-text truncate">
                    {member.name ?? `bot-${member.metabotId}`}
                  </span>
                  {member.role === 'chair' && (
                    <span className="shrink-0 rounded px-1 py-px text-[10px] font-medium leading-tight bg-claude-accent/15 text-claude-accent">
                      {i18nService.t('groupTasksChairBadge')}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="px-4 py-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-2">
              {i18nService.t('groupTasksDeliverables')}
            </h3>
            {detail.deliverables.length === 0 ? (
              <p className="text-xs dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                {i18nService.t('groupTasksNoDeliverables')}
              </p>
            ) : (
              <div className="space-y-2">
                {detail.deliverables.map((deliverable) => (
                  <div
                    key={deliverable.id}
                    className="rounded-lg border dark:border-claude-darkBorder/60 border-claude-border/60 px-2.5 py-2"
                  >
                    <div className="flex items-center gap-2">
                      {deliverable.kind && (
                        <span className="shrink-0 rounded px-1 py-px text-[10px] font-medium leading-tight dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary">
                          {deliverable.kind}
                        </span>
                      )}
                      <span className="text-[11px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                        {deliverable.status}
                      </span>
                    </div>
                    {deliverable.uri && (
                      /^https?:\/\//i.test(deliverable.uri) ? (
                        <a
                          href={deliverable.uri}
                          target="_blank"
                          rel="noreferrer"
                          className="block mt-1 text-xs text-claude-accent hover:underline break-all"
                        >
                          {deliverable.uri}
                        </a>
                      ) : (
                        <code className="block mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary break-all">
                          {deliverable.uri}
                        </code>
                      )
                    )}
                    <div className="mt-1 text-[11px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                      {deliverableAuthorName(deliverable.authorGlobalmetaid)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Close confirmation */}
      {confirmAction && (
        <GroupTaskCloseConfirmModal
          action={confirmAction}
          taskTitle={detail.title}
          closing={closing}
          onConfirm={() => void handleConfirmClose()}
          onCancel={() => {
            setConfirmAction(null);
            setCloseError(null);
          }}
        />
      )}
      {closeError && !confirmAction && (
        <div className="fixed bottom-4 right-4 z-[9998] rounded-lg bg-red-500 text-white text-sm px-4 py-2 shadow-lg">
          {closeError}
        </div>
      )}
    </div>
  );
};

export default GroupTaskDetailView;
