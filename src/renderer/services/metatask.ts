import { store } from '../store';
import {
  setBoard,
  setBridgeMissing,
  setError,
  setLastSeq,
  setLoading,
  setRefreshing,
  selectTask as selectTaskAction,
  upsertDetail,
} from '../store/slices/metataskSlice';
import type { MetaTaskBoard, MetaTaskTaskProjection } from '../types/metatask';

const FALLBACK_POLL_MS = 60_000;

/**
 * MetaTask tab (P1 read path) — renderer service layer: IPC → Redux, no
 * derivation. Push frames (`metatask:update`) carry a monotonic seq; stale
 * frames are dropped. A 60s poll backstops a missed push (chain index lag is
 * a fact; every board payload also carries its boundary block for display).
 */
class MetaTaskService {
  private cleanupFns: (() => void)[] = [];
  private initialized = false;
  private lastPushAtMs = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const api = this.api();
    if (!api) {
      store.dispatch(
        setBridgeMissing(
          'window.electron.metatask is missing on this build: the renderer has no read path to the MetaTask projection.',
        )
      );
      return;
    }
    this.setupListeners(api);
    this.startFallbackPolling();
    await this.loadBoard();
  }

  destroy(): void {
    this.cleanupFns.forEach((fn) => fn());
    this.cleanupFns = [];
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.initialized = false;
  }

  private api() {
    return window.electron?.metatask ?? null;
  }

  private setupListeners(api: NonNullable<Window['electron']['metatask']>): void {
    if (typeof api.onUpdate !== 'function') return;
    const cleanup = api.onUpdate((data) => {
      if (typeof data?.seq === 'number') {
        const last = store.getState().metatask.lastSeq;
        if (data.seq <= last) return;
        store.dispatch(setLastSeq(data.seq));
      }
      this.lastPushAtMs = Date.now();
      void this.loadBoard();
      const openRoot = store.getState().metatask.selectedRootPinId;
      if (openRoot) void this.loadTask(openRoot);
    });
    this.cleanupFns.push(cleanup);
  }

  private startFallbackPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      if (Date.now() - this.lastPushAtMs < FALLBACK_POLL_MS) return;
      void this.loadBoard();
    }, FALLBACK_POLL_MS);
  }

  async loadBoard(): Promise<void> {
    const api = this.api();
    if (!api) return;
    store.dispatch(setLoading(true));
    try {
      const result = await api.board();
      if (result?.success && result.board) {
        store.dispatch(setBoard(result.board));
      } else {
        store.dispatch(setError(result?.error ?? 'Failed to read the MetaTask board'));
      }
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
    }
  }

  async loadTask(rootPinId: string): Promise<void> {
    const api = this.api();
    if (!api) return;
    try {
      const result = await api.get({ rootPinId });
      if (result?.success && result.detail) {
        store.dispatch(upsertDetail(result.detail));
      } else if (result?.error) {
        store.dispatch(setError(result.error));
      }
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
    }
  }

  async refresh(): Promise<void> {
    const api = this.api();
    if (!api) return;
    store.dispatch(setRefreshing(true));
    try {
      const result = await api.refresh();
      if (result?.board) store.dispatch(setBoard(result.board as MetaTaskBoard));
      else if (result?.error) store.dispatch(setError(result.error));
    } catch (err: unknown) {
      store.dispatch(setError(err instanceof Error ? err.message : String(err)));
    } finally {
      store.dispatch(setRefreshing(false));
    }
  }

  selectTask(rootPinId: string | null): void {
    store.dispatch(selectTaskAction(rootPinId));
  }
}

export type { MetaTaskBoard, MetaTaskTaskProjection };
export const metaTaskService = new MetaTaskService();
