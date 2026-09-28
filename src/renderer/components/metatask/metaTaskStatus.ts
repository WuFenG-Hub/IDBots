import { i18nService } from '../../services/i18n';
import type { MetaTaskNodeProjection } from '../../types/metatask';

/**
 * Task-level lifecycle shown on cards and the detail header. Distinct from
 * per-node status (open/claimed/verified): a task is complete when the ROOT
 * node verifies, and settled once the settlement manifest exists (complete +
 * no open challenges). Legacy pre-v1.2 tasks can settle below 100% node
 * progress (root verification completed them under the grandfathered rules).
 */
export type MetaTaskLifeStatus = 'open' | 'inProgress' | 'completed' | 'settled';

export const metaTaskLifeStatus = (input: {
  taskComplete: boolean;
  settlementFinalized: boolean;
  progress: { verified: number; claimed: number };
  participantCount: number;
}): MetaTaskLifeStatus => {
  if (input.settlementFinalized) return 'settled';
  if (input.taskComplete) return 'completed';
  if (input.progress.verified + input.progress.claimed > 0 || input.participantCount > 0) {
    return 'inProgress';
  }
  return 'open';
};

export const metaTaskLifeStatusTone: Record<MetaTaskLifeStatus, string> = {
  open: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300',
  inProgress: 'bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-400',
  completed:
    'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/60',
  settled: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400',
};

export const metaTaskLifeStatusLabel = (status: MetaTaskLifeStatus): string =>
  i18nService.t(`metatask.taskStatus.${status}`);

/** Per-node status label (open/claimed/verified) with a raw-status fallback. */
export const metaTaskNodeStatusLabel = (status: string): string =>
  i18nService.t(`metatask.status.${status}`) === `metatask.status.${status}`
    ? status
    : i18nService.t(`metatask.status.${status}`);

/** parent-id -> children map (children sorted by natural node id) for tree rendering. */
export const metaTaskChildrenOf = (
  nodes: MetaTaskNodeProjection[],
): Map<string, MetaTaskNodeProjection[]> => {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const childrenOf = new Map<string, MetaTaskNodeProjection[]>();
  for (const node of nodes) {
    if (node.parent && byId.has(node.parent)) {
      const list = childrenOf.get(node.parent) ?? [];
      list.push(node);
      childrenOf.set(node.parent, list);
    }
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  }
  return childrenOf;
};

/** Verified/total across all descendants (the group node itself excluded). */
export const metaTaskSubtreeStats = (
  childrenOf: Map<string, MetaTaskNodeProjection[]>,
  id: string,
): { verified: number; total: number } => {
  let verified = 0;
  let total = 0;
  const walk = (nid: string): void => {
    for (const child of childrenOf.get(nid) ?? []) {
      total += 1;
      if (child.status === 'verified') verified += 1;
      walk(child.id);
    }
  };
  walk(id);
  return { verified, total };
};

/** A group worth default-expanding: any descendant in flight or disputed. */
export const metaTaskSubtreeHasAttention = (
  childrenOf: Map<string, MetaTaskNodeProjection[]>,
  id: string,
): boolean =>
  (childrenOf.get(id) ?? []).some(
    (child) =>
      child.status === 'claimed' || child.disputed || metaTaskSubtreeHasAttention(childrenOf, child.id),
  );

