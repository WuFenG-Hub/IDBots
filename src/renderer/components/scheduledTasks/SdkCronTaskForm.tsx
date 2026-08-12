import React, { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { scheduledTaskService } from '../../services/scheduledTask';
import { i18nService } from '../../services/i18n';
import type { SdkCronMirror, SdkCronScheduleSpec } from '../../types/scheduledTask';
import type { Metabot } from '../../types/metabot';
import {
  defaultSdkCronFormState,
  formStateToSpec,
  mirrorToFormState,
  specToSdkCron,
  type IntervalUnit,
  type ScheduleMode,
} from './sdkCronSchedule';

interface SdkCronTaskFormProps {
  mode: 'create' | 'edit';
  mirror?: SdkCronMirror;
  onCancel: () => void;
  onSaved: () => void;
}

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const; // 0=Sunday

const weekdayKeys: Record<number, string> = {
  0: 'scheduledTasksFormWeekSun',
  1: 'scheduledTasksFormWeekMon',
  2: 'scheduledTasksFormWeekTue',
  3: 'scheduledTasksFormWeekWed',
  4: 'scheduledTasksFormWeekThu',
  5: 'scheduledTasksFormWeekFri',
  6: 'scheduledTasksFormWeekSat',
};

/**
 * SDK 定时任务新建/编辑表单。对标旧版 TaskForm 的字段与控件布局，
 * 但贴合 SDK 实际：无工作目录/通知/过期日（durable 由 SDK 管理，7 天强制过期）。
 */
const SdkCronTaskForm: React.FC<SdkCronTaskFormProps> = ({ mode, mirror, onCancel, onSaved }) => {
  const currentSessionMetabotId = useSelector((state: RootState) => state.cowork.currentSession?.metabotId ?? null);
  const preferredMetabotId = useSelector((state: RootState) => state.cowork.preferredMetabotId);
  const defaultMetabotId = mirror?.scheduleSpec?.metabotId ?? currentSessionMetabotId ?? preferredMetabotId ?? null;

  // 编辑模式：从镜像的 scheduleSpec 还原表单态；新建：默认 once/09:00。
  const initial = mirror ? mirrorToFormState(mirror) : defaultSdkCronFormState();

  const [name, setName] = useState(mirror?.scheduleSpec?.name ?? mirror?.name ?? '');
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>(initial.mode);
  const [scheduleDate, setScheduleDate] = useState(initial.date);
  const [scheduleTime, setScheduleTime] = useState(initial.time);
  const [weekday, setWeekday] = useState(initial.weekday);
  const [monthDay, setMonthDay] = useState(initial.monthDay);
  const [intervalValue, setIntervalValue] = useState(initial.intervalValue);
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>(initial.intervalUnit);
  const [cronExpression, setCronExpression] = useState(initial.cronExpression);
  const [prompt, setPrompt] = useState(mirror?.scheduleSpec?.prompt ?? '');
  const [metabots, setMetabots] = useState<Metabot[]>([]);
  const [selectedMetabotId, setSelectedMetabotId] = useState<number | null>(defaultMetabotId);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    const loadMetabots = async () => {
      try {
        const result = await window.electron?.metabot?.list?.();
        if (cancelled || !result?.success || !result.list) return;
        const enabledMetabots = result.list.filter((m) => m.enabled);
        setMetabots(enabledMetabots);
        setSelectedMetabotId((current) => {
          if (current != null && enabledMetabots.some((m) => m.id === current)) return current;
          if (defaultMetabotId != null && enabledMetabots.some((m) => m.id === defaultMetabotId)) return defaultMetabotId;
          const twin = enabledMetabots.find((m) => m.metabot_type === 'twin');
          return twin?.id ?? enabledMetabots[0]?.id ?? null;
        });
      } catch {
        // 保留已有默认值。
      }
    };
    void loadMetabots();
    return () => { cancelled = true; };
  }, [defaultMetabotId]);

  const buildSpec = (): SdkCronScheduleSpec => {
    const spec = formStateToSpec(
      {
        mode: scheduleMode,
        date: scheduleDate,
        time: scheduleTime,
        weekday,
        monthDay,
        intervalValue,
        intervalUnit,
        cronExpression,
      },
      { name: name.trim(), prompt: prompt.trim(), metabotId: selectedMetabotId }
    );
    return spec;
  };

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};
    if (!name.trim()) newErrors.name = i18nService.t('scheduledTasksFormValidationNameRequired');
    if (!prompt.trim()) newErrors.prompt = i18nService.t('scheduledTasksFormValidationPromptRequired');
    if (metabots.length > 0 && selectedMetabotId == null) {
      newErrors.metabot = i18nService.t('scheduledTasksFormValidationMetabotRequired');
    }
    if (scheduleMode === 'once') {
      if (!scheduleDate || !scheduleTime) {
        newErrors.schedule = i18nService.t('scheduledTasksFormValidationDatetimeFuture');
      } else if (new Date(`${scheduleDate}T${scheduleTime}`).getTime() <= Date.now()) {
        newErrors.schedule = i18nService.t('scheduledTasksFormValidationDatetimeFuture');
      }
    }
    if (scheduleMode === 'interval' && (!Number.isInteger(intervalValue) || intervalValue <= 0)) {
      newErrors.schedule = i18nService.t('scheduledTasksFormValidationIntervalPositive');
    }
    if (scheduleMode === 'cron') {
      const cronParts = cronExpression.trim().split(/\s+/).filter(Boolean);
      if (cronParts.length !== 5) {
        newErrors.schedule = i18nService.t('scheduledTasksFormValidationCronRequired');
      }
    }
    if (['once', 'daily', 'weekly', 'monthly'].includes(scheduleMode) && !scheduleTime) {
      newErrors.schedule = i18nService.t('scheduledTasksFormValidationTimeRequired');
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    setSubmitting(true);
    try {
      const spec = buildSpec();
      // 兜底校验生成的 cron 表达式合法（与主进程 computeSdkCronFromSpec 同逻辑）。
      const cron = specToSdkCron(spec);
      if (!cron.expression) {
        setErrors({ schedule: i18nService.t('scheduledTasksFormValidationCronRequired') });
        setSubmitting(false);
        return;
      }
      // 提交即返回：createSdkCron 内部轮询等待后台对账（最长 60s），不再无限「保存中」。
      let result = null;
      if (mode === 'create') {
        result = await scheduledTaskService.createSdkCron(spec);
      } else if (mirror) {
        result = await scheduledTaskService.createSdkCron(spec, mirror.id);
      }
      // 保存成功（或后台仍在执行）都立即返回列表，用 toast 反馈结果。
      onSaved();
      const hint = result?.timedOut
        ? '保存已提交，后台仍在执行，可稍后刷新查看'
        : '已提交，正在后台会话执行…';
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: hint }));
    } catch {
      // 错误由 service 层处理（setError 进 store）。
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass = 'w-full rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-white px-3 py-2 text-sm dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/50';
  const labelClass = 'block text-sm font-medium dark:text-claude-darkText text-claude-text mb-1';
  const errorClass = 'text-xs text-red-500 mt-1';

  const scheduleModes: ScheduleMode[] = ['once', 'interval', 'daily', 'weekly', 'monthly', 'cron'];
  const intervalUnits: IntervalUnit[] = ['minutes', 'hours', 'days'];

  return (
    <div className="p-4 space-y-4 max-w-2xl mx-auto">
      <h2 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
        {mode === 'create' ? i18nService.t('scheduledTasksFormCreate') : i18nService.t('scheduledTasksFormUpdate')}
      </h2>

      {/* 7 天过期提示（SDK 限制） */}
      <div className="px-3 py-2 rounded-md text-xs dark:bg-amber-900/20 bg-amber-50 dark:text-amber-300 text-amber-700">
        {i18nService.t('scheduledTasksSdkSevenDayNotice')}
      </div>

      {/* 名称 */}
      <div>
        <label className={labelClass}>{i18nService.t('scheduledTasksFormName')}</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={inputClass}
          placeholder={i18nService.t('scheduledTasksFormNamePlaceholder')}
        />
        {errors.name && <p className={errorClass}>{errors.name}</p>}
      </div>

      {/* Prompt */}
      <div>
        <label className={labelClass}>{i18nService.t('scheduledTasksPrompt')}</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className={inputClass + ' h-28 resize-none'}
          placeholder={i18nService.t('scheduledTasksFormPromptPlaceholder')}
        />
        {errors.prompt && <p className={errorClass}>{errors.prompt}</p>}
      </div>

      {/* MetaBot */}
      <div>
        <label className={labelClass}>{i18nService.t('scheduledTasksFormMetabot')}</label>
        <select
          value={selectedMetabotId ?? ''}
          onChange={(e) => setSelectedMetabotId(e.target.value ? Number(e.target.value) : null)}
          className={inputClass}
          disabled={metabots.length === 0}
        >
          {metabots.length === 0 ? (
            <option value="">{i18nService.t('metabotCreateFirstPrompt')}</option>
          ) : (
            metabots.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.metabot_type})
              </option>
            ))
          )}
        </select>
        {errors.metabot && <p className={errorClass}>{errors.metabot}</p>}
      </div>

      {/* 计划（对标旧版 TaskForm 的三列布局） */}
      <div>
        <label className={labelClass}>{i18nService.t('scheduledTasksFormScheduleType')}</label>
        <div className="grid grid-cols-3 gap-2">
          <select
            value={scheduleMode}
            onChange={(e) => setScheduleMode(e.target.value as ScheduleMode)}
            className={inputClass}
          >
            {scheduleModes.map((m) => (
              <option key={m} value={m}>
                {i18nService.t(`scheduledTasksFormScheduleMode${m.charAt(0).toUpperCase() + m.slice(1)}`)}
              </option>
            ))}
          </select>

          {scheduleMode === 'once' ? (
            <input
              type="date"
              value={scheduleDate}
              onChange={(e) => setScheduleDate(e.target.value)}
              className={inputClass}
              min={new Date().toISOString().slice(0, 10)}
            />
          ) : scheduleMode === 'interval' ? (
            <input
              type="number"
              value={intervalValue}
              onChange={(e) => setIntervalValue(Number(e.target.value))}
              className={inputClass}
              min={1}
              step={1}
            />
          ) : scheduleMode === 'weekly' ? (
            <select value={weekday} onChange={(e) => setWeekday(parseInt(e.target.value))} className={inputClass}>
              {WEEKDAYS.map((d) => (
                <option key={d} value={d}>
                  {i18nService.t(weekdayKeys[d])}
                </option>
              ))}
            </select>
          ) : scheduleMode === 'monthly' ? (
            <select value={monthDay} onChange={(e) => setMonthDay(parseInt(e.target.value))} className={inputClass}>
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  {d}{i18nService.t('scheduledTasksFormMonthDaySuffix')}
                </option>
              ))}
            </select>
          ) : scheduleMode === 'cron' ? (
            <input
              type="text"
              value={cronExpression}
              onChange={(e) => setCronExpression(e.target.value)}
              className={inputClass + ' col-span-2'}
              placeholder={i18nService.t('scheduledTasksFormCronPlaceholder')}
            />
          ) : (
            <input
              type="time"
              value={scheduleTime}
              onChange={(e) => setScheduleTime(e.target.value)}
              className={inputClass}
            />
          )}

          {scheduleMode === 'interval' ? (
            <select
              value={intervalUnit}
              onChange={(e) => setIntervalUnit(e.target.value as IntervalUnit)}
              className={inputClass}
            >
              {intervalUnits.map((unit) => (
                <option key={unit} value={unit}>
                  {i18nService.t(`scheduledTasksFormInterval${unit.charAt(0).toUpperCase() + unit.slice(1)}`)}
                </option>
              ))}
            </select>
          ) : scheduleMode === 'daily' ? (
            <div />
          ) : scheduleMode !== 'cron' ? (
            <input
              type="time"
              value={scheduleTime}
              onChange={(e) => setScheduleTime(e.target.value)}
              className={inputClass}
            />
          ) : null}
        </div>
        {errors.schedule && <p className={errorClass}>{errors.schedule}</p>}
      </div>

      {/* 操作 */}
      <div className="flex items-center justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
        >
          {i18nService.t('cancel')}
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting}
          className="btn-idchat-primary-filled px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {submitting
            ? i18nService.t('saving')
            : mode === 'create'
              ? i18nService.t('scheduledTasksFormCreate')
              : i18nService.t('scheduledTasksFormUpdate')}
        </button>
      </div>
    </div>
  );
};

export default SdkCronTaskForm;
