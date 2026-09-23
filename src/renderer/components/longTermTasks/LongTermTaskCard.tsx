import React from 'react';
import { i18nService } from '../../services/i18n';
import type { LongTermColumn, LongTermTaskSummary } from '../../types/longTermTask';
import ParticipantAvatars from './ParticipantAvatars';

/**
 * One long-term task card on the status-column kanban. Content follows the
 * frozen prototype (docs/design/long-term-task-board-prototype.html): title,
 * sub-project progress bar (x/n), current stage, next action, timestamps.
 */

const COLUMN_BAR_CLASS: Record<LongTermColumn, string> = {
  waiting_owner: 'bg-amber-400',
  in_progress: 'bg-sky-400',
  waiting_external: 'bg-violet-400',
  defining: 'bg-claude-textSecondary dark:bg-claude-darkTextSecondary',
  paused: 'bg-zinc-500',
  done: 'bg-emerald-400',
};

export function formatRelativeTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const diff = Date.now() - ms;
  if (diff < 60_000) return i18nService.t('longTermTask.justNow');
  if (diff < 3_600_000) return i18nService.t('longTermTask.minutesAgo').replace('{n}', String(Math.floor(diff / 60_000)));
  if (diff < 86_400_000) return i18nService.t('longTermTask.hoursAgo').replace('{n}', String(Math.floor(diff / 3_600_000)));
  return i18nService.t('longTermTask.daysAgo').replace('{n}', String(Math.floor(diff / 86_400_000)));
}

export function formatAbsDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  try {
    return new Date(ms).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
  } catch {
    return iso;
  }
}

/** The "next step" line under the current stage (renderer composes, main supplies facts). */
export function nextActionText(card: LongTermTaskSummary): string {
  const note = card.currentWaitNote ?? '';
  switch (card.currentSubtaskStatus) {
    case 'waiting_owner':
      return i18nService.t('longTermTask.next.waitingOwner').replace('{note}', note);
    case 'waiting_external':
      return i18nService.t('longTermTask.next.waitingExternal').replace('{note}', note);
    case 'in_progress':
      return i18nService.t('longTermTask.next.inProgress');
    default:
      return card.stage === 'defining'
        ? i18nService.t('longTermTask.next.defining')
        : i18nService.t('longTermTask.next.inProgress');
  }
}

const LongTermTaskCard: React.FC<{ card: LongTermTaskSummary; onOpen: (taskId: string) => void }> = ({ card, onOpen }) => {
  const isWaitingOwner = card.column === 'waiting_owner';
  const dimmed = card.column === 'paused' || card.column === 'done';
  return (
    <button
      type="button"
      onClick={() => onOpen(card.id)}
      className={`w-full rounded-lg border p-3 text-left transition dark:bg-claude-darkSurface bg-claude-surface ${
        isWaitingOwner
          ? 'border-amber-500/40 hover:border-amber-400/70'
          : 'dark:border-claude-darkBorder border-claude-border hover:border-brand/60'
      } ${dimmed ? 'opacity-75 hover:opacity-100' : ''} ${card.column === 'defining' ? 'border-dashed' : ''}`}
    >
      <div className="flex items-start gap-2">
        <h3 className="flex-1 text-[13px] font-semibold leading-snug dark:text-claude-darkText text-claude-text">{card.title}</h3>
        <ParticipantAvatars participants={card.participants} size="sm" />
      </div>
      <div className="mt-2 h-1.5 w-full rounded-full dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover">
        <div className={`h-1.5 rounded-full ${COLUMN_BAR_CLASS[card.column]}`} style={{ width: `${card.progress.percent}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
        <span>
          {i18nService.t('longTermTask.progressCounts')
            .replace('{accepted}', String(card.progress.accepted))
            .replace('{active}', String(card.counts.in_progress + card.counts.waiting_owner + card.counts.waiting_external))
            .replace('{pending}', String(card.counts.pending))}
        </span>
        <span>{i18nService.t('longTermTask.progress').replace('{accepted}', String(card.progress.accepted)).replace('{total}', String(card.progress.total))}</span>
      </div>
      {card.currentSubtaskTitle && (
        <div className="mt-2 rounded-md px-2.5 py-1.5 dark:bg-claude-darkSurfaceHover/70 bg-claude-surfaceHover/70">
          <div className="text-xs dark:text-claude-darkText text-claude-text">
            {i18nService.t('longTermTask.currentPrefix').replace('{title}', card.currentSubtaskTitle)}
          </div>
          <div className={`mt-0.5 text-[11px] ${isWaitingOwner ? 'text-amber-600 dark:text-amber-400' : 'dark:text-claude-darkTextSecondary text-claude-textSecondary'}`}>
            {i18nService.t('longTermTask.nextPrefix').replace('{action}', nextActionText(card))}
          </div>
        </div>
      )}
      <div className="mt-2 flex items-center justify-between text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
        <span>{i18nService.t('longTermTask.updatedAt').replace('{time}', formatRelativeTime(card.updatedAt))}</span>
        <span>{i18nService.t('longTermTask.createdAt').replace('{time}', formatAbsDate(card.createdAt))}</span>
      </div>
    </button>
  );
};

export default LongTermTaskCard;
