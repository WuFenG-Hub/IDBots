import React, { useState } from 'react';
import { EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';

interface SecretInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

// Single-line input for secrets (API keys): masked as password dots by
// default, with an eye button on the right to reveal the plain text.
const SecretInput: React.FC<SecretInputProps> = ({
  id,
  value,
  onChange,
  placeholder,
  className = '',
}) => {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <input
        type={visible ? 'text' : 'password'}
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        className={`block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs font-mono pr-10 ${className}`}
        placeholder={placeholder}
      />
      <button
        type="button"
        onClick={() => setVisible((prev) => !prev)}
        title={visible ? i18nService.t('hideSecret') : i18nService.t('showSecret')}
        aria-label={visible ? i18nService.t('hideSecret') : i18nService.t('showSecret')}
        aria-pressed={visible}
        className="absolute inset-y-0 right-0 flex items-center pr-3 text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-text dark:hover:text-claude-darkText transition-colors"
      >
        {visible ? <EyeSlashIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
      </button>
    </div>
  );
};

export default SecretInput;
