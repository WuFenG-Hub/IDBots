import React, { useState, useRef, useEffect } from 'react';
import {
  LockClosedIcon,
  ShieldCheckIcon,
  PencilSquareIcon,
  BoltIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { CoworkPermissionMode } from '../../types/cowork';

interface PermissionModeSelectorProps {
  /** Session id for mid-session switching; omitted during new-session creation. */
  sessionId?: string;
  currentMode: CoworkPermissionMode;
  onModeChange: (mode: CoworkPermissionMode) => void;
  disabled?: boolean;
}

const MODE_ORDER: CoworkPermissionMode[] = ['default', 'plan', 'acceptEdits', 'bypassPermissions'];

/**
 * Compact inline permission-mode selector for the cowork session header.
 * Lets users switch between default / plan / acceptEdits / bypassPermissions
 * mid-session. The change takes effect immediately for subsequent tool calls.
 */
const PermissionModeSelector: React.FC<PermissionModeSelectorProps> = ({
  currentMode,
  onModeChange,
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

  const ModeIcon = (mode: CoworkPermissionMode): React.ReactElement => {
    switch (mode) {
      case 'plan': return <ShieldCheckIcon className="h-3.5 w-3.5 flex-shrink-0" />;
      case 'acceptEdits': return <PencilSquareIcon className="h-3.5 w-3.5 flex-shrink-0" />;
      case 'bypassPermissions': return <BoltIcon className="h-3.5 w-3.5 flex-shrink-0" />;
      default: return <LockClosedIcon className="h-3.5 w-3.5 flex-shrink-0" />;
    }
  };

  const modeColor = (mode: CoworkPermissionMode): string => {
    switch (mode) {
      case 'plan': return 'text-blue-500';
      case 'acceptEdits': return 'text-amber-500';
      // Full-trust mode uses the brand/primary accent (same as the main send
      // button) instead of red, which read as alarming.
      case 'bypassPermissions': return 'text-claude-accent';
      default: return 'text-claude-accent';
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 rounded-lg border dark:border-claude-darkBorder border-claude-border px-2 py-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:bg-claude-darkSurfaceInset hover:bg-claude-surfaceInset transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        title={i18nService.t('coworkPermissionModeTitle')}
      >
        <span className={`flex items-center ${modeColor(currentMode)}`}>
          {ModeIcon(currentMode)}
        </span>
        <span className={`font-medium ${modeColor(currentMode)}`}>
          {i18nService.t(`coworkPermissionMode_${currentMode}`)}
        </span>
      </button>
      {isOpen && (
        <div className="absolute right-0 bottom-full mb-2 w-56 rounded-xl shadow-xl dark:bg-claude-darkBg bg-claude-bg dark:border-claude-darkBorder border-claude-border border p-1.5 z-50">
          <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
            {i18nService.t('coworkPermissionModeTitle')}
          </div>
          {MODE_ORDER.map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => {
                onModeChange(mode);
                setIsOpen(false);
              }}
              className={`w-full flex items-start gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                mode === currentMode
                  ? 'dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset'
                  : 'hover:dark:bg-claude-darkSurfaceInset/60 hover:bg-claude-surfaceInset/60'
              }`}
            >
              <span className={`mt-0.5 ${mode === currentMode ? modeColor(mode) : 'text-claude-textSecondary dark:text-claude-darkTextSecondary'}`}>
                {ModeIcon(mode)}
              </span>
              <div className="min-w-0 flex-1">
                <div className={`font-medium ${mode === currentMode ? modeColor(mode) : 'dark:text-claude-darkText text-claude-text'}`}>
                  {i18nService.t(`coworkPermissionMode_${mode}`)}
                  {mode === currentMode && <span className="ml-1">✓</span>}
                </div>
                <div className="dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60 mt-0.5 leading-relaxed">
                  {i18nService.t(`coworkPermissionMode_${mode}_desc`)}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default PermissionModeSelector;
