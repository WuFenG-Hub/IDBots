import React, { useEffect, useLayoutEffect } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../store';
import { ChevronDownIcon, CheckIcon, CpuChipIcon } from '@heroicons/react/24/outline';
import { setSelectedModel } from '../store/slices/modelSlice';
import { i18nService } from '../services/i18n';
import type { Model } from '../store/slices/modelSlice';

interface ModelSelectorProps {
  dropdownDirection?: 'up' | 'down';
  /** When set, only show models from this LLM provider (e.g. "deepseek"). */
  restrictToLlmId?: string | null;
  /**
   * When true, the trigger renders as an icon-only button (no model name text),
   * matching the icon-only buttons in the Bot Browser toolbar. The current model
   * name is still surfaced via the tooltip and stays selected in the dropdown.
   */
  compact?: boolean;
}

const ModelSelector: React.FC<ModelSelectorProps> = ({ dropdownDirection = 'down', restrictToLlmId, compact = false }) => {
  const dispatch = useDispatch();
  const [isOpen, setIsOpen] = React.useState(false);
  // When the trigger is a compact icon button in a narrow surface (e.g. the Bot
  // Browser sidebar), the fixed-width dropdown is positioned with `fixed` so its
  // right edge hugs the nearest clipping ancestor's right edge and it never gets
  // clipped by an `overflow-hidden` sidebar. `null` keeps the default absolute
  // positioning used by the full-size (non-compact) variant.
  const [menuPos, setMenuPos] = React.useState<React.CSSProperties | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const selectedModel = useSelector((state: RootState) => state.model.selectedModel);
  const availableModels = useSelector((state: RootState) => state.model.availableModels);

  const displayModels = React.useMemo((): Model[] => {
    if (!restrictToLlmId?.trim()) return availableModels;
    const llm = restrictToLlmId.trim().toLowerCase();
    return availableModels.filter(
      (m) => (m.provider ?? '').toLowerCase() === llm
    );
  }, [availableModels, restrictToLlmId]);

  useEffect(() => {
    if (!restrictToLlmId?.trim() || displayModels.length === 0) return;
    const inList = displayModels.some((m) => m.id === selectedModel.id);
    if (!inList) {
      dispatch(setSelectedModel(displayModels[0]));
    }
  }, [restrictToLlmId, displayModels, selectedModel.id, dispatch]);

  // 点击外部区域关闭下拉框
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // For the compact trigger, position the dropdown with `fixed` so its right
  // edge aligns with the nearest clipping ancestor's right edge and it opens
  // above the trigger regardless of sidebar width. Without this the fixed-width
  // menu would overflow (and be clipped by) the sidebar's `overflow-hidden`.
  const updateMenuPos = React.useCallback(() => {
    if (!compact) {
      setMenuPos(null);
      return;
    }
    const triggerEl = triggerRef.current;
    if (!triggerEl) return;
    // Walk up to the nearest ancestor that clips (overflow hidden/auto/scroll)
    // — this is the box whose right edge the menu must not cross.
    let clipEl: HTMLElement | null = triggerEl.parentElement;
    while (clipEl) {
      const style = getComputedStyle(clipEl);
      if (/hidden|auto|scroll/.test(style.overflowX) || /hidden|auto|scroll/.test(style.overflowY)) {
        break;
      }
      clipEl = clipEl.parentElement;
    }
    const clipRight = clipEl ? clipEl.getBoundingClientRect().right : window.innerWidth;
    const MENU_WIDTH = 208; // w-52
    const margin = 4;
    const rightSpace = clipRight - triggerEl.getBoundingClientRect().left;
    // If the natural left-aligned menu fits, keep it left-aligned to the trigger.
    // Otherwise pin the menu's right edge to the clip box's right edge.
    if (rightSpace >= MENU_WIDTH) {
      setMenuPos(null);
    } else {
      setMenuPos({
        position: 'fixed',
        // open upward, just above the trigger
        bottom: window.innerHeight - triggerEl.getBoundingClientRect().top + margin,
        right: Math.max(0, window.innerWidth - clipRight + margin),
        left: 'auto',
      });
    }
  }, [compact]);

  useLayoutEffect(() => {
    if (!isOpen || !compact) return;
    updateMenuPos();
    const onScrollOrResize = () => updateMenuPos();
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [isOpen, compact, updateMenuPos]);

  const handleModelSelect = (model: Model) => {
    dispatch(setSelectedModel(model));
    setIsOpen(false);
  };

  const emptyMessage = i18nService.t('noModelsConfigured');
  if (availableModels.length === 0) {
    return (
      <div className="px-3 py-1.5 rounded-xl dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkTextSecondary text-claude-textSecondary text-sm">
        {emptyMessage}
      </div>
    );
  }
  if (restrictToLlmId?.trim() && displayModels.length === 0) {
    return (
      <div className="px-3 py-1.5 rounded-xl dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkTextSecondary text-claude-textSecondary text-sm">
        {emptyMessage}
      </div>
    );
  }

  const dropdownPositionClass = dropdownDirection === 'up'
    ? 'bottom-full mb-1'
    : 'top-full mt-1';

  const currentModelName = displayModels.some((m) => m.id === selectedModel.id)
    ? selectedModel.name
    : displayModels[0]?.name ?? selectedModel.name;

  return (
    <div ref={containerRef} className="relative cursor-pointer">
      <button
        ref={triggerRef}
        onClick={() => setIsOpen(!isOpen)}
        className={compact
          ? `shrink-0 inline-flex items-center p-1.5 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:hover:text-claude-darkText hover:text-claude-text transition-colors cursor-pointer ${isOpen ? 'dark:bg-claude-darkSurfaceHover bg-claude-darkSurfaceHover dark:text-claude-darkText text-claude-text' : ''}`
          : `flex items-center space-x-2 px-3 py-1.5 rounded-xl dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:text-claude-darkText text-claude-text transition-colors cursor-pointer ${isOpen ? 'dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover' : ''}`
        }
        title={currentModelName}
        aria-label={currentModelName}
      >
        {compact ? (
          <CpuChipIcon className="h-4 w-4" />
        ) : (
          <span className="font-medium text-sm">{currentModelName}</span>
        )}
        <ChevronDownIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
      </button>

      {isOpen && (
        <div
          style={menuPos ?? undefined}
          className={`${menuPos ? '' : 'absolute '}${dropdownPositionClass} w-52 dark:bg-claude-darkSurface bg-claude-surface rounded-xl popover-enter shadow-popover z-50 dark:border-claude-darkBorder border-claude-border border overflow-hidden`}
        >
          <div className="max-h-64 overflow-y-auto">
          {displayModels.map((model) => (
            <button
              key={model.id}
              onClick={() => handleModelSelect(model)}
              className={`w-full px-4 py-2.5 text-left dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover flex items-center justify-between transition-colors ${
                model.id === (displayModels.some((m) => m.id === selectedModel.id) ? selectedModel.id : displayModels[0]?.id) ? 'dark:bg-claude-darkSurfaceHover/50 bg-claude-surfaceHover/50' : ''
              }`}
            >
              <div className="flex flex-col">
                <span className="text-sm">{model.name}</span>
                {model.provider && (
                  <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{model.provider}</span>
                )}
              </div>
              {model.id === (displayModels.some((m) => m.id === selectedModel.id) ? selectedModel.id : displayModels[0]?.id) && (
                <CheckIcon className="h-4 w-4 text-claude-accent" />
              )}
            </button>
          ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default ModelSelector;
