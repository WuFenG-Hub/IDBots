import React, { useCallback, useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { scheduledTaskService } from '../../services/scheduledTask';
import type { SdkCronMirror } from '../../types/scheduledTask';
import { ClockIcon, TrashIcon, ArrowPathIcon } from '@heroicons/react/24/outline';

/**
 * R1 展示层：SDK cron 宿主侧镜像列表（方案 C）。
 * - 只读镜像（宿主不参与调度，避免双触发）；数据源 = Stop hook 采集 + durable 文件扫描。
 * - 删除/停用走管理桥：所属会话活跃时注入指令由 bot 执行 CronDelete；否则提示用户到会话内操作。
 * - R2 入口：老 scheduledTaskStore 任务一键迁移（执行前确认；幂等）。
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

const SdkCronMirrorList: React.FC = () => {
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

  const handleDelete = async (mirror: SdkCronMirror) => {
    if (mirror.status !== 'active' || deletingId) return;
    const confirmed = window.confirm(
      `确定删除 SDK 定时任务「${mirror.name}」（${mirror.id}）？\n将通知其所属会话执行 CronDelete；删除后 7 天内不会再次触发。`
    );
    if (!confirmed) return;
    setDeletingId(mirror.id);
    try {
      const result = await scheduledTaskService.requestDeleteSdkCron(mirror.id);
      if (result?.hint) showToast(result.hint);
      else showToast('已发起删除，等待会话确认…');
    } catch (error) {
      showToast(`删除失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setDeletingId(null);
    }
  };

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
          SDK 定时任务镜像（只展示，不参与本机调度）
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

      {/* R4 提示 */}
      {sessionOnlyCount > 0 && (
        <div className="mx-4 mt-2 px-3 py-2 rounded-md text-xs dark:bg-claude-darkSurfaceHover/50 bg-claude-surfaceHover/50 dark:text-claude-darkTextSecondary text-claude-textSecondary">
          ⚠️ 会话内任务在宿主进程退出后失效，且 7 天自动过期；高频周期任务可能抢占用户消息，建议低频 + 持久（durable）。
        </div>
      )}

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            加载中…
          </div>
        ) : activeMirrors.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-6">
            <ClockIcon className="h-12 w-12 dark:text-claude-darkTextSecondary/40 text-claude-textSecondary/40 mb-4" />
            <p className="text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
              暂无 SDK 定时任务
            </p>
            <p className="text-xs dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70 text-center">
              会话内使用 CronCreate 创建的任务会显示在这里；durable 任务跨重启保留
            </p>
          </div>
        ) : (
          <div>
            {/* 列头 */}
            <div className="grid grid-cols-[1fr_120px_90px_150px_1fr_64px] items-center gap-3 px-4 py-2 border-b dark:border-claude-darkBorder/50 border-claude-border/50">
              {['名称', '表达式', '类型', '所属会话', '来源', ''].map((col) => (
                <div key={col} className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">
                  {col}
                </div>
              ))}
            </div>
            {activeMirrors.map((mirror) => (
              <div
                key={mirror.id}
                className="grid grid-cols-[1fr_120px_90px_150px_1fr_64px] items-center gap-3 px-4 py-3 border-b dark:border-claude-darkBorder/50 border-claude-border/50 hover:bg-claude-surfaceHover/50 dark:hover:bg-claude-darkSurfaceHover/50 transition-colors"
              >
                {/* 名称 + 徽标 */}
                <div className="min-w-0">
                  <div className="text-sm dark:text-claude-darkText text-claude-text truncate">{mirror.name}</div>
                  <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                    {mirror.durable && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        durable
                      </span>
                    )}
                    {hasSevenDayMark(mirror.prompt) && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded dark:bg-amber-900/40 bg-amber-100 dark:text-amber-300 text-amber-700">
                        7 天有效
                      </span>
                    )}
                    {mirror.migratedTaskId && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded dark:bg-emerald-900/40 bg-emerald-100 dark:text-emerald-300 text-emerald-700">
                        已迁移
                      </span>
                    )}
                    {mirror.status === 'deletion_requested' && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded dark:bg-orange-900/40 bg-orange-100 dark:text-orange-300 text-orange-700">
                        删除中
                      </span>
                    )}
                  </div>
                </div>
                {/* 表达式 */}
                <div className="text-xs font-mono dark:text-claude-darkTextSecondary text-claude-textSecondary truncate" title={mirror.humanSchedule ?? mirror.schedule}>
                  {mirror.schedule}
                </div>
                {/* 类型 */}
                <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {mirror.recurring ? '周期' : '一次性'}
                </div>
                {/* 所属会话 */}
                <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary truncate" title={mirror.sessionId}>
                  {mirror.sessionTitle ?? mirror.sessionId}
                  {mirror.sessionActive && (
                    <span className="ml-1 text-emerald-500">●</span>
                  )}
                </div>
                {/* 来源 */}
                <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">
                  {mirror.source === 'migration' ? '迁移' : mirror.source === 'file_scan' ? '文件扫描' : '会话采集'}
                </div>
                {/* 删除 */}
                <div className="flex justify-center">
                  <button
                    type="button"
                    onClick={() => void handleDelete(mirror)}
                    disabled={mirror.status !== 'active' || deletingId !== null}
                    className="p-1.5 rounded-md dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-40"
                    title="删除（经管理桥由会话内 bot 执行 CronDelete）"
                  >
                    {deletingId === mirror.id ? (
                      <ArrowPathIcon className="w-4 h-4 animate-spin" />
                    ) : (
                      <TrashIcon className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default SdkCronMirrorList;
