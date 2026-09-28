import { i18nService } from '../../services/i18n';

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
