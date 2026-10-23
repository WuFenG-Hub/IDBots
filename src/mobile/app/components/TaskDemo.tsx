import { t } from '../../i18n';
import { formatTime } from '../format';
import { useScheduledTasks } from '../hooks/useScheduledTasks';

/** Scheduled-task demo: fixture tasks plus the run the mock fires on a timer. */
export function TaskDemo(): JSX.Element {
  const { tasks, runs } = useScheduledTasks();

  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {tasks.map((task) => (
          <li
            key={task.id}
            className="flex items-start justify-between gap-3 rounded-xl border border-[var(--border-color)] p-3"
          >
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-[var(--text-primary)]">{task.name}</div>
              <div className="text-xs text-[var(--text-secondary)]">
                {task.state.lastRunAtMs
                  ? t('mobile.demo.lastStatus', { status: t(`mobile.demo.runStatus.${task.state.lastStatus ?? 'skipped'}`) })
                  : t('mobile.demo.neverRun')}
              </div>
              {task.enabled ? (
                <div className="text-xs text-[var(--text-secondary)]">
                  {t('mobile.demo.nextRun', { time: formatTime(task.state.nextRunAtMs) })}
                </div>
              ) : null}
            </div>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${
                task.enabled ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-200 text-gray-600'
              }`}
            >
              {task.enabled ? t('mobile.demo.enabled') : t('mobile.demo.disabled')}
            </span>
          </li>
        ))}
      </ul>

      <div>
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
          {t('mobile.demo.runHistory')}
        </div>
        {runs.length === 0 ? (
          <div className="text-xs text-[var(--text-secondary)]">{t('mobile.demo.noRuns')}</div>
        ) : (
          <ul className="space-y-1">
            {runs.map((run) => (
              <li key={run.id} className="flex items-center justify-between rounded-lg bg-[var(--bg-main)] px-3 py-2 text-xs">
                <span className="text-[var(--text-primary)]">
                  {t(`mobile.demo.runStatus.${run.status}`)}
                </span>
                <span className="text-[var(--text-secondary)]">
                  {t(`mobile.demo.trigger.${run.trigger}`)} · {formatTime(Date.parse(run.startedAt))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
