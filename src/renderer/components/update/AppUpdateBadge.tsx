import React from 'react';
import { i18nService } from '../../services/i18n';
import type { AppUpdateDownloadProgress } from '../../services/appUpdate';
import { formatBytes } from './format';

interface AppUpdateBadgeProps {
  latestVersion: string;
  onClick: () => void;
  /** 自定义徽章文案（如 macOS 静默安装完成后的「更新已就绪」），缺省为「有新版本」 */
  label?: string;
  /** 非空时徽章显示后台下载进度（断点续传时显示「继续下载」） */
  progress?: AppUpdateDownloadProgress | null;
}

const AppUpdateBadge: React.FC<AppUpdateBadgeProps> = ({ latestVersion, onClick, label, progress }) => {
  const percent = progress?.percent !== undefined && Number.isFinite(progress.percent)
    ? Math.round(progress.percent * 100)
    : undefined;
  const bytesDetail = progress
    ? progress.total !== undefined
      ? `${formatBytes(progress.received)} / ${formatBytes(progress.total)}`
      : formatBytes(progress.received)
    : '';

  let text: string;
  if (progress) {
    const base = progress.resumed ? i18nService.t('updateResumingPill') : i18nService.t('updateDownloadingPill');
    text = percent !== undefined ? `${base} ${percent}%` : base;
  } else {
    text = label ?? i18nService.t('updateAvailablePill');
  }
  const title = progress && bytesDetail ? `${text} · ${bytesDetail}` : `${text} ${latestVersion}`;

  return (
    <button
      type="button"
      onClick={onClick}
      className="non-draggable inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/12 px-3 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-500/18 dark:text-emerald-400 transition-colors"
      title={title}
      aria-label={title}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400" />
      <span>{text}</span>
    </button>
  );
};

export default AppUpdateBadge;
