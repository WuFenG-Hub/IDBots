import React from 'react';
import { i18nService } from '../../services/i18n';
import { ExclamationTriangleIcon, CheckCircleIcon } from '@heroicons/react/24/outline';

interface GroupTaskCloseConfirmModalProps {
  action: 'done' | 'cancelled';
  taskTitle: string;
  closing: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const GroupTaskCloseConfirmModal: React.FC<GroupTaskCloseConfirmModalProps> = ({
  action,
  taskTitle,
  closing,
  onConfirm,
  onCancel,
}) => {
  const isDone = action === 'done';
  const titleKey = isDone ? 'groupTasksAcceptClose' : 'groupTasksCancelTask';
  const confirmKey = isDone ? 'groupTasksAcceptCloseConfirm' : 'groupTasksCancelTaskConfirm';

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      onClick={closing ? undefined : onCancel}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 dark:bg-black/60" />

      {/* Modal */}
      <div
        className="relative w-80 rounded-xl shadow-2xl dark:bg-claude-darkSurface bg-white border dark:border-claude-darkBorder border-claude-border p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col items-center text-center">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center mb-3 ${
            isDone ? 'bg-emerald-100 dark:bg-emerald-900/30' : 'bg-red-100 dark:bg-red-900/30'
          }`}>
            {isDone ? (
              <CheckCircleIcon className="w-5 h-5 text-emerald-500" />
            ) : (
              <ExclamationTriangleIcon className="w-5 h-5 text-red-500" />
            )}
          </div>
          <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text mb-2">
            {i18nService.t(titleKey)}
          </h3>
          <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary mb-5">
            {i18nService.t(confirmKey).replace('{title}', taskTitle)}
          </p>
          <div className="flex items-center gap-3 w-full">
            <button
              type="button"
              onClick={onCancel}
              disabled={closing}
              className="flex-1 px-4 py-2 text-sm rounded-lg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors disabled:opacity-50"
            >
              {i18nService.t('cancel')}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={closing}
              className={`flex-1 px-4 py-2 text-sm rounded-lg text-white transition-colors disabled:opacity-50 ${
                isDone ? 'bg-emerald-500 hover:bg-emerald-600' : 'bg-red-500 hover:bg-red-600'
              }`}
            >
              {i18nService.t(titleKey)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GroupTaskCloseConfirmModal;
