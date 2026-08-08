import type { SqliteDatabase as Database } from './sqliteTypes';

/**
 * SDK 内置定时任务（CronCreate/CronList/CronDelete）宿主侧镜像存储（方案 C R1）。
 *
 * 背景：SDK 升级后定时任务由 Agent 工具（CronCreate 等）管理，宿主进程无法直接调用；
 * 8/8 事故根因之一是宿主 sqlite store 与 SDK cron 双轨互不相通（幽灵任务不可见不可管理）。
 * 本模块把 SDK cron 以 cron `id` 为幂等键镜像进宿主 sqlite：
 *   - Stop hook 的 session_crons 字段（宿主可观测通道）→ upsert 镜像
 *   - `.claude/scheduled_tasks.json`（durable 任务落盘，实测格式见 parseScheduledTasksFile）→ 启动/定时扫描补充
 *   - 会话结束全量对账：SDK 侧已不存在的 cron 标记为 deleted（软删除，保留历史）
 * 镜像只用于展示与管理，不参与宿主 Scheduler 调度（避免双触发）。
 */

export type SdkCronMirrorStatus = 'active' | 'deletion_requested' | 'deleted';
export type SdkCronSource = 'stop_hook' | 'file_scan' | 'migration';

export interface SdkCronMirror {
  id: string;
  sessionId: string;
  /** 从 prompt 提取的展示名（首行截断）。 */
  name: string;
  /** 5 字段 cron 表达式。 */
  schedule: string;
  /** 人类可读调度描述（CronList 的 humanSchedule），可能为空。 */
  humanSchedule: string | null;
  recurring: boolean;
  durable: boolean;
  prompt: string;
  source: SdkCronSource;
  /** R2 迁移映射：原 scheduled_tasks.id；非迁移来源为 null。 */
  migratedTaskId: string | null;
  status: SdkCronMirrorStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionCronLike {
  id: string;
  schedule: string;
  recurring: boolean;
  prompt: string;
  humanSchedule?: string | null;
  durable?: boolean;
}

/** SDK Stop hook 输入中的 session_crons 元素形状（已核实 sdk.d.ts SessionCronSummary）。 */
export interface SdkStopSessionCron {
  id: string;
  schedule: string;
  recurring: boolean;
  prompt: string;
}

interface MirrorRow {
  id: string;
  session_id: string;
  name: string;
  schedule: string;
  human_schedule: string | null;
  recurring: number;
  durable: number;
  prompt: string;
  source: string;
  migrated_task_id: string | null;
  status: string;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

export const SDK_CRON_MIRROR_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS sdk_cron_mirror (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    name TEXT NOT NULL,
    schedule TEXT NOT NULL,
    human_schedule TEXT,
    recurring INTEGER NOT NULL,
    durable INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'stop_hook',
    migrated_task_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

export const SDK_CRON_MIRROR_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_sdk_cron_mirror_session
    ON sdk_cron_mirror(session_id, status);
`;

/**
 * 从 cron prompt 提取展示名：取首行、去空白，截断到 48 字符。
 * 空 prompt 回退为 '(unnamed cron)'。
 */
export function summarizeCronPrompt(prompt: string): string {
  const firstLine = (prompt || '').split('\n')[0].trim();
  if (!firstLine) return '(unnamed cron)';
  return firstLine.length > 48 ? `${firstLine.slice(0, 48)}…` : firstLine;
}

/**
 * SDK 对 cron prompt 的上限为 1000 字符（Stop hook 采集时会裁剪并加 "… [+N chars]" 标记）。
 * 镜像存储时宿主按同样规则提前截断，保证镜像与 SDK 事实一致。
 */
export function truncateCronPrompt(prompt: string, limit = 1000): string {
  const source = prompt || '';
  if (source.length <= limit) return source;
  const clipped = source.slice(0, limit);
  return `${clipped}… [+${source.length - limit} chars]`;
}

/**
 * 解析 durable 任务落盘文件 `.claude/scheduled_tasks.json`。
 * 实测格式（2026-08-09 会话内 CronCreate durable 实证）：
 *   { "tasks": [ { "id", "cron", "prompt", "createdAt", "recurring",
 *                  "createdBySessionId", "createdByPid", "createdByProcStart" } ] }
 * 文件中无 durable 字段——文件存在即意味着 durable（SDK 语义）。
 * createdBySessionId 用于镜像归属（创建该任务的会话）。
 */
export function parseScheduledTasksFile(
  content: string
): { id: string; schedule: string; recurring: boolean; prompt: string; durable: true; createdBySessionId: string | null }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  const tasks = (parsed as { tasks?: unknown })?.tasks;
  if (!Array.isArray(tasks)) return [];

  const result: { id: string; schedule: string; recurring: boolean; prompt: string; durable: true; createdBySessionId: string | null }[] = [];
  for (const item of tasks) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : null;
    const schedule = typeof record.cron === 'string' && record.cron.trim() ? record.cron.trim() : null;
    if (!id || !schedule) continue;
    result.push({
      id,
      schedule,
      recurring: record.recurring !== false,
      prompt: typeof record.prompt === 'string' ? record.prompt : '',
      durable: true,
      createdBySessionId:
        typeof record.createdBySessionId === 'string' && record.createdBySessionId.trim()
          ? record.createdBySessionId.trim()
          : null,
    });
  }
  return result;
}

export class SdkCronMirrorStore {
  private db: Database;
  private saveDb: () => void;

  constructor(db: Database, saveDb: () => void) {
    this.db = db;
    this.saveDb = saveDb;
    this.ensureTable();
  }

  ensureTable(): void {
    try {
      this.db.run(SDK_CRON_MIRROR_TABLE_SQL);
      this.db.run(SDK_CRON_MIRROR_INDEX_SQL);
      this.saveDb();
    } catch (error) {
      console.warn('Failed to ensure sdk_cron_mirror table:', error);
    }
  }

  private getOne<T>(sql: string, params: (string | number | null)[] = []): T | undefined {
    const result = this.db.exec(sql, params);
    if (!result[0]?.values[0]) return undefined;
    const columns = result[0].columns;
    const values = result[0].values[0];
    const row: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      row[col] = values[i];
    });
    return row as T;
  }

  private getAll<T>(sql: string, params: (string | number | null)[] = []): T[] {
    const result = this.db.exec(sql, params);
    if (!result[0]?.values) return [];
    const columns = result[0].columns;
    return result[0].values.map((values) => {
      const row: Record<string, unknown> = {};
      columns.forEach((col, i) => {
        row[col] = values[i];
      });
      return row as T;
    });
  }

  private rowToMirror(row: MirrorRow): SdkCronMirror {
    return {
      id: row.id,
      sessionId: row.session_id,
      name: row.name,
      schedule: row.schedule,
      humanSchedule: row.human_schedule ?? null,
      recurring: row.recurring === 1,
      durable: row.durable === 1,
      prompt: row.prompt,
      source: row.source as SdkCronSource,
      migratedTaskId: row.migrated_task_id ?? null,
      status: row.status as SdkCronMirrorStatus,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * 以 cron id 为幂等键写入/更新镜像。重复采集（Stop hook 多次、文件扫描与 hook 重叠）
   * 不会产生重复行；已被标记 deleted 的 cron 若重新出现则恢复 active。
   */
  upsert(
    cron: SessionCronLike,
    sessionId: string,
    source: SdkCronSource = 'stop_hook'
  ): SdkCronMirror {
    const now = new Date().toISOString();
    const existing = this.getOne<MirrorRow>('SELECT * FROM sdk_cron_mirror WHERE id = ?', [cron.id]);
    const name = summarizeCronPrompt(cron.prompt);
    const durable = cron.durable ?? false;
    const humanSchedule = cron.humanSchedule ?? null;

    if (existing) {
      // 任一来源重新看到该 cron（如文件扫描补充、会话重新活跃）都恢复 active。
      const status: SdkCronMirrorStatus =
        existing.status === 'deleted' ? 'active' : (existing.status as SdkCronMirrorStatus);
      this.db.run(
        `UPDATE sdk_cron_mirror
         SET session_id = ?, name = ?, schedule = ?, human_schedule = ?, recurring = ?,
             durable = ?, prompt = ?, source = ?, status = ?, last_seen_at = ?, updated_at = ?
         WHERE id = ?`,
        [
          sessionId, name, cron.schedule, humanSchedule,
          cron.recurring ? 1 : 0,
          durable ? 1 : 0,
          truncateCronPrompt(cron.prompt),
          source,
          status,
          now, now, cron.id,
        ]
      );
      this.saveDb();
      return this.getById(cron.id)!;
    }

    this.db.run(
      `INSERT INTO sdk_cron_mirror
        (id, session_id, name, schedule, human_schedule, recurring, durable,
         prompt, source, migrated_task_id, status, first_seen_at, last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active', ?, ?, ?, ?)`,
      [
        cron.id, sessionId, name, cron.schedule, humanSchedule,
        cron.recurring ? 1 : 0,
        durable ? 1 : 0,
        truncateCronPrompt(cron.prompt),
        source,
        now, now, now, now,
      ]
    );
    this.saveDb();
    return this.getById(cron.id)!;
  }

  /**
   * 会话结束全量对账（R1）：SDK 侧已不存在的 cron 标记 deleted。
   * 保留软删除行（历史可查、migration 映射不丢失）；durable 任务跨会话存活，
   * 不应因所属会话结束而被对账掉——durable 行仅在来自文件扫描/Stop hook 且当前
   * 会话明确结束时标记，这里只处理非 durable 行，durable 行由文件扫描对账兜底。
   */
  reconcileSession(sessionId: string, activeIds: string[]): number {
    const activeSet = new Set(activeIds);
    const rows = this.getAll<MirrorRow>(
      `SELECT * FROM sdk_cron_mirror
       WHERE session_id = ? AND status != 'deleted'`,
      [sessionId]
    );
    const now = new Date().toISOString();
    let changed = 0;
    for (const row of rows) {
      if (activeSet.has(row.id)) continue;
      // 非 durable 行：SDK 侧已消失 → 标记 deleted。
      // durable 行：即使会话结束也可能在其他会话中被唤醒，等待文件扫描对账，
      // 但若 Stop hook 明确未包含该 id 且它确实在落盘文件中存在，则保留 active。
      if (row.durable === 1) continue;
      this.db.run(
        `UPDATE sdk_cron_mirror SET status = 'deleted', updated_at = ? WHERE id = ?`,
        [now, row.id]
      );
      changed += 1;
    }
    if (changed > 0) this.saveDb();
    return changed;
  }

  /**
   * durable 文件扫描对账：对给定会话 cwd 下的 scheduled_tasks.json 做全量对账。
   * 返回 [新增/更新数, 标记删除数]。
   */
  reconcileDurableFile(sessionId: string, fileCrons: { id: string }[]): { upserted: number; deleted: number } {
    const activeIds = fileCrons.map((c) => c.id);
    const activeSet = new Set(activeIds);
    const rows = this.getAll<MirrorRow>(
      `SELECT * FROM sdk_cron_mirror WHERE session_id = ? AND status != 'deleted' AND durable = 1`,
      [sessionId]
    );
    const now = new Date().toISOString();
    let deleted = 0;
    for (const row of rows) {
      if (activeSet.has(row.id)) continue;
      this.db.run(
        `UPDATE sdk_cron_mirror SET status = 'deleted', updated_at = ? WHERE id = ?`,
        [now, row.id]
      );
      deleted += 1;
    }
    if (deleted > 0) this.saveDb();
    return { upserted: activeIds.length, deleted };
  }

  listMirrors(includeDeleted = false): SdkCronMirror[] {
    const rows = includeDeleted
      ? this.getAll<MirrorRow>('SELECT * FROM sdk_cron_mirror ORDER BY last_seen_at DESC')
      : this.getAll<MirrorRow>(`SELECT * FROM sdk_cron_mirror WHERE status != 'deleted' ORDER BY last_seen_at DESC`);
    return rows.map((row) => this.rowToMirror(row));
  }

  listActive(): SdkCronMirror[] {
    return this.listMirrors(false);
  }

  listBySession(sessionId: string): SdkCronMirror[] {
    const rows = this.getAll<MirrorRow>(
      `SELECT * FROM sdk_cron_mirror WHERE session_id = ? AND status != 'deleted' ORDER BY last_seen_at DESC`,
      [sessionId]
    );
    return rows.map((row) => this.rowToMirror(row));
  }

  getById(id: string): SdkCronMirror | null {
    const row = this.getOne<MirrorRow>('SELECT * FROM sdk_cron_mirror WHERE id = ?', [id]);
    return row ? this.rowToMirror(row) : null;
  }

  /** 在会话内发起删除时先标记，UI 显示「删除中」，SDK 对账确认后转 deleted。 */
  markDeletionRequested(id: string): SdkCronMirror | null {
    const existing = this.getById(id);
    if (!existing) return null;
    this.db.run(
      `UPDATE sdk_cron_mirror SET status = 'deletion_requested', updated_at = ? WHERE id = ?`,
      [new Date().toISOString(), id]
    );
    this.saveDb();
    return this.getById(id);
  }

  markDeleted(id: string): SdkCronMirror | null {
    const existing = this.getById(id);
    if (!existing) return null;
    this.db.run(
      `UPDATE sdk_cron_mirror SET status = 'deleted', updated_at = ? WHERE id = ?`,
      [new Date().toISOString(), id]
    );
    this.saveDb();
    return this.getById(id);
  }

  /** R2：记录镜像 cron ↔ 原 scheduled_tasks.id 的迁移映射。 */
  setMigrationMapping(id: string, taskId: string): SdkCronMirror | null {
    const existing = this.getById(id);
    if (!existing) return null;
    this.db.run(
      `UPDATE sdk_cron_mirror SET migrated_task_id = ?, updated_at = ? WHERE id = ?`,
      [taskId, new Date().toISOString(), id]
    );
    this.saveDb();
    return this.getById(id);
  }

  findByMigratedTaskId(taskId: string): SdkCronMirror | null {
    const row = this.getOne<MirrorRow>(
      'SELECT * FROM sdk_cron_mirror WHERE migrated_task_id = ? ORDER BY created_at DESC LIMIT 1',
      [taskId]
    );
    return row ? this.rowToMirror(row) : null;
  }

  findCronPromptMatch(sessionId: string, prompt: string): SdkCronMirror | null {
    const rows = this.getAll<MirrorRow>(
      `SELECT * FROM sdk_cron_mirror WHERE session_id = ? AND status != 'deleted'`,
      [sessionId]
    );
    const needle = prompt.trim();
    if (!needle) return null;
    for (const row of rows) {
      const mirrored = row.prompt.trim();
      // 精确匹配优先；Stop hook 对 >1000 字符的 prompt 会裁剪，匹配前缀即可。
      if (mirrored === needle || (needle.startsWith(mirrored.slice(0, 60)) && needle.length >= mirrored.length - 20)) {
        return this.rowToMirror(row);
      }
    }
    return null;
  }

  countActive(): number {
    const row = this.getOne<{ 'COUNT(*)': number }>(
      `SELECT COUNT(*) FROM sdk_cron_mirror WHERE status != 'deleted'`
    );
    return row?.['COUNT(*)'] ?? 0;
  }
}
