import React from 'react';
import { i18nService } from '../../services/i18n';
import { metaTaskNodeStatusLabel, metaTaskSubtreeStats } from './metaTaskStatus';
import type { MetaTaskNodeProjection } from '../../types/metatask';

/** One dot per node: color = status, amber ring = disputed. */
const dotTone = (node: MetaTaskNodeProjection): string =>
  `${
    node.status === 'verified'
      ? 'bg-emerald-400'
      : node.status === 'claimed'
        ? 'bg-sky-400'
        : 'bg-slate-300 dark:bg-slate-600'
  }${node.disputed ? ' ring-2 ring-amber-400' : ''}`;

/**
 * Structure overview ("task at a glance"): the root chip on top, one card per
 * aggregate group with a dot grid of its children, and loose dots for leaves
 * hanging directly under the root. Clicking a group card toggles it in the
 * node list below; clicking a dot jumps to that node and expands it.
 */
const MetaTaskTreeMap: React.FC<{
  root: MetaTaskNodeProjection | undefined;
  groups: MetaTaskNodeProjection[];
  topLeaves: MetaTaskNodeProjection[];
  childrenOf: Map<string, MetaTaskNodeProjection[]>;
  onSelectNode: (nodeId: string, groupId: string | null) => void;
  onToggleGroup: (groupId: string) => void;
}> = ({ root, groups, topLeaves, childrenOf, onSelectNode, onToggleGroup }) => {
  if (!root) return null;
  return (
    <section>
      <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text mb-2">
        {i18nService.t('metatask.treeMap')}
        <span className="ml-2 font-normal text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('metatask.treeMapHint')}
        </span>
      </h3>
      <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border px-3 py-3 space-y-3">
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => onSelectNode(root.id, null)}
            className="inline-flex items-center gap-1.5 max-w-[70%] px-2.5 py-1 rounded-lg border dark:border-claude-darkBorder border-claude-border text-xs dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          >
            <span className={`h-2 w-2 rounded-sm shrink-0 ${dotTone(root)}`} />
            <span className="font-mono shrink-0">{root.id}</span>
            <span className="truncate">{root.title}</span>
          </button>
        </div>
        {(groups.length > 0 || topLeaves.length > 0) && (
          <div className="mx-auto h-3 w-px bg-claude-border dark:bg-claude-darkBorder" />
        )}
        <div className="flex flex-wrap justify-center gap-2">
          {groups.map((group) => {
            const stats = metaTaskSubtreeStats(childrenOf, group.id);
            return (
              <div
                key={group.id}
                className="rounded-lg border dark:border-claude-darkBorder border-claude-border px-2 py-1.5 w-[132px]"
              >
                <button type="button" onClick={() => onToggleGroup(group.id)} className="w-full text-left">
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-mono text-[11px] dark:text-claude-darkText text-claude-text truncate">
                      {group.id}
                    </span>
                    <span className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary shrink-0">
                      {stats.verified}/{stats.total}
                    </span>
                  </div>
                  <div
                    className="truncate text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary"
                    title={group.title}
                  >
                    {group.title}
                  </div>
                </button>
                <div className="mt-1.5 flex flex-wrap gap-0.5">
                  {(childrenOf.get(group.id) ?? []).map((child) => (
                    <button
                      key={child.id}
                      type="button"
                      title={`${child.id} · ${child.title}`}
                      onClick={() => onSelectNode(child.id, group.id)}
                      className={`h-2 w-2 rounded-sm ${dotTone(child)}`}
                    />
                  ))}
                </div>
              </div>
            );
          })}
          {topLeaves.length > 0 && (
            <div className="rounded-lg border dark:border-claude-darkBorder border-claude-border px-2 py-1.5">
              <div className="flex flex-wrap gap-0.5 max-w-[180px]">
                {topLeaves.map((leaf) => (
                  <button
                    key={leaf.id}
                    type="button"
                    title={`${leaf.id} · ${leaf.title}`}
                    onClick={() => onSelectNode(leaf.id, null)}
                    className={`h-2 w-2 rounded-sm ${dotTone(leaf)}`}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="flex flex-wrap justify-center gap-x-3 gap-y-1 text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-slate-300 dark:bg-slate-600" />
            {metaTaskNodeStatusLabel('open')}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-sky-400" />
            {metaTaskNodeStatusLabel('claimed')}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-emerald-400" />
            {metaTaskNodeStatusLabel('verified')}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-slate-300 dark:bg-slate-600 ring-2 ring-amber-400" />
            {i18nService.t('metatask.disputed')}
          </span>
        </div>
      </div>
    </section>
  );
};

export default MetaTaskTreeMap;
