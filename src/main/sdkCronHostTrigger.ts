import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import type { SqliteDatabase as Database } from './sqliteTypes';
import { parseScheduledTasksFile, summarizeCronPrompt } from './sdkCronMirrorStore';

/**
 * 宿主触发桥（方案 C 补充）：SDK 定时任务的无人值守触发链路。
 *
 * 背景事实（2026-08-09 实测）：
 * - SDK cron 触发依赖会话进程活着（CronCreate 等工具注入给 bot 会话，宿主进程无法直接调用）；
 *   无活跃 Claude 会话时，到点的一次性 durable 任务会被 SDK 标记 missed 并从
 *   `.claude/scheduled_tasks.json` 删除——触发层无人值守能力缺失；
 * - 旧系统（src/main/libs/scheduler.ts）是宿主级触发：Electron 进程活着就能到点拉起会话执行。
 *
 * 本模块职责：宿主周期扫描 durable 落盘文件（复用 30 分钟扫描周期），对「已到点且无活跃会话」
 * 的任务复用旧 Scheduler 的拉起逻辑（createSession + addMessage + startSession）拉起 bot 会话
 * 执行任务 prompt，补上 SDK 侧缺失的触发链路。设计约束：
 * - 会话活跃（该 cwd 下有 running 会话，或 lock 文件被存活进程持有）时整体跳过该文件，
 *   避免与 SDK 自身触发双发；
 * - 任务级幂等：以 (cron_id, fire 实例时刻) 为键记录触发状态（sqlite 表 sdk_cron_host_trigger），
 *   同一点只触发一次；启动失败置 failed，下轮扫描重试（at-least-once）；
 * - 一次性任务触发后从落盘文件移除（镜像 SDK 触发后删除的行为）；recurring 任务保留文件条目，
 *    由 SDK 继续按 cron 调度；
 * - 7 天过期语义保持：recurring 任务超过 createdAt+7d 且无会话代为清理时，宿主按同样规则
 *   从文件移除，不绕过 SDK 限制；
 * - 会话结束推进：会话 Stop hook 携带其 cron 列表，宿主把该列表的触发状态推进到会话结束前
 *   最近一次 cron 匹配，避免会话内 SDK 已触发的实例被宿主在会话结束后重复触发。
 */

/** SDK 7 天自动过期窗口（recurring 任务到期自动删除，宿主侧同规则兜底）。 */
export const SDK_CRON_SEVEN_DAY_MS = 7 * 24 * 3600 * 1000;

/** cron 匹配迭代上限（窗口最多 7 天，每分钟 1440 次 × 7 ≈ 10080，留余量）。 */
const MAX_CRON_MATCH_ITERATIONS = 12_000;

/** 宿主触发状态：dispatched=宿主已拉起会话执行；sdk_covered=会话内 SDK 已覆盖该实例；failed=拉起失败可重试；completed=拉起会话已结束。 */
export type SdkCronHostTriggerStatus = 'dispatched' | 'sdk_covered' | 'failed' | 'completed';

// ---------------------------------------------------------------------------
// 纯函数：cron 到期计算 / 7 天过期 / 文件改写 / lock 解析
// ---------------------------------------------------------------------------

/**
 * createdAt 之后的第一次 cron 匹配（一次性任务的唯一触发点）。
 * 语义与 SDK 一致：创建时刻严格之后的下一次匹配；无效表达式返回 null。
 */
export function firstCronMatchAfter(expression: string, afterMs: number): number | null {
  try {
    const interval = CronExpressionParser.parse(expression, { currentDate: new Date(afterMs) });
    return interval.next().toDate().getTime();
  } catch {
    return null;
  }
}

/**
 * (afterMs, nowMs] 窗口内最后一次 cron 匹配（recurring 任务取「最近一个已到点实例」）。
 * afterMs 严格不取等号：等于 afterMs 的匹配视为已被记录/覆盖。无效表达式返回 null。
 */
export function lastCronMatchIn(expression: string, afterMs: number, nowMs: number): number | null {
  try {
    const interval = CronExpressionParser.parse(expression, { currentDate: new Date(afterMs) });
    let last: number | null = null;
    let iterated = 0;
    while (iterated < MAX_CRON_MATCH_ITERATIONS) {
      const next = interval.next().toDate().getTime();
      if (next > nowMs) break;
      last = next;
      iterated += 1;
    }
    return last;
  } catch {
    return null;
  }
}

/** beforeMs 严格之前最近一次 cron 匹配（会话结束推进用）；无效表达式返回 null。 */
export function lastCronMatchBefore(expression: string, beforeMs: number): number | null {
  try {
    const interval = CronExpressionParser.parse(expression, { currentDate: new Date(beforeMs) });
    return interval.prev().toDate().getTime();
  } catch {
    return null;
  }
}

/** 7 天过期判定：createdAtMs 缺失时视为未过期（无从判定，交由 SDK 语义）。 */
export function isSevenDayExpired(createdAtMs: number | null, nowMs: number): boolean {
  if (createdAtMs === null || !Number.isFinite(createdAtMs)) return false;
  return nowMs - createdAtMs >= SDK_CRON_SEVEN_DAY_MS;
}

/**
 * 从 durable 文件内容中移除指定 id 的任务，返回新内容。
 * 无变化或内容非法时返回 null（调用方不写盘）。保留其余任务原样与字段顺序。
 */
export function removeTasksFromFile(content: string, ids: string[]): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const root = parsed as { tasks?: unknown } | null;
  if (!root || !Array.isArray(root.tasks)) return null;
  const removeSet = new Set(ids);
  const remaining = root.tasks.filter((item) => {
    if (!item || typeof item !== 'object') return true;
    const id = (item as Record<string, unknown>).id;
    return typeof id !== 'string' || !removeSet.has(id);
  });
  if (remaining.length === root.tasks.length) return null;
  return JSON.stringify({ tasks: remaining }, null, 2);
}

/** 解析 SDK 的 `.claude/scheduled_tasks.lock`（{sessionId, pid, procStart, acquiredAt}）。 */
export function parseLockFile(content: string): { sessionId: string | null; pid: number | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  return {
    sessionId: typeof record.sessionId === 'string' && record.sessionId.trim() ? record.sessionId.trim() : null,
    pid: typeof record.pid === 'number' && Number.isInteger(record.pid) ? record.pid : null,
  };
}

/** 进程存活探测（POSIX signal 0）。非 ESRCH 错误（如 Windows EPERM）保守视为存活。 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
}

/**
 * 递归查找工作区下所有 `.claude/scheduled_tasks.json`（跳过 node_modules/.git/隐藏目录，限深）。
 * 与镜像扫描共用同一遍历语义。
 */
export function findScheduledTasksJsonFiles(rootDir: string, maxDepth = 6): string[] {
  const results: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git') continue;
      const full = path.join(dir, entry);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (entry === '.claude') {
          const candidate = path.join(full, 'scheduled_tasks.json');
          try {
            if (fs.statSync(candidate).isFile()) results.push(candidate);
          } catch {
            // 无落盘文件，忽略
          }
        } else if (!entry.startsWith('.')) {
          walk(full, depth + 1);
        }
      }
    }
  };
  walk(rootDir, 0);
  return results;
}

/** 拉起会话标题（与旧 Scheduler 的「[定时] 任务名」同风格，便于在会话记录中识别宿主触发）。 */
export function buildSdkCronSessionTitle(prompt: string): string {
  return `[SDK cron] ${summarizeCronPrompt(prompt)}`;
}

// ---------------------------------------------------------------------------
// 触发状态存储（sqlite，随主库持久化）
// ---------------------------------------------------------------------------

export interface SdkCronHostTriggerState {
  cronId: string;
  fireMs: number;
  status: SdkCronHostTriggerStatus;
  sessionId: string | null;
}

interface TriggerRow {
  cron_id: string;
  fire_ms: number;
  status: string;
  session_id: string | null;
  created_at: string;
  completed_at: string | null;
  updated_at: string;
}

export const SDK_CRON_HOST_TRIGGER_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS sdk_cron_host_trigger (
    cron_id TEXT PRIMARY KEY,
    fire_ms INTEGER NOT NULL,
    status TEXT NOT NULL,
    session_id TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    updated_at TEXT NOT NULL
  );
`;

export class SdkCronHostTriggerLogStore {
  private db: Database;
  private saveDb: () => void;

  constructor(db: Database, saveDb: () => void) {
    this.db = db;
    this.saveDb = saveDb;
    this.ensureTable();
  }

  ensureTable(): void {
    try {
      this.db.run(SDK_CRON_HOST_TRIGGER_TABLE_SQL);
      this.saveDb();
    } catch (error) {
      console.warn('Failed to ensure sdk_cron_host_trigger table:', error);
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

  private rowToState(row: TriggerRow): SdkCronHostTriggerState {
    return {
      cronId: row.cron_id,
      fireMs: row.fire_ms,
      status: row.status as SdkCronHostTriggerStatus,
      sessionId: row.session_id ?? null,
    };
  }

  getState(cronId: string): SdkCronHostTriggerState | null {
    const row = this.getOne<TriggerRow>('SELECT * FROM sdk_cron_host_trigger WHERE cron_id = ?', [cronId]);
    return row ? this.rowToState(row) : null;
  }

  /**
   * (cronId, fireMs) 实例是否已被处理（dispatched/completed/sdk_covered），
   * failed 视为未处理（允许重试）。
   */
  isHandled(cronId: string, fireMs: number): boolean {
    const state = this.getState(cronId);
    return (
      state !== null
      && state.fireMs === fireMs
      && (state.status === 'dispatched' || state.status === 'completed' || state.status === 'sdk_covered')
    );
  }

  /** 记录宿主已把该 fire 实例交给会话（幂等键 = cron_id，直接替换）。 */
  markDispatched(cronId: string, fireMs: number, sessionId: string): void {
    const now = new Date().toISOString();
    this.db.run(
      `INSERT OR REPLACE INTO sdk_cron_host_trigger
        (cron_id, fire_ms, status, session_id, created_at, completed_at, updated_at)
       VALUES (?, ?, 'dispatched', ?, ?, NULL, ?)`,
      [cronId, fireMs, sessionId, now, now]
    );
    this.saveDb();
  }

  /**
   * 拉起失败：记录 failed 状态（fireMs 为该失败实例，审计可查）。
   * 失败实例不产生 dispatched 行时也会插入占位行；扫描侧对 failed 行以
   * fireMs-1 为下界重试，保证同一实例可被再次拉起。
   */
  markFailed(cronId: string, fireMs: number): void {
    const now = new Date().toISOString();
    const existing = this.getState(cronId);
    if (existing) {
      this.db.run(
        `UPDATE sdk_cron_host_trigger SET fire_ms = ?, status = 'failed', updated_at = ? WHERE cron_id = ?`,
        [fireMs, now, cronId]
      );
    } else {
      this.db.run(
        `INSERT INTO sdk_cron_host_trigger
          (cron_id, fire_ms, status, session_id, created_at, completed_at, updated_at)
         VALUES (?, ?, 'failed', NULL, ?, NULL, ?)`,
        [cronId, fireMs, now, now]
      );
    }
    this.saveDb();
  }

  /** 拉起会话结束：置 completed（状态闭环，供审计）。 */
  markCompleted(cronId: string): void {
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE sdk_cron_host_trigger SET status = 'completed', completed_at = ?, updated_at = ? WHERE cron_id = ?`,
      [now, now, cronId]
    );
    this.saveDb();
  }

  /**
   * 会话结束推进：把触发状态推进到「会话结束前最近一次 cron 匹配」（SDK 在会话存活期间
   * 会触发每个匹配点）。仅向前推进：已有更新的 fireMs 时不回退；不存在则插入 sdk_covered 行。
   * 失败的实例若被会话覆盖（fireMs 已到达/越过失败实例），状态转为 sdk_covered（不再重试）。
   * @returns 是否发生了推进。
   */
  advanceCoverage(cronId: string, fireMs: number): boolean {
    const existing = this.getState(cronId);
    if (existing && existing.status !== 'failed' && existing.fireMs >= fireMs) return false;
    const now = new Date().toISOString();
    if (existing) {
      // failed 行被会话覆盖 → 转 sdk_covered；dispatched/sdk_covered 行仅推进 fireMs。
      const status = existing.status === 'failed' ? 'sdk_covered' : existing.status;
      this.db.run(
        `UPDATE sdk_cron_host_trigger SET fire_ms = ?, status = ?, updated_at = ? WHERE cron_id = ?`,
        [fireMs, status, now, cronId]
      );
    } else {
      this.db.run(
        `INSERT INTO sdk_cron_host_trigger
          (cron_id, fire_ms, status, session_id, created_at, completed_at, updated_at)
         VALUES (?, ?, 'sdk_covered', NULL, ?, NULL, ?)`,
        [cronId, fireMs, now, now]
      );
    }
    this.saveDb();
    return true;
  }
}

// ---------------------------------------------------------------------------
// 宿主触发桥
// ---------------------------------------------------------------------------

export type HostTriggerExecutionMode = 'auto' | 'local' | 'sandbox';

export interface HostTriggerLaunchSpec {
  title: string;
  cwd: string;
  systemPrompt: string;
  executionMode: HostTriggerExecutionMode;
  prompt: string;
  metabotId?: number | null;
}

export interface SdkCronHostTriggerDeps {
  logStore: SdkCronHostTriggerLogStore;
  /** cowork 全局配置（systemPrompt / executionMode）。 */
  getConfig: () => { systemPrompt: string; executionMode: HostTriggerExecutionMode };
  /** 技能 prompt（与旧 Scheduler 一致：skills + 基础 systemPrompt）。 */
  getSkillsPrompt: () => Promise<string | null>;
  /** 查询会话（用于把拉起会话归属到创建会话的 metabot）。 */
  getSession: (id: string) => { metabotId?: number | null } | null;
  /** 该 cwd 下是否有 running 会话（有则视为 SDK 活跃，整体跳过）。 */
  isSessionRunningInCwd: (cwd: string) => boolean;
  /** 复用旧 Scheduler 拉起逻辑：createSession + addMessage + startSession，返回会话 id。 */
  launchSession: (spec: HostTriggerLaunchSpec) => Promise<string>;
  /** 一次性/过期任务从文件移除后，同步把镜像标记 deleted（对账立即一致）。 */
  markMirrorDeleted?: (cronId: string) => void;
  /** 可注入时钟（测试）。 */
  now?: () => number;
  readFile?: (filePath: string) => string;
  writeFile?: (filePath: string, content: string) => void;
  fileExists?: (filePath: string) => boolean;
  isPidAlive?: (pid: number) => boolean;
  findFiles?: (rootDir: string) => string[];
  logger?: (message: string) => void;
}

export interface HostTriggerReport {
  filesScanned: number;
  /** 文件级跳过（cwd 有活跃会话 / lock 被存活进程持有）：整体不动，避免与 SDK 双发。 */
  skippedFiles: { file: string; reason: string }[];
  triggered: { cronId: string; fireMs: number; sessionId: string; recurring: boolean }[];
  failed: { cronId: string; error: string }[];
  /** 7 天过期被移除的 recurring 任务。 */
  expired: { cronId: string }[];
  /** 实例已被处理（宿主已拉起或会话内 SDK 已覆盖）但仍残留在文件中的一次性任务，已自愈移除。 */
  cleaned: { cronId: string; reason: string }[];
  writeFailures: { file: string; error: string }[];
}

export class SdkCronHostTriggerBridge {
  private readonly deps: Required<Pick<SdkCronHostTriggerDeps, 'markMirrorDeleted' | 'now' | 'readFile' | 'writeFile' | 'fileExists' | 'isPidAlive' | 'findFiles' | 'logger'>> & SdkCronHostTriggerDeps;

  constructor(deps: SdkCronHostTriggerDeps) {
    this.deps = {
      markMirrorDeleted: () => undefined,
      now: () => Date.now(),
      readFile: (p) => fs.readFileSync(p, 'utf8'),
      writeFile: (p, c) => {
        // 原子写：先写临时文件再 rename，避免与并发读者/写者互相看到半截内容。
        const tmp = `${p}.host-trigger.tmp`;
        fs.writeFileSync(tmp, c, 'utf8');
        fs.renameSync(tmp, p);
      },
      fileExists: (p) => fs.existsSync(p),
      isPidAlive,
      findFiles: findScheduledTasksJsonFiles,
      logger: (m) => console.log(`[SdkCronHostTrigger] ${m}`),
      ...deps,
    };
  }

  /**
   * 会话结束推进（由 main.ts 的镜像桥 reconcileSessionEnd 调用）：
   * 该会话最后已知的 cron 列表 → 把每个 cron 的触发状态推进到「会话结束前最近一次匹配」。
   * 会话存活期间 SDK 会在每个匹配点触发，推进后宿主不会在会话结束后重复触发同一点。
   */
  advanceSessionCoverage(crons: { id: string; schedule: string }[], endedAtMs: number): void {
    for (const cron of crons) {
      const lastMatch = lastCronMatchBefore(cron.schedule, endedAtMs);
      if (lastMatch === null) continue;
      try {
        this.deps.logStore.advanceCoverage(cron.id, lastMatch);
      } catch (error) {
        this.deps.logger(`Failed to advance coverage for cron ${cron.id}: ${String(error)}`);
      }
    }
  }

  /** 扫描 rootDir 下所有 durable 落盘文件，对到点且无活跃会话的任务执行宿主拉起。 */
  async scanAndTrigger(rootDir: string): Promise<HostTriggerReport> {
    const now = this.deps.now();
    const report: HostTriggerReport = {
      filesScanned: 0,
      skippedFiles: [],
      triggered: [],
      failed: [],
      expired: [],
      cleaned: [],
      writeFailures: [],
    };
    const files = this.deps.findFiles(rootDir);
    report.filesScanned = files.length;

    for (const file of files) {
      let content: string;
      try {
        content = this.deps.readFile(file);
      } catch {
        continue;
      }
      const tasks = parseScheduledTasksFile(content);
      if (tasks.length === 0) continue;

      // 工作区 = `<workspace>/.claude/scheduled_tasks.json` 的 `<workspace>` 目录
      //（会话 cwd / 活跃判定 / lock 路径都以工作区为基准，而不是 .claude 子目录）。
      const workspaceDir = path.dirname(path.dirname(file));
      const activeReason = this.isFileActive(workspaceDir);
      if (activeReason) {
        report.skippedFiles.push({ file, reason: activeReason });
        continue;
      }

      const removedIds: string[] = [];
      let changed = false;
      for (const task of tasks) {
        const state = this.deps.logStore.getState(task.id);

        // 7 天过期（recurring）：SDK 到期自动删除；无会话代为清理时宿主按同规则移除。
        if (task.recurring && isSevenDayExpired(task.createdAtMs, now)) {
          removedIds.push(task.id);
          changed = true;
          this.deps.markMirrorDeleted(task.id);
          report.expired.push({ cronId: task.id });
          this.deps.logger(`Removed 7-day-expired recurring cron ${task.id}`);
          continue;
        }

        if (!task.recurring) {
          // 一次性：首次 cron 匹配为唯一触发点。
          const first = firstCronMatchAfter(task.schedule, task.createdAtMs ?? 0);
          if (first === null) continue; // 无效表达式，跳过
          if (this.deps.logStore.isHandled(task.id, first)) {
            // 实例已被处理（宿主拉起过 / 会话内 SDK 已覆盖）但仍残留在文件 → 自愈移除。
            removedIds.push(task.id);
            changed = true;
            this.deps.markMirrorDeleted(task.id);
            report.cleaned.push({ cronId: task.id, reason: 'instance already handled, stale entry removed' });
            continue;
          }
          if (first > now) continue; // 未到点
          const sessionId = await this.fireTask(task, workspaceDir, first, report);
          if (sessionId === null) continue; // 拉起失败已记录
          removedIds.push(task.id);
          changed = true;
          this.deps.markMirrorDeleted(task.id);
          continue;
        }

        // recurring：最近一个「已到点且未被记录/覆盖」的实例。
        // 失败实例（status=failed）以下界 -1ms 重试（fireMs 本身是审计值，不能作为下界把自己排除）。
        const stateFireMs = state?.fireMs ?? 0;
        const retryFailed = state?.status === 'failed' ? stateFireMs - 1 : stateFireMs;
        const lowerBound = Math.max(task.createdAtMs ?? 0, retryFailed);
        const due = lastCronMatchIn(task.schedule, lowerBound, now);
        if (due === null) continue; // 无新到点实例
        await this.fireTask(task, workspaceDir, due, report);
      }

      if (changed && removedIds.length > 0) {
        const next = removeTasksFromFile(content, removedIds);
        if (next === null) {
          this.deps.logger(`File ${file}: tasks already gone or content invalid, no write`);
        } else {
          try {
            this.deps.writeFile(file, next);
            this.deps.logger(`File ${file}: removed ${removedIds.length} task(s) from durable file`);
          } catch (error) {
            report.writeFailures.push({ file, error: String(error) });
            this.deps.logger(`Failed to write ${file}: ${String(error)}`);
          }
        }
      }
    }

    if (report.triggered.length > 0 || report.expired.length > 0 || report.cleaned.length > 0 || report.failed.length > 0) {
      this.deps.logger(
        `Scan done: ${report.filesScanned} file(s), triggered=${report.triggered.length}, `
        + `expired=${report.expired.length}, cleaned=${report.cleaned.length}, failed=${report.failed.length}`
      );
    }
    return report;
  }

  /** 文件是否处于「SDK 活跃」状态：cwd 有 running 会话，或 lock 文件被存活进程持有。 */
  private isFileActive(fileDir: string): string | null {
    try {
      if (this.deps.isSessionRunningInCwd(fileDir)) {
        return 'running session in cwd';
      }
    } catch {
      // 查询失败不阻断（继续看 lock）
    }
    try {
      const lockPath = path.join(fileDir, '.claude', 'scheduled_tasks.lock');
      if (this.deps.fileExists(lockPath)) {
        const lock = parseLockFile(this.deps.readFile(lockPath));
        if (lock?.pid !== null && lock.pid !== undefined && this.deps.isPidAlive(lock.pid)) {
          return `live SDK lock holder (pid ${lock.pid})`;
        }
      }
    } catch {
      // lock 不可读视为不存在
    }
    return null;
  }

  /** 拉起一次任务（复用旧 Scheduler 的会话创建 + startSession 流程），失败置 failed 供重试。 */
  private async fireTask(
    task: { id: string; schedule: string; recurring: boolean; prompt: string; createdBySessionId: string | null },
    cwd: string,
    fireMs: number,
    report: HostTriggerReport
  ): Promise<string | null> {
    let sessionId: string;
    try {
      sessionId = await this.launchSessionForTask(task, cwd);
    } catch (error) {
      this.deps.logStore.markFailed(task.id, fireMs);
      report.failed.push({ cronId: task.id, error: String(error) });
      this.deps.logger(`Launch failed for cron ${task.id} (fireMs=${new Date(fireMs).toISOString()}): ${String(error)}`);
      return null;
    }
    this.deps.logStore.markDispatched(task.id, fireMs, sessionId);
    report.triggered.push({ cronId: task.id, fireMs, sessionId, recurring: task.recurring });
    this.deps.logger(
      `Fired cron ${task.id} (recurring=${task.recurring}) fireMs=${new Date(fireMs).toISOString()} via session ${sessionId}`
    );
    return sessionId;
  }

  private async launchSessionForTask(
    task: { id: string; schedule: string; recurring: boolean; prompt: string; createdBySessionId: string | null },
    cwd: string
  ): Promise<string> {
    const config = this.deps.getConfig();
    let skillsPrompt: string | null = null;
    try {
      skillsPrompt = await this.deps.getSkillsPrompt();
    } catch (error) {
      this.deps.logger(`Failed to build skills prompt: ${String(error)}`);
    }
    const systemPrompt = [skillsPrompt, config.systemPrompt]
      .filter((prompt): prompt is string => Boolean(prompt?.trim()))
      .join('\n\n');
    const executionMode = config.executionMode || 'auto';

    // 归属到创建会话的 metabot（若有），让拉起会话挂在同一个 bot 名下。
    let metabotId: number | null | undefined;
    if (task.createdBySessionId) {
      try {
        metabotId = this.deps.getSession(task.createdBySessionId)?.metabotId ?? null;
      } catch {
        metabotId = null;
      }
    }

    return this.deps.launchSession({
      title: buildSdkCronSessionTitle(task.prompt),
      cwd,
      systemPrompt,
      executionMode,
      prompt: task.prompt,
      metabotId,
    });
  }
}
