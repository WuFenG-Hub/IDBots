import React, { useState, useEffect } from 'react';
import { i18nService } from '../../services/i18n';
import { configService } from '../../services/config';

type KernelChoice = 'claude' | 'dsh';

const KERNEL_OPTIONS: KernelChoice[] = ['claude', 'dsh'];

/**
 * Cowork kernel toggle for Settings > Params & Config. Picks which kernel
 * NEW cowork turns run on — DSH (DeepSeek Harness subprocess) or the Claude
 * Agent SDK path. Existing sessions keep the kernel they started with.
 */
const KernelSelector: React.FC = () => {
  const [defaultKernel, setDefaultKernel] = useState<KernelChoice>('claude');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const config = configService.getConfig();
    // Unset adopts the DSH default (parity with isDshKernelEnabled).
    setDefaultKernel(config?.dshKernelEnabled === false ? 'claude' : 'dsh');
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

  const labelFor = (choice: KernelChoice): string => (
    choice === 'claude' ? i18nService.t('kernelClaude') : i18nService.t('kernelDsh')
  );

  return (
    <div
      className="grid grid-cols-2 gap-2"
      role="radiogroup"
      aria-label={i18nService.t('appKernel')}
    >
      {KERNEL_OPTIONS.map((choice) => {
        const isSelected = defaultKernel === choice;
        return (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={isSelected}
            disabled={pending}
            onClick={() => { void switchKernel(choice); }}
            className={`flex items-center justify-center py-2 px-3 rounded-md border-2 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
              isSelected
                ? 'border-claude-accent bg-claude-accent/5 dark:bg-claude-accent/10'
                : 'dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg hover:border-claude-accent/40'
            }`}
          >
            <span
              className={`text-sm font-medium ${
                isSelected
                  ? 'text-claude-accent'
                  : 'dark:text-claude-darkText text-claude-text'
              }`}
            >
              {labelFor(choice)}
            </span>
          </button>
        );
      })}
    </div>
  );
};

export default KernelSelector;
