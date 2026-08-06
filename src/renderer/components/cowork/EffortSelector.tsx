import React, { useState, useRef, useEffect } from 'react';
import { Cog6ToothIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';

interface EffortSelectorProps {
  sessionId?: string;
  currentEffort: string | null;
  onEffortChange: (effort: string | null) => void;
  disabled?: boolean;
}

/**
 * Minimalist ascending-bar icon (1–4 bars) conveying reasoning effort /
 * intensity. Single-color, inherits currentColor so it matches the rest of
 * the cowork input's outline-icon style.
 */
const EffortBarsIcon: React.FC<{ level: 1 | 2 | 3 | 4; className?: string }> = ({ level, className = '' }) => {
  const heights = [4, 7, 10, 13];
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      className={`h-3.5 w-3.5 flex-shrink-0 ${className}`}
      aria-hidden="true"
    >
      {heights.map((h, i) => (
        <line
          key={i}
          x1={2 + i * 3.5}
          y1={15 - h}
          x2={2 + i * 3.5}
          y2={15}
          opacity={i < level ? 1 : 0.25}
        />
      ))}
    </svg>
  );
};

const EFFORT_LEVELS: Array<{ value: string | null; icon: React.ReactElement; labelKey: string; descKey: string; color: string }> = [
  { value: null, icon: <Cog6ToothIcon className="h-3.5 w-3.5 flex-shrink-0" />, labelKey: 'coworkEffort_auto', descKey: 'coworkEffort_auto_desc', color: 'text-claude-textSecondary' },
  { value: 'low', icon: <EffortBarsIcon level={1} />, labelKey: 'coworkEffort_low', descKey: 'coworkEffort_low_desc', color: 'text-green-500' },
  { value: 'medium', icon: <EffortBarsIcon level={2} />, labelKey: 'coworkEffort_medium', descKey: 'coworkEffort_medium_desc', color: 'text-blue-500' },
  { value: 'high', icon: <EffortBarsIcon level={3} />, labelKey: 'coworkEffort_high', descKey: 'coworkEffort_high_desc', color: 'text-amber-500' },
  { value: 'max', icon: <EffortBarsIcon level={4} />, labelKey: 'coworkEffort_max', descKey: 'coworkEffort_max_desc', color: 'text-claude-accent' },
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
        <span className={`flex items-center ${currentEntry.color}`}>
          {currentEntry.icon}
        </span>
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
              <span className={`mt-0.5 ${entry.value === currentEffort ? entry.color : 'text-claude-textSecondary dark:text-claude-darkTextSecondary'}`}>
                {entry.icon}
              </span>
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
