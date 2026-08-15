import React, { useState, useEffect } from 'react';
import { CpuChipIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { configService } from '../../services/config';

interface KernelSelectorProps {
  /**
   * Kernel the CURRENT session actually runs on (from its claudeSessionId
   * `dsh:` prefix). Omitted for the new-session input; when provided and it
   * differs from the default, a small badge shows the session's kernel so
   * A/B debugging ("is this a DSH problem?") stays unambiguous.
   */
  sessionKernel?: 'dsh' | 'claude';
}

type KernelChoice = 'claude' | 'dsh';

/**
 * Compact cowork kernel toggle: picks which kernel NEW cowork turns run on —
 * DSH (DeepSeek Harness subprocess) or the Claude Agent SDK path. Existing
 * sessions keep the kernel they started with (the `dsh:` session-handle
 * pin), so switching mid-conversation never tears a session; compare kernels
 * by reproducing an issue in a fresh session.
 */
const KernelSelector: React.FC<KernelSelectorProps> = ({ sessionKernel }) => {
  const [defaultKernel, setDefaultKernel] = useState<KernelChoice>('claude');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const config = configService.getConfig();
    setDefaultKernel(config?.dshKernelEnabled ? 'dsh' : 'claude');
  }, []);

  const switchKernel = async (next: KernelChoice) => {
    if (pending || next === defaultKernel) return;
    setPending(true);
    try {
      await configService.updateConfig({ dshKernelEnabled: next === 'dsh' });
      setDefaultKernel(next);
    } finally {
      setPending(false);
    }
  };

  const pill = (choice: KernelChoice, label: string) => {
    const active = defaultKernel === choice;
    return (
      <button
        type="button"
        disabled={pending}
        onClick={() => void switchKernel(choice)}
        className={`px-1.5 py-0.5 rounded text-[11px] font-medium transition-colors disabled:opacity-50 ${
          active
            ? 'bg-claude-accent/20 text-[#FFDC51]'
            : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:bg-claude-darkSurfaceInset hover:bg-claude-surfaceInset'
        }`}
      >
        {label}
      </button>
    );
  };

  return (
    <div
      className="flex items-center gap-1 rounded-lg border dark:border-claude-darkBorder border-claude-border px-1.5 py-1"
      title={i18nService.t('kernelSelectorTitle')}
    >
      <CpuChipIcon className="h-3.5 w-3.5 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
      {pill('claude', i18nService.t('kernelClaude'))}
      {pill('dsh', i18nService.t('kernelDsh'))}
      {sessionKernel && sessionKernel !== defaultKernel && (
        <span
          className="ml-0.5 px-1 py-0.5 rounded text-[10px] dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset dark:text-claude-darkTextSecondary text-claude-textSecondary"
          title={i18nService.t('kernelSessionBadgeTitle')}
        >
          {sessionKernel === 'dsh' ? i18nService.t('kernelDsh') : i18nService.t('kernelClaude')}
        </span>
      )}
    </div>
  );
};

export default KernelSelector;
