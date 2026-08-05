import React, { useState, useRef, useEffect } from 'react';
import { i18nService } from '../../services/i18n';

interface AutoApproveRulesPanelProps {
  sessionId: string;
  getRules: (sessionId: string) => Promise<string[]>;
  addRule: (sessionId: string, toolName: string) => Promise<boolean>;
  removeRule: (sessionId: string, toolName: string) => Promise<boolean>;
  disabled?: boolean;
}

/**
 * Manage auto-approve tool rules for a cowork session. Rules are tool names
 * (case-insensitive) that the SDK PreToolUse hook auto-allows without prompting.
 * Hard denials (blocked web tools, plan mode, delete safety) always win.
 */
const AutoApproveRulesPanel: React.FC<AutoApproveRulesPanelProps> = ({
  sessionId,
  getRules,
  addRule,
  removeRule,
  disabled = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [rules, setRules] = useState<string[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void getRules(sessionId).then((loaded) => {
      if (!cancelled) setRules(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, getRules, sessionId]);

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

  const handleAdd = async () => {
    const toolName = inputValue.trim();
    if (!toolName) return;
    const added = await addRule(sessionId, toolName);
    if (added) {
      setRules((prev) => Array.from(new Set([...prev, toolName.toLowerCase()])).sort());
      setInputValue('');
      setError(null);
    } else {
      setError(i18nService.t('coworkAutoApproveAddFailed'));
    }
  };

  const handleRemove = async (toolName: string) => {
    const removed = await removeRule(sessionId, toolName);
    if (removed) {
      setRules((prev) => prev.filter((r) => r !== toolName));
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 rounded-lg border dark:border-claude-darkBorder border-claude-border px-2 py-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:bg-claude-darkSurfaceInset hover:bg-claude-surfaceInset transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        title={i18nService.t('coworkAutoApproveTitle')}
      >
        <span className="text-[11px]">✅</span>
        <span className="font-medium">{i18nService.t('coworkAutoApproveLabel')}</span>
        {rules.length > 0 && (
          <span className="rounded-full dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset px-1.5 text-[10px] font-semibold">
            {rules.length}
          </span>
        )}
      </button>
      {isOpen && (
        <div className="absolute right-0 bottom-full mb-2 w-64 rounded-xl shadow-xl dark:bg-claude-darkBg bg-claude-bg dark:border-claude-darkBorder border-claude-border border p-2 z-50">
          <div className="px-1 py-1 text-[10px] font-medium uppercase tracking-wider dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
            {i18nService.t('coworkAutoApproveTitle')}
          </div>
          <div className="flex items-center gap-1.5 px-1 pb-2">
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void handleAdd();
                }
              }}
              placeholder={i18nService.t('coworkAutoApprovePlaceholder')}
              className="flex-1 min-w-0 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface px-2 py-1 text-xs dark:text-claude-darkText text-claude-text placeholder:dark:text-claude-darkTextSecondary/50 placeholder:text-claude-textSecondary/50 focus:outline-none focus:ring-1 focus:ring-claude-accent/40"
            />
            <button
              type="button"
              onClick={() => void handleAdd()}
              className="flex-shrink-0 rounded-lg dark:bg-claude-accent/20 bg-claude-accent/10 px-2 py-1 text-xs font-medium text-claude-accent hover:dark:bg-claude-accent/30 hover:bg-claude-accent/20 transition-colors"
            >
              {i18nService.t('coworkAutoApproveAdd')}
            </button>
          </div>
          {error && (
            <div className="px-1 pb-1 text-[11px] text-red-500">{error}</div>
          )}
          <div className="max-h-48 overflow-y-auto">
            {rules.length === 0 ? (
              <div className="px-1 py-2 text-[11px] dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60">
                {i18nService.t('coworkAutoApproveEmpty')}
              </div>
            ) : (
              rules.map((rule) => (
                <div
                  key={rule}
                  className="flex items-center justify-between gap-2 rounded-lg px-1.5 py-1 text-xs dark:text-claude-darkText text-claude-text hover:dark:bg-claude-darkSurfaceInset/60 hover:bg-claude-surfaceInset/60"
                >
                  <span className="font-mono truncate">{rule}</span>
                  <button
                    type="button"
                    onClick={() => void handleRemove(rule)}
                    className="flex-shrink-0 text-[11px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                    title={i18nService.t('coworkAutoApproveRemove')}
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>
          <div className="mt-1.5 border-t dark:border-claude-darkBorder/60 border-claude-border/60 pt-1.5 px-1 text-[10px] leading-relaxed dark:text-claude-darkTextSecondary/50 text-claude-textSecondary/50">
            {i18nService.t('coworkAutoApproveHint')}
          </div>
        </div>
      )}
    </div>
  );
};

export default AutoApproveRulesPanel;
