import React, { useState } from 'react';
import { i18nService } from '../../../services/i18n';
import { useOwnerMetaApps } from './useOwnerMetaApps';
import { getCardVisual, getStatePill, buildShareUrl, getOwnerEmptyState } from './myAppsPresentation.js';
import ChainStatusModal from './ChainStatusModal';
import MetaAppPublishForm from './MetaAppPublishForm';
import MetaAppDetailModal from './MetaAppDetailModal';
import MetaAppDeleteModal from './MetaAppDeleteModal';
import type { OwnerMetaAppRecord } from '../../../types/metaAppOwner';

interface MyAppsTabProps {
  onRunByPin?: (pin: string) => Promise<boolean> | boolean;
}

const MyAppsTab: React.FC<MyAppsTabProps> = ({ onRunByPin }) => {
  const t = (k: string) => i18nService.t(k);
  const [botMenuOpen, setBotMenuOpen] = useState(false);
  const [toast, setToast] = useState('');
  const owner = useOwnerMetaApps();
  const modal = owner.modal;
  const empty = getOwnerEmptyState(t);

  const selectedBot = owner.bots.find((b) => b.id === owner.selectedBotId) || null;

  const handleShare = (record: OwnerMetaAppRecord) => {
    const url = buildShareUrl(record.pinId);
    navigator.clipboard?.writeText(url).then(
      () => setToast(t('myAppsShareCopied') || 'Share link copied'),
      () => setToast(url),
    );
    setTimeout(() => setToast(''), 2500);
  };

  const handleRun = (record: OwnerMetaAppRecord) => {
    if (record.disabled) return;
    void onRunByPin?.(record.pinId);
  };

  const cardCls = 'rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 overflow-hidden transition-colors hover:border-claude-accent/50 focus:outline-none focus:ring-2 focus:ring-claude-accent';

  return (
    <div className="space-y-4">
      {/* toolbar */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold dark:text-claude-darkText text-claude-text">{t('myAppsHeading') || 'My Apps'}</h2>
          <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{t('myAppsDescription') || 'Manage the MetaApps published by your local Bots.'}</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={owner.refresh} disabled={owner.loading || !selectedBot || !selectedBot?.mvcAddress}
            className="px-2.5 py-1.5 text-xs rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors disabled:opacity-50">
            {t('refresh') || 'Refresh'}
          </button>
          <button type="button" onClick={() => owner.setModal({ kind: 'publish' })} disabled={!selectedBot || !selectedBot.mvcAddress}
            className="btn-idchat-primary-filled px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60">
            {t('myAppsPublish') || 'Publish MetaApp'}
          </button>
        </div>
      </div>

      {/* bot filter */}
      {owner.bots.length > 0 ? (
        <div className="relative inline-block">
          <button type="button" onClick={() => setBotMenuOpen((v) => !v)}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text">
            <span>{t('myAppsLocalBot') || 'Local Bot'}:</span>
            <span className="font-medium">{selectedBot?.name || '—'}</span>
            <span className="text-xs">▾</span>
          </button>
          {botMenuOpen ? (
            <div className="absolute z-20 mt-1 w-56 max-h-64 overflow-auto rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-elevated">
              {owner.bots.map((b) => (
                <button key={b.id} type="button"
                  onClick={() => { owner.setSelectedBotId(b.id); setBotMenuOpen(false); }}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover ${b.id === owner.selectedBotId ? 'text-claude-accent font-medium' : 'dark:text-claude-darkText text-claude-text'}`}>
                  {b.name}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* notice */}
      {owner.notice ? (
        <div className="rounded-lg border border-amber-300 dark:border-amber-700/50 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {owner.notice}
        </div>
      ) : null}

      {/* empty states */}
      {!selectedBot && owner.bots.length === 0 ? (
        <div className="py-12 text-center">
          <div className="text-sm font-medium dark:text-claude-darkText text-claude-text">{empty.noBot.title}</div>
          <div className="mt-1 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">{empty.noBot.description}</div>
        </div>
      ) : selectedBot && !selectedBot.mvcAddress ? (
        <div className="py-12 text-center">
          <div className="text-sm font-medium dark:text-claude-darkText text-claude-text">{empty.noMvc.title}</div>
          <div className="mt-1 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">{empty.noMvc.description}</div>
        </div>
      ) : !owner.loading && owner.records.length === 0 ? (
        <div className="py-12 text-center">
          <div className="text-sm font-medium dark:text-claude-darkText text-claude-text">{empty.noApps.title}</div>
          <div className="mt-1 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">{empty.noApps.description}</div>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium dark:text-claude-darkText text-claude-text">
              {t('myAppsPublished') || 'Published MetaApps'} <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">({owner.records.length})</span>
            </h3>
          </div>
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(248px, 1fr))' }}>
            {owner.records.map((record) => {
              const visual = getCardVisual(record);
              const pill = getStatePill(record);
              return (
                <article key={record.pinId} tabIndex={0}
                  onClick={() => owner.setModal({ kind: 'detail', record })}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); owner.setModal({ kind: 'detail', record }); } }}
                  className={cardCls}>
                  <div className="relative h-[126px] overflow-hidden dark:bg-claude-darkBg bg-claude-bg">
                    {visual.cover ? (
                      <img src={visual.cover} alt="" className="absolute inset-0 h-full w-full object-cover"
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                    ) : (
                      // Placeholder cover when no cover image: subtle gradient + centered app initials.
                      <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-claude-accent/10 to-claude-surfaceHover/40 dark:from-claude-accent/10 dark:to-claude-darkSurfaceHover/30">
                        <span className="text-2xl font-bold text-claude-accent/60">
                          {(record.appName || record.title || 'MA').slice(0, 2).toUpperCase()}
                        </span>
                      </div>
                    )}
                    <div className="absolute left-2 bottom-2 h-10 w-10 rounded-lg overflow-hidden border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface flex items-center justify-center">
                      {visual.icon ? (
                        <img src={visual.icon} alt="" className="h-full w-full object-cover"
                          onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} />
                      ) : (
                        <span className="text-xs font-semibold text-claude-accent">
                          {(record.appName || 'MA').slice(0, 1).toUpperCase()}
                        </span>
                      )}
                    </div>
                    <span className={`absolute right-2 top-2 px-1.5 py-0.5 rounded text-[10px] font-medium ${pill.tone === 'warn' ? 'bg-amber-500/20 text-amber-600' : 'bg-emerald-500/20 text-emerald-600'}`}>
                      {t(pill.labelKey) || pill.label}
                    </span>
                  </div>
                  <div className="p-3 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate">{record.title || record.appName}</span>
                      <span className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary shrink-0">{record.version}</span>
                    </div>
                    <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary line-clamp-2">{record.intro || record.prompt}</p>
                    <div className="flex items-center gap-1.5">
                      <code className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">{record.pinId.slice(0, 10)}…</code>
                    </div>
                    <div className="flex items-center gap-1.5 pt-1">
                      <button type="button" onClick={(e) => { e.stopPropagation(); handleRun(record); }} disabled={record.disabled}
                        className="btn-idchat-primary-filled px-2 py-1 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-60">
                        {t('run') || 'Run'}
                      </button>
                      <button type="button" onClick={(e) => { e.stopPropagation(); owner.setModal({ kind: 'edit', record }); }}
                        className="px-2 py-1 text-[11px] rounded-md border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text">
                        {t('edit') || 'Edit'}
                      </button>
                      <button type="button" onClick={(e) => { e.stopPropagation(); handleShare(record); }}
                        className="px-2 py-1 text-[11px] rounded-md border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text">
                        {t('share') || 'Share'}
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>

          {/* pagination */}
          <div className="flex items-center justify-center gap-3 pt-1">
            <button type="button" onClick={owner.goPrev} disabled={owner.cursorStack.length <= 1}
              className="px-2.5 py-1 text-xs rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text disabled:opacity-40">
              ‹ {t('prev') || 'Prev'}
            </button>
            <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {t('page') || 'Page'} {owner.cursorStack.length}
            </span>
            <button type="button" onClick={owner.goNext} disabled={!owner.nextCursor}
              className="px-2.5 py-1 text-xs rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text disabled:opacity-40">
              {t('next') || 'Next'} ›
            </button>
          </div>
        </>
      )}

      {/* toast */}
      {toast ? (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 rounded-lg dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border px-3 py-2 text-xs shadow-elevated dark:text-claude-darkText text-claude-text">
          {toast}
        </div>
      ) : null}

      {/* modals */}
      {modal.kind === 'publish' ? (
        <MetaAppPublishForm mode="publish" metabotId={owner.selectedBotId!} metabotName={selectedBot?.name}
          submitting={owner.submitting}
          onUploadError={(m) => owner.setNotice(m)}
          onSubmit={(manifest) => void owner.submitPublish(manifest)}
          onCancel={() => owner.setModal({ kind: 'none' })} />
      ) : null}
      {modal.kind === 'edit' ? (
        <MetaAppPublishForm mode="edit" metabotId={owner.selectedBotId!} metabotName={selectedBot?.name}
          record={modal.record} submitting={owner.submitting}
          onUploadError={(m) => owner.setNotice(m)}
          onSubmit={(manifest) => void owner.submitEdit(modal.record, manifest)}
          onCancel={() => owner.setModal({ kind: 'none' })} />
      ) : null}
      {modal.kind === 'detail' ? (
        <MetaAppDetailModal record={modal.record}
          onRun={() => handleRun(modal.record)}
          onEdit={() => owner.setModal({ kind: 'edit', record: modal.record })}
          onDelete={() => owner.setModal({ kind: 'delete', record: modal.record })}
          onShare={() => handleShare(modal.record)}
          onClose={() => owner.setModal({ kind: 'none' })} />
      ) : null}
      {modal.kind === 'delete' ? (
        <MetaAppDeleteModal record={modal.record} busy={owner.submitting}
          onConfirm={() => void owner.submitDelete(modal.record)}
          onCancel={() => owner.setModal({ kind: 'none' })} />
      ) : null}
      {owner.chainStatus ? (
        <ChainStatusModal status={owner.chainStatus.status} txids={owner.chainStatus.txids} error={owner.chainStatus.error}
          onClose={() => owner.setChainStatus(null)} />
      ) : null}
    </div>
  );
};

export default MyAppsTab;
