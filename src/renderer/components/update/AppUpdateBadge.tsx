import React from 'react';
import { i18nService } from '../../services/i18n';

interface AppUpdateBadgeProps {
  latestVersion: string;
  onClick: () => void;
  /** 自定义徽章文案（如 macOS 静默安装完成后的「更新已就绪」），缺省为「有新版本」 */
  label?: string;
}

const AppUpdateBadge: React.FC<AppUpdateBadgeProps> = ({ latestVersion, onClick, label }) => {
  const text = label ?? i18nService.t('updateAvailablePill');
  return (
    <button
      type="button"
      onClick={onClick}
      className="non-draggable inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/12 px-3 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-500/18 dark:text-emerald-400 transition-colors"
      title={`${text} ${latestVersion}`}
      aria-label={`${text} ${latestVersion}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400" />
      <span>{text}</span>
    </button>
  );
};

export default AppUpdateBadge;
