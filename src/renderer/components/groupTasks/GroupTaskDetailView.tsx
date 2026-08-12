import React, { useCallback, useEffect, useRef, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { groupTaskService } from '../../services/groupTaskService';
import type {
  GroupChatTranscriptMessage,
  GroupTaskDetail,
} from '../../types/groupTask';
import GroupTaskMessageItem from './GroupTaskMessageItem';
import GroupTaskCloseConfirmModal from './GroupTaskCloseConfirmModal';
import GroupTaskRatingStars from './GroupTaskRatingStars';
import GroupTaskKickConfirmModal from './GroupTaskKickConfirmModal';
import {
  canAcceptGroupTask,
  canReopenGroupTask,
  deliverableVerificationBadgeClass,
  deliverableVerificationState,
  formatGroupTaskTime,
  groupTaskMemberStatusBadgeClass,
  groupTaskMemberStatusLabel,
  groupTaskStatusBadgeClass,
  groupTaskWorkStatusLabelKey,
  isActiveGroupTaskStatus,
  mergeTranscriptMessages,
  shouldStickToBottom,
} from './groupTaskUtils';
import { groupTaskStatusLabelKey } from './GroupTasksView';
import { ArrowLeftIcon, ChatBubbleLeftRightIcon, XMarkIcon } from '@heroicons/react/24/outline';
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
  const [reopening, setReopening] = useState(false);
  const [reopenError, setReopenError] = useState<string | null>(null);
  // OpenTeam M3: member removal (kick) — target member + in-flight state.
  const [kickTarget, setKickTarget] = useState<GroupTaskDetail['members'][number] | null>(null);
  const [kicking, setKicking] = useState(false);
  const [kickError, setKickError] = useState<string | null>(null);
  // Optional kick reason (removeuser pin + [OPENTEAM_KICK] notification).
  const [kickReason, setKickReason] = useState('');
  // R2P1-2: surfaces when the kick held locally but the on-chain member list
  // has not confirmed the removal within the poll budget.
  const [kickChainConfirmPending, setKickChainConfirmPending] = useState(false);

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

  // Reset per-task transcript state when the parent reuses this component
  // instance for a different task (defensive: callers normally remount via
  // `key`, but an in-place taskId change must never show the previous task's
  // messages).
  useEffect(() => {
    setMessages([]);
    setMessagesError(null);
  }, [taskId]);

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

  // HITL: a checkpoint opening/resolving refreshes the detail (banner) and the
  // transcript (pause/resume ceremony lines).
  useEffect(() => {
    const api = window.electron?.groupTask;
    if (!api) return undefined;
    return api.onCheckpointChanged((event) => {
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

  const [reworking, setReworking] = useState(false);
  const [reworkError, setReworkError] = useState<string | null>(null);
  const handleRework = async () => {
    if (!detail || reworking) return;
    setReworking(true);
    setReworkError(null);
    try {
      const updated = await groupTaskService.reworkTask({ taskId, reason: 'Owner/chair requested supplementary work' });
      setDetail(updated);
    } catch (err) {
      setReworkError(err instanceof Error ? err.message : String(err));
    } finally {
      setReworking(false);
    }
  };

  const handleConfirmClose = async (rating?: number, ratingComment?: string) => {
    if (!confirmAction || !detail) return;
    setClosing(true);
    setCloseError(null);
    try {
      const updated = await groupTaskService.closeTask({ taskId, status: confirmAction, rating, ratingComment });
      setDetail(updated);
      setConfirmAction(null);
    } catch (err) {
      setCloseError(err instanceof Error ? err.message : String(err));
    } finally {
      setClosing(false);
    }
  };

  // P0-1: review -> executing 补充执行通道 (Back to work / 返回修改).
  const handleReopen = async () => {
    if (reopening || !detail) return;
    setReopening(true);
    setReopenError(null);
    try {
      const updated = await groupTaskService.reopenTask(taskId);
      setDetail(updated);
    } catch (err) {
      setReopenError(err instanceof Error ? err.message : String(err));
    } finally {
      setReopening(false);
    }
  };

  const handleConfirmKick = async () => {
    if (!kickTarget || !detail) return;
    setKicking(true);
    setKickError(null);
    try {
      const reason = kickReason.trim();
      const kicked = await groupTaskService.kickMember({
        taskId,
        metabotId: kickTarget.metabotId ?? undefined,
        globalmetaid: kickTarget.metabotId == null ? kickTarget.globalmetaid ?? undefined : undefined,
        reason: reason || undefined,
      });
      setKickTarget(null);
      setKickReason('');
      // R2P1-2: the local removal + announcement already hold; only warn that
      // the on-chain member list has not confirmed the removal yet.
      setKickChainConfirmPending(kicked.chainRemovalConfirmed === false);
      await refreshDetail();
    } catch (err) {
      setKickError(err instanceof Error ? err.message : String(err));
    } finally {
      setKicking(false);
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
  // HITL: the currently open human checkpoint, if any (drives the pause banner).
  const openCheckpoint = detail.checkpoints?.find((checkpoint) => checkpoint.status === 'open') ?? null;
  const chairMember = detail.members.find((member) => member.role === 'chair');
  const memberDisplayName = (member: GroupTaskDetail['members'][number]): string =>
    member.name ?? (member.metabotId != null
      ? `bot-${member.metabotId}`
      : member.globalmetaid
        ? `${member.globalmetaid.slice(0, 10)}…`
        : 'remote bot');
  // Remote members (metabotId == null) joined via OpenTeam; their messages are
  // matched by globalmetaid so the transcript can flag them.
  const remoteMemberGlobalMetaIds = new Set(
    detail.members
      .filter((member) => member.metabotId == null && member.globalmetaid)
      .map((member) => member.globalmetaid as string),
  );
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
              {canReopenGroupTask(detail.status) && (
                <button
                  type="button"
                  onClick={() => void handleReopen()}
                  disabled={reopening}
                  className="px-3 py-1.5 text-sm font-medium rounded-lg text-amber-600 dark:text-amber-400 border border-amber-300 dark:border-amber-500/40 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors disabled:opacity-50"
                >
                  {reopening ? i18nService.t('groupTasksReopening') : i18nService.t('groupTasksBackToWork')}
                </button>
              )}
              {canAcceptGroupTask(detail.status) && (
                <button
                  type="button"
                  onClick={() => setConfirmAction('done')}
                  className="px-3 py-1.5 text-sm font-medium rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 transition-colors"
                >
                  {i18nService.t('groupTasksAcceptClose')}
                </button>
              )}
              {canAcceptGroupTask(detail.status) && (
                <button
                  type="button"
                  onClick={() => void handleRework()}
                  className="px-3 py-1.5 text-sm font-medium rounded-lg bg-amber-500 text-white hover:bg-amber-600 transition-colors"
                  title="Move the task back to executing for supplementary work"
                >
                  {i18nService.t('groupTasksRework')}
                </button>
              )}
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
        {reworkError && (
          <div className="px-4 py-1 text-xs text-red-500">{reworkError}</div>
        )}
      </div>

      {/* Body: transcript column + right rail */}
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 flex flex-col min-w-0">
          {/* Goal / acceptance */}
          <div className="px-4 py-3 border-b dark:border-claude-darkBorder/50 border-claude-border/50 shrink-0">
            <p className="text-sm dark:text-claude-darkText text-claude-text whitespace-pre-wrap">
              {detail.goal}
            </p>
            {detail.status === 'review' && (
              <div className="mt-2 rounded-lg border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs dark:text-amber-200 text-amber-800">
                {i18nService.t('groupTasksReviewSilenceHint')}
              </div>
            )}
            {openCheckpoint && (
              <div className="mt-2 rounded-lg border border-sky-300 dark:border-sky-500/40 bg-sky-50 dark:bg-sky-900/20 px-3 py-2 text-xs dark:text-sky-200 text-sky-800">
                {i18nService
                  .t('groupTasksCheckpointBanner')
                  .replace('{topic}', openCheckpoint.topic?.trim() || i18nService.t('groupTasksCheckpointNoTopic'))}
              </div>
            )}
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
            {detail.status === 'done' && detail.rating != null && (
              <div className="mt-2 rounded-lg border dark:border-claude-darkBorder/60 border-claude-border/60 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('groupTasksYourRating')}
                  </span>
                  <GroupTaskRatingStars value={detail.rating} sizeClass="h-4 w-4" />
                  {detail.ratedAt && (
                    <span className="text-[11px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                      {formatGroupTaskTime(detail.ratedAt)}
                    </span>
                  )}
                </div>
                {detail.ratingComment && (
                  <p className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary whitespace-pre-wrap">
                    {detail.ratingComment}
                  </p>
                )}
              </div>
            )}
            {detail.driver && (
              <p className="mt-1 text-[11px] dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60">
                {i18nService.t('groupTasksDriverInfo')}
                {` ${detail.driver.instanceId.slice(0, 8)} · ${formatGroupTaskTime(detail.driver.atMs)}`}
              </p>
            )}
            {reopenError && (
              <p className="mt-1 text-xs text-red-500">{reopenError}</p>
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
                  isRemoteSender={Boolean(
                    message.senderGlobalMetaId
                    && remoteMemberGlobalMetaIds.has(message.senderGlobalMetaId),
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
                <>
                <div key={member.id} className="group flex items-center gap-2">
                  <span className="text-sm dark:text-claude-darkText text-claude-text truncate">
                    {memberDisplayName(member)}
                  </span>
                  {member.role === 'chair' && (
                    <span className="shrink-0 rounded px-1 py-px text-[10px] font-medium leading-tight bg-claude-accent/15 text-claude-accent">
                      {i18nService.t('groupTasksChairBadge')}
                    </span>
                  )}
                  {member.metabotId == null && (
                    <span className="shrink-0 rounded px-1 py-px text-[10px] font-medium leading-tight bg-green-500/15 text-green-600 dark:text-green-400">
                      {i18nService.t('groupTasksRemoteBadge')}
                    </span>
                  )}
                  {member.workStatus && member.workStatus !== 'unknown' && (
                    <span
                      className={`shrink-0 rounded px-1 py-px text-[10px] font-medium leading-tight ${
                        member.workStatus === 'working'
                          ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                          : member.workStatus === 'error'
                            ? 'bg-red-500/15 text-red-600 dark:text-red-400'
                            : 'bg-gray-500/10 text-gray-500 dark:text-gray-400'
                      }`}
                    >
                      {i18nService.t(groupTaskWorkStatusLabelKey(member.workStatus))}
                    </span>
                  )}
                  {member.status && (
                    <span
                      className={`shrink-0 rounded px-1 py-px text-[10px] font-medium leading-tight ${groupTaskMemberStatusBadgeClass(member.status)}`}
                      title={member.statusChangedAt
                        ? `Status changed ${formatGroupTaskTime(member.statusChangedAt)}`
                        : groupTaskMemberStatusLabel(member.status)}
                    >
                      {groupTaskMemberStatusLabel(member.status)}
                    </span>
                  )}
                  {/* M3: the owner may remove any non-chair member while the task is active. */}
                  {!isTerminal && member.role !== 'chair'
                    && (member.metabotId != null || member.globalmetaid) && (
                    <button
                      type="button"
                      onClick={() => {
                        setKickError(null);
                        setKickTarget(member);
                      }}
                      title={i18nService.t('groupTasksRemoveMember')}
                      aria-label={i18nService.t('groupTasksRemoveMember')}
                      className="ml-auto shrink-0 hidden group-hover:inline-flex h-5 w-5 items-center justify-center rounded dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                    >
                      <XMarkIcon className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                {member.lastSpeakAt != null && (
                  <div className="text-[10px] leading-tight dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60 pl-0.5">
                    last spoke {formatGroupTaskTime(member.lastSpeakAt)}
                  </div>
                )}
                </>
              ))}
            </div>
          </div>
          <div className="px-4 py-3 border-b dark:border-claude-darkBorder/50 border-claude-border/50">
            <details>
              <summary className="text-xs font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary cursor-pointer mb-2">
                {i18nService.t('groupTasksStatusHistory')}
              </summary>
              {(detail.statusEvents ?? []).length === 0 ? (
                <p className="text-xs dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60">
                  {i18nService.t('groupTasksNoStatusEvents')}
                </p>
              ) : (
                <div className="space-y-1.5">
                  {(detail.statusEvents ?? []).map((event) => (
                    <div key={event.id} className="text-[11px] leading-snug">
                      <span className="dark:text-claude-darkText text-claude-text">
                        {event.fromStatus} → {event.toStatus}
                      </span>
                      <span className="dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                        {` · ${event.actorName ?? event.actorKind} · ${formatGroupTaskTime(event.createdAt)}`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </details>
          </div>

          <div className="px-4 py-3 border-t dark:border-claude-darkBorder/50 border-claude-border/50">
            <h3 className="text-xs font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-2">
              Transitions
            </h3>
            {(detail.transitions ?? []).length === 0 ? (
              <p className="text-xs dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                No transitions yet
              </p>
            ) : (
              <div className="space-y-1.5">
                {(detail.transitions ?? []).map((transition) => (
                  <div key={transition.id} className="text-[11px] leading-tight dark:text-claude-darkTextSecondary/80 text-claude-textSecondary/80">
                    <span className="font-medium dark:text-claude-darkText text-claude-text">
                      {(transition.fromStatus ?? '—')} → {transition.toStatus}
                    </span>
                    {transition.reason ? ` — ${transition.reason}` : ''}
                    <div className="text-[10px] opacity-70">
                      {transition.actor ?? 'system'} · {formatGroupTaskTime(transition.createdAt)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="px-4 py-3 border-t dark:border-claude-darkBorder/50 border-claude-border/50">
            <h3 className="text-xs font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-2">
              Integrity events
            </h3>
            {(detail.integrityEvents ?? []).length === 0 ? (
              <p className="text-xs dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                No integrity events yet
              </p>
            ) : (
              <div className="space-y-1.5">
                {(detail.integrityEvents ?? []).map((event) => (
                  <div key={event.id} className="text-[11px] leading-tight dark:text-claude-darkTextSecondary/80 text-claude-textSecondary/80">
                    <span className={`font-medium ${event.eventType === 'correction' ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                      {event.eventType === 'correction' ? 'correction' : 'honest report'}
                    </span>
                    <div className="text-[10px] opacity-80 line-clamp-2">{event.detail ?? ''}</div>
                    <div className="text-[10px] opacity-70">{formatGroupTaskTime(event.createdAt)}</div>
                  </div>
                ))}
              </div>
            )}
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
                      <span
                        className="text-[11px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70"
                        title={
                          deliverable.status === 'pending'
                            ? 'pending = 已提交，待 owner 验收（与链上确认是两个独立维度）'
                            : deliverable.status === 'accepted'
                              ? 'accepted = 已通过 owner 验收'
                              : 'rejected = 已被拒绝'
                        }
                      >
                        {deliverable.status === 'pending' ? '待验收' : deliverable.status === 'accepted' ? '已验收' : '已拒绝'}
                      </span>
                      {(() => {
                        // Issue #8: on-chain confirmation is a ledger state
                        // driven by multi-source verification, shown
                        // separately from the acceptance status above. For
                        // legacy rows still awaiting a verification pass,
                        // fall back to the verification-report detail.
                        if (deliverable.confirmation === 'confirmed') {
                          return (
                            <span
                              className="shrink-0 rounded px-1 py-px text-[10px] font-medium leading-tight bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                              title={deliverable.verification ?? '链上多源验证通过'}
                            >
                              链上已确认
                            </span>
                          );
                        }
                        const state = deliverableVerificationState(deliverable.verification);
                        if (state === 'unknown') return null;
                        return (
                          <span
                            className={`shrink-0 rounded px-1 py-px text-[10px] font-medium leading-tight ${deliverableVerificationBadgeClass(state)}`}
                            title={deliverable.verification ?? ''}
                          >
                            {state === 'verified' ? 'on-chain ✓' : state === 'pending-sync' ? 'pending sync' : 'unverified'}
                          </span>
                        );
                      })()}
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

      {/* Close confirmation (accept = rate + close, cancel = plain confirm) */}
      {confirmAction && (
        <GroupTaskCloseConfirmModal
          action={confirmAction}
          taskTitle={detail.title}
          closing={closing}
          error={closeError}
          onConfirm={(rating, ratingComment) => void handleConfirmClose(rating, ratingComment)}
          onCancel={() => {
            setConfirmAction(null);
            setCloseError(null);
          }}
        />
      )}
      {/* Member removal confirmation */}
      {kickTarget && (
        <GroupTaskKickConfirmModal
          memberName={memberDisplayName(kickTarget)}
          kicking={kicking}
          error={kickError}
          reason={kickReason}
          onReasonChange={setKickReason}
          onConfirm={() => void handleConfirmKick()}
          onCancel={() => {
            setKickTarget(null);
            setKickError(null);
            setKickReason('');
          }}
        />
      )}
      {kickChainConfirmPending && !kickTarget && (
        <div
          className="fixed bottom-4 right-4 z-[9998] rounded-lg bg-amber-500 text-white text-sm px-4 py-2 shadow-lg cursor-pointer"
          onClick={() => setKickChainConfirmPending(false)}
        >
          {i18nService.t('groupTasksKickChainConfirmPending')}
        </div>
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
