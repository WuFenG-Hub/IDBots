import React, { useEffect } from 'react';
import { useSelector } from 'react-redux';
import { ArrowLeftIcon } from '@heroicons/react/24/outline';
import { RootState } from '../../store';
import { metaTaskService } from '../../services/metatask';
import { i18nService } from '../../services/i18n';
import type { MetaTaskNodeProjection } from '../../types/metatask';

const shortId = (metaId: string): string =>
  metaId.length > 14 ? `${metaId.slice(0, 8)}…${metaId.slice(-4)}` : metaId;

const statusTone: Record<string, string> = {
  open: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300',
  claimed: 'bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-400',
  verified: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400',
};

const statusLabel = (status: string): string =>
  i18nService.t(`metatask.status.${status}`) === `metatask.status.${status}`
    ? status
    : i18nService.t(`metatask.status.${status}`);

/** Task detail: node states (chain replay output), roster, settlement manifest.
 * Deep-link actions (publish / join) arrive with the P2 participation loop;
 * this view is read-only by design ("referenced, not mixed in"). */
const MetaTaskDetail: React.FC<{ rootPinId: string }> = ({ rootPinId }) => {
  const detail = useSelector((state: RootState) => state.metatask.details[rootPinId] ?? null);
  const rosterMetaIds = useSelector((state: RootState) => state.metatask.board?.localRosterMetaIds) ?? [];
  const rosterIds = new Set(rosterMetaIds);

  useEffect(() => {
    void metaTaskService.loadTask(rootPinId);
  }, [rootPinId]);

  if (!detail) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-4 py-3 border-b dark:border-claude-darkBorder border-claude-border">
          <button
            type="button"
            onClick={() => metaTaskService.selectTask(null)}
            className="inline-flex items-center gap-1 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text"
          >
            <ArrowLeftIcon className="h-4 w-4" />
            {i18nService.t('back')}
          </button>
        </div>
        <div className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary py-8 text-center">
          {i18nService.t('metatask.loading')}
        </div>
      </div>
    );
  }

  const roster = [...detail.participants].sort(
    (a, b) => b.verifiedContrib - a.verifiedContrib || a.metaId.localeCompare(b.metaId)
  );
  const nodes = Object.values(detail.nodeStates).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
        <button
          type="button"
          onClick={() => metaTaskService.selectTask(null)}
          className="inline-flex items-center gap-1 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text"
        >
          <ArrowLeftIcon className="h-4 w-4" />
          {i18nService.t('back')}
        </button>
        <h2 className="mt-1 text-base font-semibold dark:text-claude-darkText text-claude-text">
          {detail.title}
        </h2>
        <div className="mt-1 flex items-center gap-2 flex-wrap text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          <span>
            {i18nService.t('metatask.publisher')} {shortId(detail.publisher)}
          </span>
          <span>·</span>
          <span>
            {i18nService.t('metatask.progressVerified')
              .replace('{verified}', String(detail.progress.verified))
              .replace('{total}', String(detail.progress.total))}
          </span>
          <span>·</span>
          <span>
            {i18nService.t('metatask.freshnessBlock').replace('{block}', String(detail.freshness.boundaryBlock))}
          </span>
          <span>·</span>
          <span>
            {i18nService.t('metatask.events').replace('{count}', String(detail.freshness.eventCount))}
          </span>
        </div>
        {detail.brief && (
          <p className="mt-2 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">{detail.brief}</p>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4">
        {/* Nodes */}
        <section>
          <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text mb-2">
            {i18nService.t('metatask.nodes')}
          </h3>
          <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">ID</th>
                  <th className="text-left px-3 py-2 font-medium">{i18nService.t('metatask.nodeTitle')}</th>
                  <th className="text-left px-3 py-2 font-medium">{i18nService.t('metatask.statusLabel')}</th>
                  <th className="text-left px-3 py-2 font-medium">{i18nService.t('metatask.holder')}</th>
                  <th className="text-left px-3 py-2 font-medium">{i18nService.t('metatask.votes')}</th>
                </tr>
              </thead>
              <tbody className="divide-y dark:divide-claude-darkBorder divide-claude-border">
                {nodes.map((node: MetaTaskNodeProjection) => (
                  <tr key={node.id} className="dark:text-claude-darkText text-claude-text">
                    <td className="px-3 py-2 font-mono">{node.id}</td>
                    <td className="px-3 py-2 max-w-[240px] truncate" title={node.title}>
                      {node.title}
                      {node.weight !== null && (
                        <span className="ml-1 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                          ({(node.weight / 100).toFixed(2)}%)
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`px-1.5 py-0.5 rounded text-[11px] ${statusTone[node.status] ?? ''}`}>
                        {statusLabel(node.status)}
                        {node.disputed ? ` · ${i18nService.t('metatask.disputed')}` : ''}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {node.holder ? shortId(node.holder.claimant) : '—'}
                    </td>
                    <td className="px-3 py-2 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {node.passVotes}/{detail.policy.verifyQuorum}
                      {node.failVotes > 0 ? ` · ${node.failVotes} fail` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Roster */}
        <section>
          <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text mb-2">
            {i18nService.t('metatask.roster')}
          </h3>
          <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">MetaID</th>
                  <th className="text-left px-3 py-2 font-medium">{i18nService.t('metatask.claims')}</th>
                  <th className="text-left px-3 py-2 font-medium">{i18nService.t('metatask.verifiedContrib')}</th>
                  <th className="text-left px-3 py-2 font-medium">{i18nService.t('metatask.reviewVotes')}</th>
                </tr>
              </thead>
              <tbody className="divide-y dark:divide-claude-darkBorder divide-claude-border">
                {roster.map((participant) => (
                  <tr
                    key={participant.metaId}
                    className={rosterIds.has(participant.metaId) ? 'bg-brand/5' : 'dark:text-claude-darkText text-claude-text'}
                  >
                    <td className="px-3 py-2 font-mono">
                      {shortId(participant.metaId)}
                      {rosterIds.has(participant.metaId) && (
                        <span className="ml-1 text-[11px] text-brand">{i18nService.t('metatask.mineTag')}</span>
                      )}
                    </td>
                    <td className="px-3 py-2">{participant.effectiveClaims}</td>
                    <td className="px-3 py-2">{participant.verifiedContrib}</td>
                    <td className="px-3 py-2">{participant.reviewVotes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Settlement manifest */}
        {detail.settlement && (
          <section>
            <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text mb-2">
              {i18nService.t('metatask.settlement')}
            </h3>
            <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">MetaID</th>
                    <th className="text-left px-3 py-2 font-medium">{i18nService.t('metatask.shareBP')}</th>
                    <th className="text-left px-3 py-2 font-medium">%</th>
                  </tr>
                </thead>
                <tbody className="divide-y dark:divide-claude-darkBorder divide-claude-border">
                  {detail.settlement.shares.map((share) => (
                    <tr key={share.metaId} className="dark:text-claude-darkText text-claude-text">
                      <td className="px-3 py-2 font-mono">{shortId(share.metaId)}</td>
                      <td className="px-3 py-2">
                        {share.shareBP} bp
                        <span className="ml-1 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                          ({share.from.submittedBP}+{share.from.reviewedBP})
                        </span>
                      </td>
                      <td className="px-3 py-2">{(share.shareBP / 100).toFixed(2)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {detail.settlement.unpaidHistory.length > 0 && (
              <p className="mt-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('metatask.unpaidCount').replace(
                  '{count}',
                  String(detail.settlement.unpaidHistory.length)
                )}
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  );
};

export default MetaTaskDetail;
