/**
 * Custom Provider Delete Confirmation Modal
 * Confirmation dialog shown before removing a user-created custom LLM provider.
 * Confirm deletes the provider; cancel closes the dialog without changes.
 */

import React from 'react';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../services/i18n';

export interface CustomProviderDeleteConfirmModalProps {
  /** Display name of the custom provider being deleted. */
  name: string;
  onClose: () => void;
  onConfirm: () => void;
}

const CustomProviderDeleteConfirmModal: React.FC<CustomProviderDeleteConfirmModalProps> = ({
  name,
  onClose,
  onConfirm,
}) => {
  const handleDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/35 px-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={i18nService.t('deleteProvider')}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
        className="w-full max-w-md rounded-2xl dark:bg-claude-darkSurface bg-claude-bg dark:border-claude-darkBorder border-claude-border border shadow-modal p-4"
      >
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-9 h-9 rounded-full bg-red-500/20 flex items-center justify-center">
            <ExclamationTriangleIcon className="h-5 w-5 text-red-500" />
          </div>
          <div className="min-w-0">
            <h4 className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
              {i18nService.t('deleteProvider')}
            </h4>
            <p className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('deleteCustomProviderConfirm').replace('{name}', name)}
            </p>
          </div>
        </div>
        <div className="mt-4 flex gap-3 justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover rounded-xl border dark:border-claude-darkBorder border-claude-border"
          >
            {i18nService.t('cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-3 py-1.5 text-xs rounded-xl bg-red-600 hover:bg-red-700 text-gray-900 font-medium"
          >
            {i18nService.t('delete')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CustomProviderDeleteConfirmModal;
