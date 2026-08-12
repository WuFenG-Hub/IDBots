import React, { useMemo, useRef, useState, useEffect } from 'react';
import { i18nService } from '../../services/i18n';
import type { CoworkMessage } from '../../types/cowork';
import {
  buildSessionTodoList,
  getTodoSummary,
  type TodoListItem,
  type TodoStatus,
} from './coworkTodoList';

interface TodoPanelProps {
  /** Messages of the current session; the task list is derived from them. */
  messages: CoworkMessage[];
}

const STATUS_ICON: Record<TodoStatus, string> = {
  completed: '✓',
  in_progress: '●',
  pending: '○',
  unknown: '·',
};

const getStatusCheckboxClass = (status: TodoStatus): string => {
  switch (status) {
    case 'completed':
      return 'bg-green-500/10 border-green-500 text-green-500';
    case 'in_progress':
      return 'bg-transparent border-blue-500 text-blue-500';
    case 'pending':
    case 'unknown':
    default:
      return 'bg-transparent dark:border-claude-darkTextSecondary/60 border-claude-textSecondary/60 text-transparent';
  }
};

const TodoRow: React.FC<{ item: TodoListItem; index: number }> = ({ item, index }) => {
  const isInProgress = item.status === 'in_progress';
  return (
    <div
      className={`flex items-start gap-2 rounded-md px-2 py-1.5 ${
        isInProgress ? 'dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset' : ''
      }`}
    >
      <span
        className={`mt-0.5 h-4 w-4 rounded-[4px] border flex-shrink-0 inline-flex items-center justify-center text-[10px] leading-none ${getStatusCheckboxClass(item.status)}`}
      >
        {STATUS_ICON[item.status]}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          {isInProgress && (
            <span className="inline-flex items-center rounded-md bg-blue-500/10 px-1 py-0.5 text-[10px] font-semibold text-blue-600 dark:text-blue-400">
              {i18nService.t('coworkTodoCurrentStep')}
            </span>
          )}
          <span className={`text-xs whitespace-pre-wrap break-words leading-5 ${
            item.status === 'completed'
              ? 'dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/80 line-through'
              : isInProgress
                ? 'dark:text-claude-darkText text-claude-text font-medium'
                : 'dark:text-claude-darkText text-claude-text'
          }`}>
            {item.primaryText}
          </span>
          {item.owner && (
            <span className="inline-flex items-center rounded-md bg-claude-accent/10 px-1 py-0.5 text-[10px] font-medium text-claude-accent">
              {i18nService.t('coworkTodoAssignedTo')} {item.owner}
            </span>
          )}
        </div>
        {item.secondaryText && (
          <div className="text-[11px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70 whitespace-pre-wrap break-words leading-5 mt-0.5">
            {item.secondaryText}
          </div>
        )}
      </div>
      <span className="flex-shrink-0 text-[10px] dark:text-claude-darkTextSecondary/50 text-claude-textSecondary/50 font-mono mt-0.5">
        {index + 1}
      </span>
    </div>
  );
};

/**
 * Persistent working-plan panel for the current session. The SDK expresses the
 * task/todo list through TodoWrite / TaskCreate / TaskUpdate tool calls; we
 * derive the latest list from the session messages and show it as a live
 * step list (completed / current / pending), mirroring what other coding-agent
 * UIs call a "todo list".
 */
const TodoPanel: React.FC<TodoPanelProps> = ({ messages }) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => buildSessionTodoList(messages), [messages]);
  const summary = useMemo(() => getTodoSummary(items), [items]);

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

  // Hide the trigger entirely until the model actually creates a task list.
  if (items.length === 0) {
    return null;
  }

  const progressPercent = summary.total > 0
    ? Math.round((summary.completed / summary.total) * 100)
    : 0;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        className="flex items-center gap-1 rounded-lg border dark:border-claude-darkBorder border-claude-border px-2 py-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:bg-claude-darkSurfaceInset hover:bg-claude-surfaceInset transition-colors"
        title={i18nService.t('coworkTodoPanelTitle')}
        aria-expanded={isOpen}
      >
        <span className="text-[11px]">📋</span>
        <span className="font-medium">{i18nService.t('coworkTodoPanelLabel')}</span>
        <span className="rounded-md bg-claude-accent/10 px-1 py-0.5 text-[10px] font-semibold text-claude-accent">
          {summary.completed}/{summary.total}
        </span>
      </button>

      {isOpen && (
        <div className="absolute right-0 bottom-full mb-2 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-xl">
          <div className="flex items-center justify-between px-3 pt-3 pb-2">
            <span className="text-xs font-semibold dark:text-claude-darkText text-claude-text">
              {i18nService.t('coworkTodoPanelTitle')}
            </span>
            <span className="text-[10px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
              {summary.completed}/{summary.total} · {progressPercent}%
            </span>
          </div>
          <div className="px-3 pb-2">
            <div className="h-1 rounded-full dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset overflow-hidden">
              <div
                className="h-full rounded-full bg-green-500/80 transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
          <div className="px-2 pb-2 max-h-72 overflow-y-auto space-y-0.5">
            {items.map((item, index) => (
              <TodoRow key={item.key} item={item} index={index} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default TodoPanel;
