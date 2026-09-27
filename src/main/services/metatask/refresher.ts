import { collectMetaTaskEvents, type CollectMetaTaskEventsOptions } from './collector';
import { replayMetaTask } from './engine';
import type { MetaTaskBoard, MetaTaskTaskProjection } from './types';
import type { MetaTaskProjectionStore } from './projectionStore';

export interface MetaTaskRefresherOptions {
  store: () => MetaTaskProjectionStore;
  rosterMetaIds?: () => string[];
  collectOptions?: CollectMetaTaskEventsOptions;
  /** Push hook: called with the bumped seq after every successful refresh. */
  onUpdated?: (payload: { seq: number; reason: string }) => void;
}

/**
 * Chain → projection pipeline for the MetaTask tab (P1 read path):
 * collect the nine pools → cache events → replay every task root → persist
 * projections → board. The chain is the source of truth; everything in the
 * store is a rebuildable projection. A failed network sweep keeps the last
 * good projections and records the error for the freshness line.
 */
export class MetaTaskRefresher {
  private readonly options: MetaTaskRefresherOptions;
  private inFlight: Promise<{ ok: boolean; board: MetaTaskBoard | null; error: string | null }> | null = null;

  constructor(options: MetaTaskRefresherOptions) {
    this.options = options;
  }

  board(): MetaTaskBoard {
    return this.options.store().board(this.roster());
  }

  detail(rootPinId: string): MetaTaskTaskProjection | null {
    return this.options.store().getProjection(rootPinId);
  }

  /** All cached chain events — engine input for guards and replays. */
  loadEvents(): import('./types').MetaTaskChainEvent[] {
    return this.options.store().loadEvents();
  }

  private roster(): string[] {
    return this.options.rosterMetaIds ? this.options.rosterMetaIds() : [];
  }

  refreshOnce(reason: string): Promise<{ ok: boolean; board: MetaTaskBoard | null; error: string | null }> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runRefresh(reason).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runRefresh(reason: string): Promise<{ ok: boolean; board: MetaTaskBoard | null; error: string | null }> {
    const store = this.options.store();
    store.setRefreshing(true);
    try {
      const collected = await collectMetaTaskEvents(this.options.collectOptions);
      store.upsertEvents(collected.events);
      const allEvents = store.loadEvents();
      const roots = allEvents.filter((event) => event.path === 'task');
      const projections: MetaTaskTaskProjection[] = [];
      for (const root of roots) {
        try {
          projections.push(replayMetaTask(allEvents, { rootPinId: root.pinId, now: Date.now() }));
        } catch {
          // one malformed task must not fail the sweep; next refresh retries it
        }
      }
      store.saveProjections(projections);
      const boundaryBlock = projections.reduce(
        (max, projection) => Math.max(max, projection.freshness.boundaryBlock),
        -1
      );
      store.markRefreshDone(true, null, boundaryBlock);
      const seq = store.bumpSeq();
      this.options.onUpdated?.({ seq, reason });
      return { ok: true, board: store.board(this.roster()), error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.markRefreshDone(false, message, -1);
      return { ok: false, board: store.board(this.roster()), error: message };
    }
  }
}
