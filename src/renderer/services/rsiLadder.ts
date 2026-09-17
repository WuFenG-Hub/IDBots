import type { RsiLadderSnapshotResult } from '../types/rsiLadder';

/**
 * RSI 爬梯卡前端服务层 —— 只做「调 IPC + 交还快照」，不做任何推导。
 * 卡面计数 / 徽章 / 层判据一律取自主进程投影（src/main/services/rsiLadderCompute.ts）。
 */
class RsiLadderService {
  private api() {
    return window.electron?.rsiLadder ?? null;
  }

  async snapshot(input?: { refresh?: boolean }): Promise<RsiLadderSnapshotResult> {
    const api = this.api();
    if (!api) {
      return { success: false, error: 'window.electron.rsiLadder is missing on this build.' };
    }
    return api.snapshot(input ?? {});
  }
}

export const rsiLadderService = new RsiLadderService();
