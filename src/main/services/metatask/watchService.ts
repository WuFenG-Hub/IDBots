import type { MetaTaskAlert, MetaTaskTaskProjection } from './types';
import type { MetaTaskProjectionStore } from './projectionStore';

export interface MetaTaskWatchDeps {
  store: () => MetaTaskProjectionStore;
  rosterMetaIds: () => string[];
  /** Push hook fired when new alerts landed (bumps the renderer). */
  onAlerts?: (alerts: MetaTaskAlert[]) => void;
}

const ALERT_HORIZON_MS = 48 * 3_600_000;
const CLAIM_TTL_SOON_MS = 6 * 3_600_000;
const CLAIM_TTL_DEDUPE_MS = 6 * 3_600_000;
const CLOSING_DRIVE_STALL_MS = 24 * 3_600_000;
const CLOSING_DRIVE_DEDUPE_MS = 24 * 3_600_000;

/**
 * The `metatask.watch` heartbeat handler (P2). Local, cheap checks over the
 * refreshed projection — never a chain read on its own:
 *
 *  - my-claim TTL expiring soon (holder is a local bot, no submission yet)
 *  - status changes on nodes a local bot holds or submitted (verified /
 *    rejected / reopened / disputed transitions)
 *  - publisher closing-drive: a task I publish whose aggregation nodes sit
 *    open with no activity for a day (the pilot #02 stall pattern)
 *
 * Alerts decay after 48h; one-shot notices are deduped per kind+node. In-app
 * surfacing only — session escalation stays with the long-term task system.
 */
export class MetaTaskWatchService {
  private readonly deps: MetaTaskWatchDeps;

  constructor(deps: MetaTaskWatchDeps) {
    this.deps = deps;
  }

  run(nowMs: number): void {
    const store = this.deps.store();
    const roster = new Set(this.deps.rosterMetaIds().filter(Boolean));
    store.pruneAlerts(ALERT_HORIZON_MS, nowMs);
    if (roster.size === 0) return;

    const board = store.board(Array.from(roster));
    const prev = new Map<string, string>();
    for (const row of store.getWatchStatuses()) {
      prev.set(`${row.root} ${row.node}`, row.status);
    }
    const existing = store.listAlerts(200);
    const recent = (kind: string, root: string, node: string | null, withinMs: number): boolean =>
      existing.some(
        (alert) =>
          alert.kind === kind &&
          alert.rootPinId === root &&
          alert.node === node &&
          nowMs - alert.createdAtMs < withinMs
      );

    const nextStatuses: { root: string; node: string; status: string }[] = [];
    const newAlerts: MetaTaskAlert[] = [];

    for (const summary of board.tasks) {
      // Only watch tasks the local roster touches (publishes or participates in).
      if (!summary.myRoles.includes('publisher') && !summary.myRoles.includes('participant')) continue;
      const projection: MetaTaskTaskProjection | null = store.getProjection(summary.rootPinId);
      if (!projection) continue;
      const statusKey = (status: string, disputed: boolean): string => `${status}${disputed ? '+' : ''}`;

      for (const node of Object.values(projection.nodeStates)) {
        const key = statusKey(node.status, node.disputed);
        nextStatuses.push({ root: projection.rootPinId, node: node.id, status: key });

        const mineInvolved =
          (node.holder !== null && roster.has(node.holder.claimant)) ||
          (node.submission !== null && roster.has(node.submission.submitter));
        if (mineInvolved) {
          const prevKey = prev.get(`${projection.rootPinId} ${node.id}`);
          if (prevKey && prevKey !== key) {
            newAlerts.push({
              kind: 'submission_change',
              rootPinId: projection.rootPinId,
              node: node.id,
              detail: `${prevKey}->${key}`,
              createdAtMs: nowMs,
            });
          }
          // My live claim without a submission: TTL countdown warning.
          if (
            node.holder &&
            roster.has(node.holder.claimant) &&
            !node.submission &&
            projection.policy.claimTtlHours > 0
          ) {
            const deadline = node.holder.sinceMs + projection.policy.claimTtlHours * 3_600_000;
            if (nowMs < deadline && deadline - nowMs < CLAIM_TTL_SOON_MS) {
              if (!recent('claim_ttl_soon', projection.rootPinId, node.id, CLAIM_TTL_DEDUPE_MS)) {
                newAlerts.push({
                  kind: 'claim_ttl_soon',
                  rootPinId: projection.rootPinId,
                  node: node.id,
                  detail: `expires in ${Math.max(1, Math.round((deadline - nowMs) / 3_600_000))}h`,
                  createdAtMs: nowMs,
                });
              }
            }
          }
        }
      }

      // Publisher closing-drive nudge: aggregation nodes open, task stalled.
      if (summary.myRoles.includes('publisher') && !projection.taskComplete) {
        const openAggregates = projection.nodes.filter(
          (treeNode) =>
            treeNode.kind === 'aggregate' &&
            projection.nodeStates[treeNode.id]?.status === 'open'
        );
        const stalled = nowMs - projection.lastActivityMs > CLOSING_DRIVE_STALL_MS;
        if (openAggregates.length > 0 && stalled) {
          if (!recent('closing_drive', projection.rootPinId, null, CLOSING_DRIVE_DEDUPE_MS)) {
            newAlerts.push({
              kind: 'closing_drive',
              rootPinId: projection.rootPinId,
              node: openAggregates[0].id,
              detail: `${openAggregates.length} open aggregation node(s)`,
              createdAtMs: nowMs,
            });
          }
        }
      }
    }

    if (nextStatuses.length > 0) store.setWatchStatuses(nextStatuses);
    if (newAlerts.length > 0) {
      store.appendAlerts(newAlerts);
      this.deps.onAlerts?.(newAlerts);
    }
  }
}
