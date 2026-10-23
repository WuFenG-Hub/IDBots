import { useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon, PlayIcon, PlusIcon } from '@heroicons/react/24/outline';
import { t } from '../../i18n';
import type { ScheduledTask, ScheduledTaskRun } from '../../bridge/types';
import { useScheduledTasks } from '../hooks/useScheduledTasks';
import { formatDurationMs, formatRunTime } from '../format';
import { BottomSheet } from '../components/BottomSheet';
import { Section } from '../components/Section';
import { Switch } from '../components/Switch';

type ScheduleKind = 'interval' | 'daily';

const LAST_STATUS_KEY: Record<'success' | 'error' | 'running', string> = {
  success: 'mobile.tasks.statusLabel.success',
  error: 'mobile.tasks.statusLabel.error',
  running: 'mobile.tasks.statusLabel.running',
};

function runStatusKey(status: ScheduledTaskRun['status']): string {
  return `mobile.tasks.runStatus.${status}`;
}

function TaskRuns({ taskId, runs }: { taskId: string; runs: ScheduledTaskRun[] }): JSX.Element {
  return (
    <div className="mt-2 border-t border-[var(--border-color)] pt-2" data-testid={`task-runs-${taskId}`}>
      <p className="mb-1 text-xs font-medium uppercase text-[var(--text-secondary)]">
        {t('mobile.tasks.historyTitle')}
      </p>
      {runs.length === 0 ? (
        <p className="py-2 text-sm text-[var(--text-secondary)]">{t('mobile.tasks.noRuns')}</p>
      ) : (
        runs.map((run) => (
          <div key={run.id} className="flex items-center justify-between border-b border-[var(--border-color)] py-2 text-sm last:border-b-0">
            <div>
              <p className="text-[var(--text-primary)]">{t(runStatusKey(run.status))}</p>
              <p className="text-xs text-[var(--text-secondary)]">
                {new Date(run.startedAt).toLocaleString()}
                {run.durationMs !== null && run.durationMs !== undefined
                  ? ` · ${t('mobile.tasks.durationMs', { ms: formatDurationMs(run.durationMs) ?? '0' })}`
                  : ''}
                {` · ${t(`mobile.tasks.trigger.${run.trigger}`)}`}
              </p>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function TaskRow(props: { task: ScheduledTask; screen: ReturnType<typeof useScheduledTasks> }): JSX.Element {
  const { task, screen } = props;
  const [expanded, setExpanded] = useState(false);
  const runs = screen.runsFor(task.id);
  const running = task.state.runningAtMs !== null;
  const nextRun = formatRunTime(task.state.nextRunAtMs);
  const lastRun = formatRunTime(task.state.lastRunAtMs);
  const lastStatus = task.state.lastStatus;

  return (
    <div className="border-b border-[var(--border-color)] py-3 last:border-b-0">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            const next = !expanded;
            setExpanded(next);
            if (next) void screen.loadRuns(task.id);
          }}
          aria-expanded={expanded}
          className="flex min-h-[44px] min-w-[44px] items-center justify-center text-[var(--text-secondary)]"
          aria-label={`${t(expanded ? 'mobile.tasks.hideHistory' : 'mobile.tasks.showHistory')} · ${task.name}`}
        >
          {expanded ? <ChevronDownIcon className="h-5 w-5" aria-hidden /> : <ChevronRightIcon className="h-5 w-5" aria-hidden />}
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium text-[var(--text-primary)]">{task.name}</p>
          <p className="text-xs text-[var(--text-secondary)]">
            {nextRun ? t('mobile.tasks.nextRun', { time: nextRun }) : t('mobile.tasks.noNextRun')}
            {lastRun ? ` · ${t('mobile.tasks.lastRun', { time: lastRun })}` : ''}
          </p>
          <p className="text-xs text-[var(--text-secondary)]">
            {lastStatus
              ? t('mobile.tasks.lastStatus', { status: t(LAST_STATUS_KEY[lastStatus] ?? 'mobile.tasks.statusLabel.none') })
              : t('mobile.tasks.neverRun')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void screen.runTask(task.id)}
          disabled={running}
          aria-label={`${t('mobile.tasks.runNow')} · ${task.name}`}
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-[var(--text-primary)] active:bg-[var(--bg-hover)] disabled:opacity-40"
        >
          <PlayIcon className="h-5 w-5" aria-hidden />
        </button>
        <Switch
          checked={task.enabled}
          onChange={(checked) => void screen.toggleTask(task.id, checked)}
          label={`${t('mobile.tasks.enabled')} · ${task.name}`}
        />
      </div>
      {running ? <p className="mt-1 text-xs text-amber-600">{t('mobile.tasks.running')}</p> : null}
      {expanded ? <TaskRuns taskId={task.id} runs={runs} /> : null}
    </div>
  );
}

function CreateTaskSheet(props: {
  screen: ReturnType<typeof useScheduledTasks>;
  open: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const { screen } = props;
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>('interval');
  const [intervalMinutes, setIntervalMinutes] = useState('');
  const [dailyTime, setDailyTime] = useState('09:00');
  const [validation, setValidation] = useState<string | null>(null);

  if (!props.open) return null;

  const submit = async () => {
    if (!name.trim()) {
      setValidation(t('mobile.tasks.validation.name'));
      return;
    }
    if (!prompt.trim()) {
      setValidation(t('mobile.tasks.validation.prompt'));
      return;
    }
    const minutes = Number(intervalMinutes);
    const schedule =
      scheduleKind === 'interval'
        ? { type: 'interval' as const, intervalMs: minutes * 60_000, unit: 'minutes' as const, value: minutes }
        : (() => {
            const [hour = 0, minute = 0] = dailyTime.split(':').map(Number);
            return { type: 'cron' as const, expression: `${minute} ${hour} * * *` };
          })();
    if (scheduleKind === 'interval' && (!Number.isFinite(minutes) || minutes <= 0)) {
      setValidation(t('mobile.tasks.validation.interval'));
      return;
    }
    const created = await screen.createTask({ name: name.trim(), prompt: prompt.trim(), schedule });
    if (created) {
      setName('');
      setPrompt('');
      setIntervalMinutes('');
      setValidation(null);
      props.onClose();
    }
  };

  const inputClass =
    'min-h-[44px] w-full rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)] px-3 py-2.5 text-[15px] text-[var(--text-primary)] outline-none';
  const segmented = (kind: ScheduleKind, labelKey: string) => (
    <button
      type="button"
      onClick={() => setScheduleKind(kind)}
      className={`min-h-[44px] flex-1 rounded-xl border px-2 text-sm ${
        scheduleKind === kind
          ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-black'
          : 'border-[var(--border-color)] text-[var(--text-secondary)]'
      }`}
    >
      {t(labelKey)}
    </button>
  );

  return (
    <BottomSheet title={t('mobile.tasks.createTitle')} onClose={props.onClose}>
      <div className="flex flex-col gap-3">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('mobile.tasks.namePlaceholder')}
          className={inputClass}
        />
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={t('mobile.tasks.promptPlaceholder')}
          rows={3}
          className={`${inputClass} resize-none`}
        />
        <p className="text-xs font-medium uppercase text-[var(--text-secondary)]">{t('mobile.tasks.scheduleLabel')}</p>
        <div className="flex gap-2">
          {segmented('interval', 'mobile.tasks.scheduleInterval')}
          {segmented('daily', 'mobile.tasks.scheduleDaily')}
        </div>
        {scheduleKind === 'interval' ? (
          <input
            value={intervalMinutes}
            onChange={(event) => setIntervalMinutes(event.target.value)}
            placeholder={t('mobile.tasks.intervalPlaceholder')}
            inputMode="numeric"
            className={inputClass}
          />
        ) : (
          <label className="flex min-h-[44px] items-center gap-3 text-sm text-[var(--text-secondary)]">
            {t('mobile.tasks.dailyTimeLabel')}
            <input
              type="time"
              value={dailyTime}
              onChange={(event) => setDailyTime(event.target.value)}
              className={`${inputClass} flex-1`}
            />
          </label>
        )}
        {validation ? <p className="text-sm text-red-600">{validation}</p> : null}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={props.onClose}
            className="min-h-[44px] flex-1 rounded-xl border border-[var(--border-color)] py-2 text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
          >
            {t('mobile.tasks.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={screen.creating}
            className="min-h-[44px] flex-1 rounded-xl bg-[var(--color-primary)] py-2 font-medium text-black active:opacity-80 disabled:opacity-40"
          >
            {t('mobile.tasks.save')}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}

/** Scheduled-tasks tab (REQ-E-13). */
export default function TasksScreen(props: { resyncCounter?: number }): JSX.Element {
  // resyncCounter: REQ-E-5 reconnect resync re-lists tasks after every reconnect.
  const screen = useScheduledTasks(props.resyncCounter);
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-[var(--border-color)] bg-[var(--bg-panel)] px-4 py-2">
        <h1 className="text-base font-semibold text-[var(--text-primary)]">{t('mobile.tasks.title')}</h1>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="flex min-h-[44px] items-center gap-1 px-2 text-sm text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
        >
          <PlusIcon className="h-5 w-5" aria-hidden />
          {t('mobile.tasks.create')}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <Section title={t('mobile.tasks.title')}>
          {screen.tasks.length === 0 ? (
            <p className="py-4 text-sm text-[var(--text-secondary)]">{t('mobile.tasks.empty')}</p>
          ) : (
            screen.tasks.map((task) => <TaskRow key={task.id} task={task} screen={screen} />)
          )}
        </Section>
      </div>
      <CreateTaskSheet screen={screen} open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}
