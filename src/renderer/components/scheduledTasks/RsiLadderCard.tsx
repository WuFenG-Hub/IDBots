import React, { useCallback, useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { rsiLadderService } from '../../services/rsiLadder';
import { ArrowPathIcon } from '@heroicons/react/24/outline';
import type { RsiLadderLayer, RsiLadderSnapshot } from '../../types/rsiLadder';

/**
 * RSI 爬梯卡 —— 跟踪任务入口下的独立顶层星标卡（需求稿 §2.4/§2.5，
 * pin://8f14471ccc2a7340893e142f3391de9be701e4ffcd4ce6c8bb7d5644fd5ef552i0）。
 *
 * 只读视图：挂载于 ScheduledTasksView 顶层（不占长期任务看板五列表，
 * 与 MetaTask 卡互不隶属 §4）；计数/徽章/层判据全部来自主进程对链上
 * taskkey=local:88 登记链的重算投影，本组件零推导。
 */
const LEVEL_LABEL_KEYS: Record<number, string> = {
  0: 'rsiLadder.level.L0',
  1: 'rsiLadder.level.L1',
  2: 'rsiLadder.level.L2',
  3: 'rsiLadder.level.L3',
  4: 'rsiLadder.level.L4',
};

const LEVEL_CHIP_CLASS: Record<number, string> = {
  0: 'bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover text-claude-textSecondary dark:text-claude-darkTextSecondary',
  1: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  2: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  3: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  4: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
};

const formatTime = (ms: number): string => {
  try {
    return new Date(ms).toLocaleString(undefined, { hour12: false });
  } catch {
    return String(ms);
  }
};

/** 证据直链用 app 级事件在 Bot Browser 打开（同 groupTaskUtils.openGroupTaskUri 的机制）。 */
const openOnChainUri = (uri: string): void => {
  window.dispatchEvent(new CustomEvent('botBrowser:openUri', { detail: { uri } }));
};

const EvidenceLinks: React.FC<{ uris: string[] }> = ({ uris }) => {
  if (uris.length === 0) {
    return <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('rsiLadder.layer.empty')}</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {uris.map((uri) => (
        <button
          key={uri}
          type="button"
          onClick={() => openOnChainUri(uri)}
          title={uri}
          className="non-draggable max-w-[220px] truncate rounded border dark:border-claude-darkBorder border-claude-border px-1.5 py-0.5 font-mono text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
        >
          {uri.replace(/^pin:\/\//, '').slice(0, 8)}…
        </button>
      ))}
    </span>
  );
};

const LayerRow: React.FC<{ layer: RsiLadderLayer; isCurrent: boolean }> = ({ layer, isCurrent }) => (
  <div className="flex items-start gap-2 py-1">
    <span
      className={`non-draggable mt-px inline-flex h-5 shrink-0 items-center rounded px-1.5 text-[11px] font-semibold ${LEVEL_CHIP_CLASS[layer.level] ?? LEVEL_CHIP_CLASS[0]}`}
      title={i18nService.t(LEVEL_LABEL_KEYS[layer.level])}
    >
      L{layer.level}
      {isCurrent ? ' ★' : ''}
    </span>
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span className="text-xs dark:text-claude-darkText text-claude-text">
          {i18nService.t(LEVEL_LABEL_KEYS[layer.level])}
        </span>
        <span className={`text-[10px] ${layer.met ? 'text-emerald-600 dark:text-emerald-400' : 'dark:text-claude-darkTextSecondary text-claude-textSecondary'}`}>
          {layer.met ? '✓' : '—'}
        </span>
      </div>
      <EvidenceLinks uris={layer.evidenceUris} />
    </div>
  </div>
);

const RsiLadderCard: React.FC = () => {
  const [snapshot, setSnapshot] = useState<RsiLadderSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(true);

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    try {
      const result = await rsiLadderService.snapshot({ refresh });
      if (result.success && result.snapshot) {
        setSnapshot(result.snapshot);
        setError(null);
      } else {
        setError(result.error ?? i18nService.t('rsiLadder.error.generic'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  return (
    <div className="mx-4 mt-3 rounded-xl border dark:border-claude-darkBorder border-claude-border bg-claude-surface dark:bg-claude-darkSurface px-3 py-2.5 shrink-0">
      <div className="flex items-center gap-2">
        <span className="text-sm" aria-hidden>⭐</span>
        <span className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
          {i18nService.t('rsiLadder.title')}
        </span>
        {snapshot && (
          <span
            className={`non-draggable inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${LEVEL_CHIP_CLASS[snapshot.badge.level]}`}
            title={i18nService.t('rsiLadder.badge.current')}
          >
            {i18nService.t('rsiLadder.badge.current')} L{snapshot.badge.level} · {i18nService.t(LEVEL_LABEL_KEYS[snapshot.badge.level])}
          </span>
        )}
        <span className="flex-1" />
        {snapshot && (
          <span
            className={`non-draggable inline-flex items-center rounded-full px-2 py-0.5 text-[11px] ${
              snapshot.judgment.met
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover text-claude-textSecondary dark:text-claude-darkTextSecondary'
            }`}
            title={i18nService.t('rsiLadder.judgment.title')}
          >
            J: {snapshot.judgment.current}/{snapshot.judgment.needed} {snapshot.judgment.met ? '✓' : ''}
          </span>
        )}
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading}
          aria-label={i18nService.t('rsiLadder.refresh')}
          title={i18nService.t('rsiLadder.refresh')}
          className="non-draggable inline-flex h-6 w-6 items-center justify-center rounded dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:opacity-50"
        >
          <ArrowPathIcon className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="non-draggable text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text"
        >
          {expanded ? i18nService.t('rsiLadder.collapse') : i18nService.t('rsiLadder.expand')}
        </button>
      </div>

      {snapshot && (
        <>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
            <span title={i18nService.t('rsiLadder.count.c')}>c(W0)={snapshot.counts.c}</span>
            <span title={i18nService.t('rsiLadder.count.p')}>p(W0)={snapshot.counts.p}</span>
            <span title={i18nService.t('rsiLadder.count.owner')}>c_owner(W0)={snapshot.counts.cOwner}</span>
            <span title={i18nService.t('rsiLadder.count.invalid')}>{i18nService.t('rsiLadder.count.invalid')}={snapshot.counts.invalid}</span>
            <span title={i18nService.t('rsiLadder.metaCount.title')}>{i18nService.t('rsiLadder.metaCount.title')} W0={snapshot.metaCount.w0} / W1={snapshot.metaCount.w1}</span>
            <span title={i18nService.t('rsiLadder.computedAt')}>{i18nService.t('rsiLadder.computedAt')} {formatTime(snapshot.computedAtMs)}</span>
            <span
              title={snapshot.fromChain ? i18nService.t('rsiLadder.source.chain') : i18nService.t('rsiLadder.source.cache')}
              className={snapshot.fromChain ? '' : 'text-amber-600 dark:text-amber-400'}
            >
              {snapshot.fromChain ? i18nService.t('rsiLadder.source.chain') : i18nService.t('rsiLadder.source.cache')}
            </span>
          </div>
          {snapshot.chainError && (
            <div className="mt-1 text-[11px] text-amber-600 dark:text-amber-400" title={snapshot.chainError}>
              {i18nService.t('rsiLadder.error.chain')}
            </div>
          )}
          {expanded && (
            <div className="mt-1.5 border-t dark:border-claude-darkBorder border-claude-border pt-1.5">
              {snapshot.layers.map((layer) => (
                <LayerRow key={layer.level} layer={layer} isCurrent={layer.level === snapshot.badge.level} />
              ))}
            </div>
          )}
        </>
      )}
      {error && (
        <div className="mt-1 text-[11px] text-red-500">{i18nService.t('rsiLadder.error.generic')}: {error}</div>
      )}
    </div>
  );
};

export default RsiLadderCard;
