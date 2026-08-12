import React, { useEffect, useRef, useState } from 'react';
import { ChevronDownIcon, CpuChipIcon } from '@heroicons/react/24/outline';
import TwinBadge from '../metabots/TwinBadge';

export type MetaBotForSelector = { id: number; name: string; avatar: string | null; metabot_type: string };

interface MetaBotSelectorProps {
  metabots: MetaBotForSelector[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  label: string;
  placeholder: string;
  /** Compact rendering for narrow surfaces (e.g. the Bot Browser side panel). */
  compact?: boolean;
  dropdownDirection?: 'up' | 'down';
}

const MetaBotSelector: React.FC<MetaBotSelectorProps> = ({
  metabots,
  selectedId,
  onSelect,
  label,
  placeholder,
  compact = false,
  dropdownDirection = 'down',
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);
  const selected = metabots.find((m) => m.id === selectedId) ?? metabots[0];

  const avatarSize = compact ? 'w-5 h-5' : 'w-7 h-7';
  const avatarIcon = compact ? 'h-3 w-3' : 'h-4 w-4';
  const buttonClass = compact
    ? 'w-full flex items-center gap-1.5 rounded-lg dark:bg-claude-darkSurface bg-claude-surface dark:border-claude-darkBorder border-claude-border border px-2 py-1 text-xs focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/40 cursor-pointer'
    : 'w-full flex items-center gap-2 rounded-lg dark:bg-claude-darkSurface bg-claude-surface dark:border-claude-darkBorder border-claude-border border px-5 py-3 text-base focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/40 cursor-pointer';
  const optionClass = compact
    ? 'w-full flex items-center gap-1.5 px-2 py-1.5 text-left text-xs hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors'
    : 'w-full flex items-center gap-2 px-5 py-3 text-left text-base hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors';

  const renderAvatar = (bot: MetaBotForSelector) => (
    bot.avatar && (bot.avatar.startsWith('data:') || bot.avatar.startsWith('http')) ? (
      <img src={bot.avatar} alt="" className={`${avatarSize} rounded-md object-cover flex-shrink-0`} />
    ) : (
      <div className={`${avatarSize} rounded-md dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover flex items-center justify-center flex-shrink-0`}>
        {compact ? (
          <span className="text-[8px] font-semibold dark:text-claude-darkText text-claude-text uppercase">
            {bot.name.slice(0, 2) || '?'}
          </span>
        ) : (
          <CpuChipIcon className={`${avatarIcon} dark:text-claude-darkTextSecondary text-claude-textSecondary`} />
        )}
      </div>
    )
  );

  return (
    <div className={compact ? 'flex items-center min-w-0' : 'flex items-center justify-center gap-3'}>
      {!compact && (
        <label className="text-sm font-medium dark:text-claude-darkText text-claude-text shrink-0">
          {label}
        </label>
      )}
      <div ref={containerRef} className={`relative ${compact ? 'min-w-0 flex-1' : 'min-w-[280px]'}`}>
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className={buttonClass}
          aria-label={placeholder}
          title={compact ? `${label}: ${selected?.name ?? placeholder}` : undefined}
        >
          {selected ? (
            <>
              {renderAvatar(selected)}
              <span className="truncate flex-1 text-left">{selected.name}</span>
              {selected.metabot_type === 'twin' && <TwinBadge className="shrink-0" />}
            </>
          ) : (
            <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{placeholder}</span>
          )}
          <ChevronDownIcon className={`${compact ? 'h-3 w-3' : 'h-4 w-4'} flex-shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </button>
        {isOpen && (
          <div className={`absolute left-0 right-0 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-popover z-50 overflow-hidden max-h-56 overflow-y-auto ${
            dropdownDirection === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}>
            {metabots.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  onSelect(m.id);
                  setIsOpen(false);
                }}
                className={`${optionClass} ${selectedId === m.id ? 'dark:bg-claude-darkSurfaceHover/50 bg-claude-surfaceHover/50' : ''}`}
              >
                {renderAvatar(m)}
                <span className="truncate flex-1">{m.name}</span>
                {m.metabot_type === 'twin' ? (
                  <TwinBadge className="shrink-0" />
                ) : (
                  <span className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary shrink-0">
                    ({m.metabot_type})
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default MetaBotSelector;
