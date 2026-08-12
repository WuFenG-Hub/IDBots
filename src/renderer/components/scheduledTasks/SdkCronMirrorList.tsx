import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { scheduledTaskService } from '../../services/scheduledTask';
import { i18nService } from '../../services/i18n';
import type { SdkCronMirror } from '../../types/scheduledTask';
import { EllipsisVerticalIcon, ClockIcon } from '@heroicons/react/24/outline';
import DeleteConfirmModal from './DeleteConfirmModal';
import { formatSdkCronScheduleLabel } from './sdkCronSchedule';

/**
 * 新版「定时任务」tab：基于 SDK 底层 cron 能力，UI/语义/能力对标旧版「旧任务」tab。
 *
 * 与旧版 TaskList 对齐的点：
 * - 列：标题（+ 徽标）｜计划于（人类可读语义）｜状态（开关 toggle）｜更多菜单（立即运行/编辑/删除）
 * - 开关 = 删→重建：停用经桥 CronDelete + 镜像 enabled=0（保留 spec）；启用用 spec 重建
 * - 更多菜单三项：立即运行 / 编辑 / 删除
 *
 * 与旧版的差异（符合 SDK 实际）：
 * - 只读镜像（无 scheduleSpec，即会话采集/迁移来源）不可开关/编辑，仅可删除——降级保护
 * - 任务 7 天后自动过期（SDK 限制），列表顶部统一提示
 */
const SEVEN_DAY_MARKER = '[SDK_7DAY_LIMITED]';

function hasSevenDayMark(prompt: string): boolean {
  return typeof prompt === 'string' && prompt.includes(SEVEN_DAY_MARKER);
}

interface MigrationPlanInfo {
  migratableCount: number;
  sevenDayLimitedCount: number;
  truncatedCount: number;
  unsupportedCount: number;
  hasMigratable: boolean;
}

interface SdkCronMirrorListProps {
  /** 进入编辑表单（由父视图控制 viewMode）。 */
  onEdit?: (mirror: SdkCronMirror) => void;
}

const SdkCronMirrorList: React.FC<SdkCronMirrorListProps> = ({ onEdit }) => {
  const mirrors = useSelector((state: RootState) => state.scheduledTask.sdkMirrors);
  const loading = useSelector((state: RootState) => state.scheduledTask.sdkMirrorsLoading);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [plan, setPlan] = useState<MigrationPlanInfo | null>(null);

  const showToast = useCallback((msg: string) => {
    window.dispatchEvent(new CustomEvent('app:showToast', { detail: msg }));
  }, []);

  useEffect(() => {
    void scheduledTaskService.loadSdkMirrors();
  }, []);

  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const handleRequestDelete = useCallback(
    (mirror: SdkCronMirror) => {
      // 解死锁：deletion_requested（上次删除/停用未生效）允许重试删除；仅已删除/进行中拦截。
      if (mirror.status === 'deleted' || deletingId) return;
      setDeleteTarget({ id: mirror.id, name: `${mirror.name}（${mirror.id}）` });
    },
    [deletingId]
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const { id } = deleteTarget;
    setDeleteTarget(null);
    setDeletingId(id);
    try {
      const result = await scheduledTaskService.requestDeleteSdkCron(id);
      if (result?.hint) showToast(result.hint);
      if (result?.timedOut) {
        showToast('删除仍在后台执行，可稍后刷新查看');
      } else if (result?.done) {
        showToast('任务已删除');
      }
    } catch (error) {
      showToast(`删除失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setDeletingId(null);
    }
  }, [deleteTarget, showToast]);

  const handlePlanMigration = async () => {
    if (migrating) return;
    try {
      const p = await scheduledTaskService.loadMigrationPlan();
      if (!p) {
        showToast('迁移规划失败');
        return;
      }
      setPlan({
        migratableCount: p.migratable.length,
        sevenDayLimitedCount: p.sevenDayLimitedCount,
        truncatedCount: p.truncatedCount,
        unsupportedCount: p.unsupported.length,
        hasMigratable: p.migratable.length > 0,
      });
    } catch (error) {
      showToast(`迁移规划失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleExecuteMigration = async () => {
    if (!plan || migrating) return;
    const confirmMsg = plan.hasMigratable
      ? `将迁移 ${plan.migratableCount} 个老任务为 SDK durable cron。\n其中 ${plan.sevenDayLimitedCount} 个受 SDK 7 天过期限制（到期需重建）。\n${plan.unsupportedCount} 个不支持（interval/非法表达式）将保留原状。\n\n执行后原任务将标记「已迁移」并停用，历史执行记录保留。确定执行？`
      : '当前没有可迁移的任务。确定刷新计划？';
    if (!window.confirm(confirmMsg)) return;
    setMigrating(true);
    try {
      const result = await scheduledTaskService.migrateToSdkCron();
      if (result) {
        showToast(`迁移完成：${result.migrated} 个任务已迁移为 SDK cron`);
        setPlan(null);
      }
    } catch (error) {
      showToast(`迁移执行失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setMigrating(false);
    }
  };

  const activeMirrors = mirrors.filter((m) => m.status !== 'deleted');
  const sessionOnlyCount = activeMirrors.filter((m) => !m.durable).length;

  return (
    <div className="flex flex-col h-full">
      {/* 工具行：说明 + 迁移入口 */}
      <div className="flex items-center justify-between gap-3 px-4 py-2 border-b dark:border-claude-darkBorder/50 border-claude-border/50">
        <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">
          {i18nService.t('scheduledTasksSdkHint')}
        </p>
        <button
          type="button"
          onClick={() => {
            if (plan) {
              void handleExecuteMigration();
            } else {
              void handlePlanMigration();
            }
          }}
          disabled={migrating}
          className="btn-idchat-primary-filled px-3 py-1 text-sm font-medium disabled:opacity-50"
        >
          {migrating ? '迁移中…' : plan ? '确认迁移' : '迁移老任务'}
        </button>
      </div>

      {/* 迁移计划预览 */}
      {plan && (
        <div className="px-4 py-2 border-b dark:border-claude-darkBorder/50 border-claude-border/50 text-xs dark:bg-claude-darkSurfaceHover/40 bg-claude-surfaceHover/40">
          {plan.hasMigratable
            ? `可迁移 ${plan.migratableCount} 个（${plan.sevenDayLimitedCount} 个受 7 天限制，${plan.truncatedCount} 个 prompt 被截断）；不支持 ${plan.unsupportedCount} 个。点击「确认迁移」执行。`
            : `没有可迁移的任务（不支持 ${plan.unsupportedCount} 个）。`}
        </div>
      )}

      {/* 会话内任务提示 */}
      {sessionOnlyCount > 0 && (
        <div className="mx-4 mt-2 px-3 py-2 rounded-md text-xs dark:bg-claude-darkSurfaceHover/50 bg-claude-surfaceHover/50 dark:text-claude-darkTextSecondary text-claude-textSecondary">
          ⚠️ 会话内任务在宿主进程退出后失效，且 7 天自动过期；高频周期任务可能抢占用户消息，建议低频 + 持久（durable）。
        </div>
      )}

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('loading')}
          </div>
        ) : activeMirrors.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-6">
            <ClockIcon className="h-12 w-12 dark:text-claude-darkTextSecondary/40 text-claude-textSecondary/40 mb-4" />
            <p className="text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
              {i18nService.t('scheduledTasksEmptyState')}
            </p>
            <p className="text-xs dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70 text-center">
              {i18nService.t('scheduledTasksSdkEmptyHint')}
            </p>
          </div>
        ) : (
          <div>
            {/* 列头（对标旧版 TaskList） */}
            <div className="grid grid-cols-[1fr_1fr_80px_40px] items-center gap-3 px-4 py-2 border-b dark:border-claude-darkBorder/50 border-claude-border/50">
              <div className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('scheduledTasksListColTitle')}
              </div>
              <div className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('scheduledTasksListColSchedule')}
              </div>
              <div className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('scheduledTasksListColStatus')}
              </div>
              <div className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary text-center">
                {i18nService.t('scheduledTasksListColMore')}
              </div>
            </div>
            {activeMirrors.map((mirror) => (
              <SdkCronMirrorListItem
                key={mirror.id}
                mirror={mirror}
                deletingId={deletingId}
                onEdit={onEdit}
                onRequestDelete={handleRequestDelete}
                showToast={showToast}
              />
            ))}
          </div>
        )}
      </div>

      {/* 删除确认模态（管理桥） */}
      {deleteTarget && (
        <DeleteConfirmModal
          taskName={deleteTarget.name}
          onConfirm={() => void handleConfirmDelete()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
};

interface SdkCronMirrorListItemProps {
  mirror: SdkCronMirror;
  deletingId: string | null;
  onEdit?: (mirror: SdkCronMirror) => void;
  onRequestDelete: (mirror: SdkCronMirror) => void;
  showToast: (msg: string) => void;
}

const SdkCronMirrorListItem: React.FC<SdkCronMirrorListItemProps> = ({
  mirror,
  deletingId,
  onEdit,
  onRequestDelete,
  showToast,
}) => {
  const [showMenu, setShowMenu] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [running, setRunning] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // 只读镜像（无 scheduleSpec）不可开关/编辑，仅可删除——降级保护。
  const readOnly = !mirror.scheduleSpec;
  // 已删除的镜像不可再操作；deletion_requested（上次删除/停用未生效）允许重试，不拦截。
  const toggleDisabled = readOnly || mirror.status === 'deleted' || toggling;

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    if (showMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showMenu]);

  const handleToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (toggleDisabled) {
      if (readOnly) {
        showToast(i18nService.t('scheduledTasksSdkToggleReadOnly'));
      }
      return;
    }
    const nextEnabled = !mirror.enabled;
    // 启用 = 重建，会重置 7 天计时 + 任务 id 变化，需明确确认。
    if (nextEnabled) {
      const ok = window.confirm(i18nService.t('scheduledTasksSdkToggleWarnReenable'));
      if (!ok) return;
    }
    setToggling(true);
    try {
      const result = await scheduledTaskService.toggleSdkCron(mirror.id, nextEnabled);
      if (result?.hint) showToast(result.hint);
      if (nextEnabled && result?.timedOut) {
        showToast('重新启用仍在后台执行，可稍后刷新查看');
      }
    } catch (error) {
      showToast(`开关失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setToggling(false);
    }
  };

  const handleRunNow = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowMenu(false);
    setRunning(true);
    try {
      await scheduledTaskService.runNowSdkCron(mirror.id);
      showToast(i18nService.t('scheduledTasksSdkRunNowStarted'));
    } catch (error) {
      showToast(`立即运行失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRunning(false);
    }
  };

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowMenu(false);
    if (readOnly) {
      showToast(i18nService.t('scheduledTasksSdkToggleReadOnly'));
      return;
    }
    onEdit?.(mirror);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowMenu(false);
    onRequestDelete(mirror);
  };

  return (
    <div
      className="grid grid-cols-[1fr_1fr_80px_40px] items-center gap-3 px-4 py-3 border-b dark:border-claude-darkBorder/50 border-claude-border/50 hover:bg-claude-surfaceHover/50 dark:hover:bg-claude-darkSurfaceHover/50 transition-colors"
    >
      {/* 标题 + 徽标 */}
      <div className="flex items-center gap-1.5 min-w-0">
        <span className={`text-sm truncate ${mirror.enabled ? 'dark:text-claude-darkText text-claude-text' : 'dark:text-claude-darkTextSecondary text-claude-textSecondary'}`}>
          {mirror.name}
        </span>
        {mirror.durable && (
          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary">
            durable
          </span>
        )}
        {hasSevenDayMark(mirror.prompt) && (
          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded dark:bg-amber-900/40 bg-amber-100 dark:text-amber-300 text-amber-700">
            7 天有效
          </span>
        )}
        {mirror.migratedTaskId && (
          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded dark:bg-emerald-900/40 bg-emerald-100 dark:text-emerald-300 text-emerald-700">
            已迁移
          </span>
        )}
        {!mirror.enabled && (
          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded dark:bg-slate-700/50 bg-slate-100 dark:text-slate-300 text-slate-600">
            已停用
          </span>
        )}
        {mirror.status === 'deletion_requested' && (
          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded dark:bg-orange-900/40 bg-orange-100 dark:text-orange-300 text-orange-700">
            删除中
          </span>
        )}
      </div>

      {/* 计划于（人类可读语义） */}
      <div className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary truncate" title={mirror.humanSchedule ?? mirror.schedule}>
        {formatSdkCronScheduleLabel(mirror)}
      </div>

      {/* 状态：开关 toggle（对标旧版 TaskList 样式） */}
      <div className="flex items-center gap-1.5">
        {running && (
          <span className="inline-flex items-center text-xs text-blue-500">
            <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
              <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" className="opacity-75" />
            </svg>
          </span>
        )}
        <button
          type="button"
          onClick={handleToggle}
          disabled={toggleDisabled}
          title={readOnly ? i18nService.t('scheduledTasksSdkToggleReadOnly') : undefined}
          className={`relative shrink-0 w-7 h-4 rounded-full transition-colors disabled:opacity-40 ${
            mirror.enabled
              ? 'bg-claude-accent'
              : 'dark:bg-claude-darkSurfaceHover bg-claude-border'
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform shadow-sm ${
              mirror.enabled ? 'translate-x-3' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      {/* 更多菜单：立即运行 / 编辑 / 删除（对标旧版三项） */}
      <div className="flex justify-center">
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}
            className="p-1.5 rounded-md dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          >
            <EllipsisVerticalIcon className="w-5 h-5" />
          </button>
          {showMenu && (
            <div className="absolute right-0 top-full mt-1 w-32 rounded-lg shadow-lg dark:bg-claude-darkSurface bg-white border dark:border-claude-darkBorder border-claude-border z-50 py-1">
              <button
                type="button"
                onClick={handleRunNow}
                disabled={running || mirror.status === 'deleted' || !mirror.enabled}
                className="w-full text-left px-3 py-1.5 text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:opacity-50"
              >
                {i18nService.t('scheduledTasksRun')}
              </button>
              <button
                type="button"
                onClick={handleEdit}
                disabled={readOnly || !mirror.enabled}
                className="w-full text-left px-3 py-1.5 text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:opacity-50"
              >
                {i18nService.t('scheduledTasksEdit')}
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={mirror.status === 'deleted' || deletingId !== null}
                className="w-full text-left px-3 py-1.5 text-sm text-red-500 hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:opacity-50"
              >
                {i18nService.t('scheduledTasksDelete')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SdkCronMirrorList;
