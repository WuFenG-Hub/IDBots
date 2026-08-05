import React, { useState, useRef, useEffect } from 'react';
import { i18nService } from '../../services/i18n';

interface EffortSelectorProps {
  sessionId?: string;
  currentEffort: string | null;
  onEffortChange: (effort: string | null) => void;
  disabled?: boolean;
}

const EFFORT_LEVELS: Array<{ value: string | null; icon: string; labelKey: string; descKey: string; color: string }> = [
  { value: null, icon: '⚙️', labelKey: 'coworkEffort_auto', descKey: 'coworkEffort_auto_desc', color: 'text-claude-textSecondary' },
  { value: 'low', icon: '🐇', labelKey: 'coworkEffort_low', descKey: 'coworkEffort_low_desc', color: 'text-green-500' },
  { value: 'medium', icon: '👟', labelKey: 'coworkEffort_medium', descKey: 'coworkEffort_medium_desc', color: 'text-blue-500' },
  { value: 'high', icon: '🏃', labelKey: 'coworkEffort_high', descKey: 'coworkEffort_high_desc', color: 'text-amber-500' },
  { value: 'max', icon: '🚀', labelKey: 'coworkEffort_max', descKey: 'coworkEffort_max_desc', color: 'text-red-500' },
];

/**
 * Compact inline effort-level selector for the cowork session header.
 * Lets users switch between auto/low/medium/high/max mid-session. 'auto' (null)
 * uses the per-model default; the others override it for subsequent turns.
 */
const EffortSelector: React.FC<EffortSelectorProps> = ({
  currentEffort,
  onEffortChange,
  disabled = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const currentEntry = EFFORT_LEVELS.find((e) => e.value === currentEffort) ?? EFFORT_LEVELS[0];

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 rounded-lg border dark:border-claude-darkBorder border-claude-border px-2 py-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:bg-claude-darkSurfaceInset hover:bg-claude-surfaceInset transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        title={i18nService.t('coworkEffortTitle')}
      >
        <span className="text-[11px]">{currentEntry.icon}</span>
        <span className={`font-medium ${currentEntry.color}`}>
          {i18nService.t(currentEntry.labelKey)}
        </span>
      </button>
      {isOpen && (
        <div className="absolute right-0 bottom-full mb-2 w-56 rounded-xl shadow-xl dark:bg-claude-darkBg bg-claude-bg dark:border-claude-darkBorder border-claude-border border p-1.5 z-50">
          <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
            {i18nService.t('coworkEffortTitle')}
          </div>
          {EFFORT_LEVELS.map((entry) => (
            <button
              key={entry.value ?? 'auto'}
              type="button"
              onClick={() => {
                onEffortChange(entry.value);
                setIsOpen(false);
              }}
              className={`w-full flex items-start gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                entry.value === currentEffort
                  ? 'dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset'
                  : 'hover:dark:bg-claude-darkSurfaceInset/60 hover:bg-claude-surfaceInset/60'
              }`}
            >
              <span className="text-[11px] mt-0.5">{entry.icon}</span>
              <div className="min-w-0 flex-1">
                <div className={`font-medium ${entry.value === currentEffort ? entry.color : 'dark:text-claude-darkText text-claude-text'}`}>
                  {i18nService.t(entry.labelKey)}
                  {entry.value === currentEffort && <span className="ml-1">✓</span>}
                </div>
                <div className="dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60 mt-0.5 leading-relaxed">
                  {i18nService.t(entry.descKey)}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default EffortSelector;
