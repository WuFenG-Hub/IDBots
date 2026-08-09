import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useSelector } from 'react-redux';
import { i18nService } from '../../services/i18n';
import { coworkService } from '../../services/cowork';
import { RootState } from '../../store';
import type { CoworkMessage, SubagentTaskState, SubagentTaskStatus } from '../../types/cowork';

interface SubagentPanelProps {
  /** Current session id; enables the post-hoc transcript viewer. */
  sessionId?: string;
  disabled?: boolean;
  /** Hide stop/background controls (e.g. sandbox sessions have no host-side SDK control). */
  disableControls?: boolean;
}

/** Post-hoc subagent entry from listSubagents, merged with live tasks. */
interface SubagentEntry {
  key: string;
  agentId?: string;
  task?: SubagentTaskState;
}

const STATUS_ICON: Record<SubagentTaskStatus, string> = {
  pending: '⏳',
  running: '🟢',
  completed: '✅',
  failed: '❌',
  stopped: '⏹️',
  killed: '⏹️',
  paused: '⏸️',
};

const formatDuration = (ms?: number): string | null => {
  if (ms == null || !Number.isFinite(ms)) return null;
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m${rest > 0 ? ` ${rest}s` : ''}`;
};

const formatTokens = (value?: number): string | null => {
  if (value == null || !Number.isFinite(value)) return null;
  return `${value.toLocaleString('en-US')} tokens`;
};

/**
 * Live subagent / background-task activity panel. A header button opens an
 * anchored popover listing every subagent the session has spawned (driven by
 * SDK task_started / task_progress / task_notification / task_updated /
 * tool_progress events). Each row shows type badge, description, status icon,
 * duration, token usage, AI summary (agentProgressSummaries) and the last tool.
 */
const SubagentPanel: React.FC<SubagentPanelProps> = ({ sessionId, disabled = false, disableControls = false }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [postHocAgents, setPostHocAgents] = useState<string[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const tasks = useSelector((state: RootState) => state.cowork.subagentTasks);

  // Only tasks belonging to the current session (the Redux map is global
  // across sessions). Tasks without a sessionId (legacy events) are kept.
  const taskList = Object.values(tasks)
    .filter((task) => !sessionId || !task.sessionId || task.sessionId === sessionId)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));

  // Load post-hoc subagent ids from disk (listSubagents) on mount and whenever
  // the session changes — this decides whether the trigger is visible at all
  // (a session that previously spawned subagents keeps the button even after
  // live tasks are cleared). Post-hoc entries may not correlate 1:1 with live
  // task ids (task_id != agentId), so they appear as additional rows.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    void coworkService.getSubagents(sessionId).then((agents) => {
      if (!cancelled) setPostHocAgents(agents);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // Hide the trigger entirely while this session has no subagent activity —
  // no live tasks AND no post-hoc transcripts. The button only appears once
  // a subagent has actually run.
  if (taskList.length === 0 && postHocAgents.length === 0) {
    return null;
  }

  const runningCount = taskList.filter((t) => t.status === 'running' || t.status === 'pending').length;

  // Merge live tasks and post-hoc agents into one list. Post-hoc agents that
  // match a live task's transcript path are deduped by key.
  const entries: SubagentEntry[] = [
    ...taskList.map<SubagentEntry>((task) => ({ key: `task-${task.taskId}`, task })),
    ...postHocAgents.map<SubagentEntry>((agentId) => ({ key: `agent-${agentId}`, agentId })),
  ];

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 rounded-lg border dark:border-claude-darkBorder border-claude-border px-2 py-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:bg-claude-darkSurfaceInset hover:bg-claude-surfaceInset transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        title={i18nService.t('coworkSubagentPanelTitle')}
      >
        <span className="text-[11px]">🛠️</span>
        <span className="font-medium">{i18nService.t('coworkSubagentPanelLabel')}</span>
        {runningCount > 0 && (
          <span className="rounded-full bg-claude-accent/15 text-claude-accent px-1.5 text-[10px] font-semibold">
            {runningCount}
          </span>
        )}
        {taskList.length > 0 && (
          <span className="rounded-full dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset px-1.5 text-[10px] font-semibold">
            {taskList.length}
          </span>
        )}
      </button>
      {isOpen && (
        <div className="absolute right-0 bottom-full mb-2 w-80 rounded-xl shadow-xl dark:bg-claude-darkBg bg-claude-bg dark:border-claude-darkBorder border-claude-border border z-50 flex flex-col max-h-[60vh]">
          <div className="px-3 py-2 border-b dark:border-claude-darkBorder/60 border-claude-border/60 flex items-center justify-between">
            <span className="text-xs font-semibold dark:text-claude-darkText text-claude-text">
              {i18nService.t('coworkSubagentPanelTitle')}
            </span>
            <span className="text-[10px] dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60">
              {entries.length > 0
                ? i18nService.t('coworkSubagentCount').replace('{count}', String(entries.length))
                : i18nService.t('coworkSubagentNone')}
            </span>
          </div>
          <div className="overflow-y-auto flex-1 p-2 space-y-1.5">
            {entries.length === 0 ? (
              <div className="px-2 py-4 text-center text-[11px] dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60">
                {i18nService.t('coworkSubagentEmpty')}
              </div>
            ) : (
              entries.map((entry) => (
                <SubagentTaskRow
                  key={entry.key}
                  task={entry.task}
                  agentId={entry.agentId}
                  sessionId={sessionId}
                  disableControls={disableControls}
                />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const SubagentTaskRow: React.FC<{
  task?: SubagentTaskState;
  agentId?: string;
  sessionId?: string;
  disableControls?: boolean;
}> = ({ task, agentId, sessionId, disableControls = false }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [transcript, setTranscript] = useState<CoworkMessage[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionInFlight, setActionInFlight] = useState<'stop' | 'background' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const canControl = Boolean(
    !disableControls
    && sessionId
    && task
    && (task.status === 'running' || task.status === 'pending' || task.status === 'paused')
  );
  const canBackground = Boolean(
    canControl
    && task
    && !task.isBackgrounded
    && task.toolUseId
  );

  const runAction = async (action: 'stop' | 'background') => {
    if (!sessionId || !task) return;
    setActionInFlight(action);
    setActionError(null);
    const result = action === 'stop'
      ? await coworkService.stopTask(sessionId, task.taskId)
      : await coworkService.backgroundTask(sessionId, task.toolUseId);
    setActionInFlight(null);
    if (!result.success) {
      setActionError(result.error ?? i18nService.t(
        action === 'stop' ? 'coworkSubagentStopFailed' : 'coworkSubagentBackgroundFailed'
      ));
    }
  };

  const duration = task
    ? formatDuration(task.usage?.durationMs ?? (task.startedAt && task.updatedAt ? task.updatedAt - task.startedAt : undefined))
    : null;
  const tokens = task ? formatTokens(task.usage?.totalTokens) : null;
  // Prefer the subagent type for Task-tool subagents; fall back to the task
  // type (shell / monitor / workflow / local_workflow) for non-subagent tasks.
  const typeLabel = task?.subagentType ?? task?.taskType ?? (task?.workflowName ? 'workflow' : 'subagent');
  const titleText = task
    ? (task.description || task.prompt || task.taskId.slice(0, 8))
    : (agentId ?? 'subagent');
  const canViewTranscript = Boolean(sessionId && agentId);

  const toggleTranscript = useCallback(async () => {
    if (!sessionId || !agentId) return;
    if (isExpanded) {
      setIsExpanded(false);
      return;
    }
    setIsExpanded(true);
    if (transcript === null) {
      setIsLoading(true);
      setLoadError(null);
      try {
        const messages = await coworkService.getSubagentMessages(sessionId, agentId, 200);
        setTranscript(messages);
        if (messages.length === 0) {
          setLoadError(i18nService.t('coworkSubagentTranscriptEmpty'));
        }
      } catch {
        setLoadError(i18nService.t('coworkSubagentTranscriptFailed'));
      } finally {
        setIsLoading(false);
      }
    }
  }, [sessionId, agentId, isExpanded, transcript]);

  return (
    <div className="rounded-lg px-2.5 py-2 dark:bg-claude-darkSurfaceInset/60 bg-claude-surfaceInset/60 dark:border dark:border-claude-darkBorder/50 border border-claude-border/50">
      <div className="flex items-center gap-2">
        <span className="text-[11px]">{task ? (STATUS_ICON[task.status] ?? '•') : '📄'}</span>
        {task?.isBackgrounded && (
          <span
            className="inline-flex items-center rounded-md bg-claude-accent/10 px-1 py-0.5 text-[10px] font-semibold text-claude-accent"
            title={i18nService.t('coworkBackgroundedLabel')}
          >
            ⏸️ {i18nService.t('coworkBackgroundedLabel')}
          </span>
        )}
        <span className="inline-flex items-center rounded-md bg-claude-accent/10 px-1.5 py-0.5 text-[10px] font-semibold text-claude-accent max-w-[40%] truncate">
          {typeLabel}
        </span>
        <span className="flex-1 min-w-0 text-xs dark:text-claude-darkText text-claude-text truncate">
          {titleText}
        </span>
        {canViewTranscript && (
          <button
            type="button"
            onClick={() => void toggleTranscript()}
            className="flex-shrink-0 text-[10px] font-medium dark:text-claude-darkTextSecondary/80 text-claude-textSecondary/80 hover:text-claude-accent dark:hover:text-claude-accent transition-colors"
            title={i18nService.t('coworkSubagentTranscriptTitle')}
          >
            {isExpanded ? '−' : '+'}
          </button>
        )}
      </div>
      {(task?.summary || task?.lastToolName || duration || tokens) && (
        <div className="mt-1.5 space-y-0.5">
          {task?.summary && (
            <div className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary leading-relaxed">
              {task.summary}
            </div>
          )}
          <div className="flex items-center gap-2 text-[10px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
            {task?.lastToolName && (
              <span className="font-mono truncate">{task.lastToolName}</span>
            )}
            {duration && <span>⏱ {duration}</span>}
            {tokens && <span>∑ {tokens}</span>}
          </div>
        </div>
      )}
      {canControl && (
        <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            disabled={actionInFlight !== null}
            onClick={() => void runAction('stop')}
            className="inline-flex items-center gap-1 rounded-md border dark:border-claude-darkBorder border-claude-border px-1.5 py-0.5 text-[10px] font-medium text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={i18nService.t('coworkSubagentStop')}
          >
            {actionInFlight === 'stop' ? '…' : '⏹'} {i18nService.t('coworkSubagentStop')}
          </button>
          {canBackground && (
            <button
              type="button"
              disabled={actionInFlight !== null}
              onClick={() => void runAction('background')}
              className="inline-flex items-center gap-1 rounded-md border dark:border-claude-darkBorder border-claude-border px-1.5 py-0.5 text-[10px] font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:bg-claude-darkSurfaceInset hover:bg-claude-surfaceInset transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title={i18nService.t('coworkSubagentBackground')}
            >
              {actionInFlight === 'background' ? '…' : '⏸'} {i18nService.t('coworkSubagentBackground')}
            </button>
          )}
        </div>
      )}
      {actionError && (
        <div className="mt-1.5 text-[10px] text-red-500 dark:text-red-400">
          {actionError}
        </div>
      )}
      {isExpanded && (
        <div className="mt-2 border-t dark:border-claude-darkBorder/40 border-claude-border/40 pt-2">
          {isLoading ? (
            <div className="text-[11px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
              {i18nService.t('coworkSubagentTranscriptLoading')}
            </div>
          ) : loadError ? (
            <div className="text-[11px] text-red-500 dark:text-red-400">{loadError}</div>
          ) : transcript && transcript.length > 0 ? (
            <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
              {transcript.map((msg) => (
                <div
                  key={msg.id}
                  className={`text-[11px] leading-relaxed ${
                    msg.type === 'assistant' && msg.metadata?.isThinking
                      ? 'dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60 italic'
                      : msg.type === 'tool_use'
                        ? 'dark:text-claude-darkTextSecondary/80 text-claude-textSecondary/80 font-mono'
                        : msg.type === 'tool_result'
                          ? 'dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60'
                          : 'dark:text-claude-darkText text-claude-text'
                  }`}
                >
                  {msg.type === 'user' && <span className="font-medium text-claude-accent">User: </span>}
                  {msg.type === 'assistant' && !msg.metadata?.isThinking && <span className="font-medium">Assistant: </span>}
                  {msg.type === 'tool_use' && (
                    <span className="font-medium">🔧 {msg.metadata?.toolName}: </span>
                  )}
                  {msg.type === 'tool_result' && <span className="font-medium">📥 Result: </span>}
                  {msg.content.length > 300 ? `${msg.content.slice(0, 300)}…` : msg.content}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[11px] dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60">
              {i18nService.t('coworkSubagentTranscriptEmpty')}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default SubagentPanel;
