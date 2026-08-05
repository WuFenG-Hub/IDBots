import React, { useState, useRef, useEffect } from 'react';
import { useSelector } from 'react-redux';
import { i18nService } from '../../services/i18n';
import { RootState } from '../../store';
import type { SubagentTaskState, SubagentTaskStatus } from '../../types/cowork';

interface SubagentPanelProps {
  disabled?: boolean;
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
const SubagentPanel: React.FC<SubagentPanelProps> = ({ disabled = false }) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const tasks = useSelector((state: RootState) => state.cowork.subagentTasks);
  const taskList = Object.values(tasks).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));

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

  const runningCount = taskList.filter((t) => t.status === 'running' || t.status === 'pending').length;

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
              {taskList.length > 0
                ? i18nService.t('coworkSubagentCount').replace('{count}', String(taskList.length))
                : i18nService.t('coworkSubagentNone')}
            </span>
          </div>
          <div className="overflow-y-auto flex-1 p-2 space-y-1.5">
            {taskList.length === 0 ? (
              <div className="px-2 py-4 text-center text-[11px] dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60">
                {i18nService.t('coworkSubagentEmpty')}
              </div>
            ) : (
              taskList.map((task) => (
                <SubagentTaskRow key={task.taskId} task={task} />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const SubagentTaskRow: React.FC<{ task: SubagentTaskState }> = ({ task }) => {
  const duration = formatDuration(task.usage?.durationMs ?? (task.startedAt && task.updatedAt ? task.updatedAt - task.startedAt : undefined));
  const tokens = formatTokens(task.usage?.totalTokens);
  const typeLabel = task.subagentType ?? task.taskType ?? 'task';

  return (
    <div className="rounded-lg px-2.5 py-2 dark:bg-claude-darkSurfaceInset/60 bg-claude-surfaceInset/60 dark:border dark:border-claude-darkBorder/50 border border-claude-border/50">
      <div className="flex items-center gap-2">
        <span className="text-[11px]">{STATUS_ICON[task.status] ?? '•'}</span>
        <span className="inline-flex items-center rounded-md bg-claude-accent/10 px-1.5 py-0.5 text-[10px] font-semibold text-claude-accent max-w-[40%] truncate">
          {typeLabel}
        </span>
        <span className="flex-1 min-w-0 text-xs dark:text-claude-darkText text-claude-text truncate">
          {task.description || task.prompt || task.taskId.slice(0, 8)}
        </span>
      </div>
      {(task.summary || task.lastToolName || duration || tokens) && (
        <div className="mt-1.5 space-y-0.5">
          {task.summary && (
            <div className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary leading-relaxed">
              {task.summary}
            </div>
          )}
          <div className="flex items-center gap-2 text-[10px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
            {task.lastToolName && (
              <span className="font-mono truncate">{task.lastToolName}</span>
            )}
            {duration && <span>⏱ {duration}</span>}
            {tokens && <span>∑ {tokens}</span>}
          </div>
        </div>
      )}
    </div>
  );
};

export default SubagentPanel;
