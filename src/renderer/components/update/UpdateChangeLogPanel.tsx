import React from 'react';
import { i18nService } from '../../services/i18n';
import type { ChangeLogEntry } from '../../services/appUpdate';

interface UpdateChangeLogPanelProps {
  version: string;
  date: string;
  /** 已按当前 UI 语言解析的更新说明 */
  changeLog: ChangeLogEntry;
}

/**
 * 悬停「有新版本」徽章时显示的更新说明小面板。
 * 容器由 AppUpdateBadge 以 fixed 定位渲染，本组件只负责内容与视觉，
 * 样式与更新弹窗（AppUpdateModal）的信息态保持一致，适配深浅色模式。
 */
const UpdateChangeLogPanel: React.FC<UpdateChangeLogPanelProps> = ({ version, date, changeLog }) => (
  <div className="p-4">
    <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
      {i18nService.t('updateAvailableTitle')}
    </h3>
    <p className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
      v{version}{date ? ` · ${date}` : ''}
    </p>

    {changeLog.title && (
      <p className="mt-3 text-sm font-medium dark:text-claude-darkText text-claude-text">
        {changeLog.title}
      </p>
    )}

    {changeLog.content.length > 0 && (
      <ul className="mt-2 space-y-1.5 max-h-64 overflow-y-auto pr-1">
        {changeLog.content.map((item, index) => (
          <li
            key={index}
            className="flex items-start gap-2 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary"
          >
            <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-claude-accent/60" />
            <span className="min-w-0 break-words">{item}</span>
          </li>
        ))}
      </ul>
    )}
  </div>
);

export default UpdateChangeLogPanel;
