/**
 * MetaBot List Card
 * Displays MetaBot with role and goal. Wallet, backup and delete actions live
 * deeper — in the Advanced tab of the edit view (see MetaBotAdvancedActionsSection).
 */

import React from 'react';
import { CpuChipIcon, DocumentDuplicateIcon, MoonIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { Metabot } from '../../types/metabot';
import TwinBadge from './TwinBadge';
import {
  buildMetaBotToggleViewModel,
  copyGlobalMetaIdToClipboard,
  formatGlobalMetaIdShort,
} from './metaBotCardPresentation.js';

interface MetaBotListCardProps {
  metabot: Metabot;
  onEdit: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  isChainSynced: boolean;
  onSyncToChain: () => void;
  onOpenMetabotInBrowser?: (metabot: Metabot) => void;
}

const MetaBotListCard: React.FC<MetaBotListCardProps> = ({
  metabot,
  onEdit,
  onToggleEnabled,
  isChainSynced,
  onSyncToChain,
  onOpenMetabotInBrowser,
}) => {
  const copyGlobalMetaId = (globalMetaId: string) => {
    copyGlobalMetaIdToClipboard(globalMetaId, navigator.clipboard).then((didCopy: boolean) => {
      if (!didCopy) return;
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('metabotGlobalMetaIdCopied') }));
    });
  };

  const globalMetaId = metabot.globalmetaid?.trim() ?? '';
  const shortGlobalMetaId = formatGlobalMetaIdShort(globalMetaId);
  const enabledToggleView = buildMetaBotToggleViewModel({
    enabled: metabot.enabled,
    variant: 'enable',
  });

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onEdit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onEdit();
        }
      }}
      className="rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 p-4 transition-colors hover:border-claude-accent/50 cursor-pointer text-left"
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex flex-col items-center gap-1.5 flex-shrink-0">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenMetabotInBrowser?.(metabot);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
              }}
              className="rounded-xl transition hover:ring-2 hover:ring-claude-accent/40 focus:outline-none focus:ring-2 focus:ring-claude-accent/60"
              title="Open in Bot Browser"
              aria-label="Open in Bot Browser"
            >
              {metabot.avatar && (metabot.avatar.startsWith('data:') || metabot.avatar.startsWith('http')) ? (
                <img
                  src={metabot.avatar}
                  alt=""
                  className="w-12 h-12 rounded-xl object-cover"
                />
              ) : (
                <div className="w-12 h-12 rounded-xl dark:bg-claude-darkSurface bg-claude-surface flex items-center justify-center">
                  <CpuChipIcon className="h-6 w-6 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                </div>
              )}
            </button>
            {shortGlobalMetaId && (
              <div className="flex items-center gap-1 max-w-[136px] text-[11px] leading-4 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                <span className="truncate">metaid:{shortGlobalMetaId}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    copyGlobalMetaId(globalMetaId);
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                  }}
                  className="shrink-0 p-0.5 rounded hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                  title={i18nService.t('metabotCopyGlobalMetaId')}
                  aria-label={i18nService.t('metabotCopyGlobalMetaId')}
                >
                  <DocumentDuplicateIcon className="h-3 w-3 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                </button>
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-base font-medium dark:text-claude-darkText text-claude-text truncate">
                {metabot.name}
              </span>
              {metabot.metabot_type === 'twin' && <TwinBadge />}
            </div>
            <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary truncate block">
              {metabot.role || '—'}
            </span>
          </div>
        </div>
        {metabot.dreaming && (
          <span
            className="inline-flex items-center justify-center text-claude-accent dark:text-claude-darkAccent shrink-0"
            title={i18nService.t('metabotDreaming')}
            aria-label={i18nService.t('metabotDreaming')}
          >
            <MoonIcon className="h-5 w-5 animate-pulse" aria-hidden />
          </span>
        )}
        <div
          className={enabledToggleView.trackClass}
          onClick={(e) => {
            e.stopPropagation();
            onToggleEnabled(!metabot.enabled);
          }}
          role="switch"
          aria-checked={metabot.enabled}
          title={metabot.enabled ? i18nService.t('metabotActive') : i18nService.t('metabotInactive')}
        >
          <div
            className={enabledToggleView.knobClass}
          />
        </div>
      </div>

      {metabot.goal && (
        <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-3 line-clamp-2">
          {metabot.goal}
        </p>
      )}

      {!isChainSynced && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSyncToChain();
          }}
          className="inline-flex items-center gap-2 text-xs text-red-500 dark:text-red-400 hover:underline"
          title={i18nService.t('metabotUnsyncedSyncNow')}
        >
          <span className="inline-block h-2 w-2 rounded-full bg-red-500 dark:bg-red-400" aria-hidden />
          <span>{i18nService.t('metabotUnsyncedSyncNow')}</span>
        </button>
      )}
    </div>
  );
};

export default MetaBotListCard;
