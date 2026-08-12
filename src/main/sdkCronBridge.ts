import type { MigratedCronSpec } from './sdkCronMigration';
import { SDK_CRON_PROMPT_LIMIT } from './sdkCronMigration';
import { truncateCronPrompt, type SdkCronScheduleSpec } from './sdkCronMirrorStore';

/**
 * 方案 C 管理桥 / 迁移桥的「指令构建」纯函数（可单测）。
 *
 * 事实与约束：
 * - 宿主进程无法直接调用 Agent 工具（CronCreate / CronDelete / CronList 都注入给 bot 会话），
 *   删除/停用 SDK cron 与创建迁移 cron 都必须由「会话内 bot」执行；
 * - 宿主通过 `startSession`（会话空闲时 resume）或 `trySubmitSteer`（会话活跃时）注入指令文本；
 * - 指令必须显式要求 bot 完成后续动作并回报结果，宿主无法读工具返回（只能依赖 Stop hook 的
 *   session_crons 对账），因此指令里对「已不存在」的情况也给出明确行为，保证对账闭环。
 */

/** 通用（非迁移）cron 创建的幂等标记：`[SDK_CRON:<nonce>]`（类比迁移的 [SDK_MIGRATE:<taskId>]）。 */
export function buildCronMarker(nonce: string): string {
  return `[SDK_CRON:${nonce}]`;
}

/** 从 cron prompt 提取通用创建标记；无标记返回 null。 */
export function extractCronNonce(prompt: string): string | null {
  const match = /\[SDK_CRON:([^\]]+)\]/.exec(prompt || '');
  return match ? match[1] : null;
}

const INTERVAL_UNIT_TO_CRON: Record<SdkCronScheduleSpec['intervalUnit'], (value: number) => string> = {
  minutes: (value) => `*/${value} * * * *`,
  hours: (value) => `0 */${value} * * *`,
  days: (value) => `0 0 */${value} * *`,
};

/**
 * spec → 5 字段 cron 表达式 + recurring 标记（主进程镜像；与渲染层 sdkCronSchedule.specToSdkCron 等价）。
 * @returns expression 为 null 时表示 spec 无法生成合法 cron（调用方应阻止提交）。
 */
export function computeSdkCronFromSpec(spec: SdkCronScheduleSpec): { expression: string | null; recurring: boolean } {
  const [hourStr, minuteStr] = (spec.time || '09:00').split(':').map(Number);
  const hour = Number.isFinite(hourStr) ? hourStr : 9;
  const minute = Number.isFinite(minuteStr) ? minuteStr : 0;

  switch (spec.mode) {
    case 'once': {
      const dt = new Date(`${spec.date}T${spec.time || '09:00'}`);
      if (Number.isNaN(dt.getTime())) return { expression: null, recurring: false };
      return {
        expression: `${dt.getMinutes()} ${dt.getHours()} ${dt.getDate()} ${dt.getMonth() + 1} *`,
        recurring: false,
      };
    }
    case 'interval': {
      const value = Math.max(1, Math.floor(spec.intervalValue || 1));
      const builder = INTERVAL_UNIT_TO_CRON[spec.intervalUnit] ?? INTERVAL_UNIT_TO_CRON.minutes;
      return { expression: builder(value), recurring: true };
    }
    case 'daily':
      return { expression: `${minute} ${hour} * * *`, recurring: true };
    case 'weekly':
      return { expression: `${minute} ${hour} * * ${spec.weekday}`, recurring: true };
    case 'monthly':
      return { expression: `${minute} ${hour} ${spec.monthDay} * *`, recurring: true };
    case 'cron': {
      const expr = (spec.cronExpression || '').trim();
      const parts = expr.split(/\s+/).filter(Boolean);
      return { expression: parts.length === 5 ? expr : null, recurring: true };
    }
    default:
      return { expression: null, recurring: true };
  }
}

const DEFAULT_DERIVED_SPEC = {
  date: '',
  time: '09:00',
  weekday: 1,
  monthDay: 1,
  intervalValue: 5,
  intervalUnit: 'minutes' as const,
};

function parseNonNegInt(v: string | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
function parsePosInt(v: string | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * 从镜像的 5 字段 cron 表达式「派生」一份可编辑的 schedule_spec（主进程版，与渲染层
 * sdkCronSchedule.mirrorToFormState 的解析语义一致）。用于 list IPC 回填：会话采集/迁移
 * 来源的镜像原本没有 spec，开关/编辑因此失效；派生后它们也具备可编辑/可重建的权威源。
 *
 * 解析规则（与 taskFormSchedule.parseScheduleToFormState 对齐）：
 * - `*\/N * * * *`       → interval minutes=N
 * - `0 *\/N * * *`       → interval hours=N
 * - `M H * * *`          → daily time=HH:MM
 * - `M H * * D`          → weekly weekday=D time=HH:MM
 * - `M H DoM * *`        → monthly monthDay=DoM time=HH:MM
 * - 其余（含 `7,22,37,52 * * * *` 这类多值/范围）→ cron + 原表达式（不造假语义）
 *
 * name/prompt/metabotId 取镜像现有字段；解析失败（非 5 段）返回 null（调用方保持无 spec）。
 */
export function deriveScheduleSpecFromCron(mirror: {
  schedule: string;
  name: string;
  prompt: string;
}): SdkCronScheduleSpec | null {
  const expression = (mirror?.schedule ?? '').trim();
  if (!expression) return null;
  const parts = expression.split(/\s+/).filter(Boolean);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, , dayOfWeek] = parts;

  // interval: 每分钟 / 每 N 分钟 / 每 N 小时。
  if (hour === '*' && dayOfMonth === '*' && dayOfWeek === '*') {
    const minStep = minute.match(/^\*\/(\d+)$/);
    if (minStep) {
      const value = parsePosInt(minStep[1]) ?? 1;
      return { ...DEFAULT_DERIVED_SPEC, mode: 'interval', intervalUnit: 'minutes', intervalValue: value, cronExpression: expression, name: mirror.name, prompt: mirror.prompt, metabotId: null };
    }
  }
  if (minute === '0' && dayOfMonth === '*' && dayOfWeek === '*') {
    const hourStep = hour.match(/^\*\/(\d+)$/);
    if (hourStep) {
      const value = parsePosInt(hourStep[1]) ?? 1;
      return { ...DEFAULT_DERIVED_SPEC, mode: 'interval', intervalUnit: 'hours', intervalValue: value, cronExpression: expression, name: mirror.name, prompt: mirror.prompt, metabotId: null };
    }
  }

  const minuteValue = parseNonNegInt(minute);
  const hourValue = parseNonNegInt(hour);
  // minute/hour 不是单个整数（如 7,22,37,52 或 9-17）→ 无法还原成具体时刻，归为 cron 原样。
  if (minuteValue == null || hourValue == null) {
    return { ...DEFAULT_DERIVED_SPEC, mode: 'cron', cronExpression: expression, name: mirror.name, prompt: mirror.prompt, metabotId: null };
  }
  const time = `${String(hourValue).padStart(2, '0')}:${String(minuteValue).padStart(2, '0')}`;

  if (dayOfWeek !== '*' && dayOfMonth === '*') {
    return { ...DEFAULT_DERIVED_SPEC, mode: 'weekly', time, weekday: parsePosInt(dayOfWeek) ?? 0, cronExpression: expression, name: mirror.name, prompt: mirror.prompt, metabotId: null };
  }
  if (dayOfMonth !== '*' && dayOfWeek === '*') {
    return { ...DEFAULT_DERIVED_SPEC, mode: 'monthly', time, monthDay: parsePosInt(dayOfMonth) ?? 1, cronExpression: expression, name: mirror.name, prompt: mirror.prompt, metabotId: null };
  }
  return { ...DEFAULT_DERIVED_SPEC, mode: 'daily', time, cronExpression: expression, name: mirror.name, prompt: mirror.prompt, metabotId: null };
}

/**
 * 把标记 + prompt 组装成 SDK 侧存储的完整 prompt（标记前置，保证被截断时标记仍保留）。
 * 超过 SDK 上限（1000 字符）时按同规则截断尾部。
 */
export function buildCronPromptWithMarker(marker: string, prompt: string): string {
  const base = prompt && prompt.trim() ? `${marker}\n${prompt}` : marker;
  return base.length <= SDK_CRON_PROMPT_LIMIT ? base : truncateCronPrompt(base, SDK_CRON_PROMPT_LIMIT);
}

/** 管理桥：构建 CronDelete 指令（注入到镜像任务所属会话）。 */
export function buildCronDeleteInstruction(mirror: { id: string; name: string }): string {
  return [
    '[宿主管理桥] 请执行一次 SDK 定时任务删除（这是宿主 UI 发起的删除操作，不是普通对话）：',
    `1. 调用 CronDelete 工具，参数 id="${mirror.id}"（任务名：${mirror.name}）；`,
    `2. 若 CronDelete 成功，回复一行：已删除 ${mirror.id}`,
    `3. 若 CronList 中找不到该任务（可能已 7 天过期或已被删除），同样回复一行：已删除 ${mirror.id}`,
    '4. 不要创建任何新任务，不要执行除 CronDelete/CronList 以外的工具。',
  ].join('\n');
}

/** 迁移桥：构建 CronCreate 指令（注入到一次性迁移会话，由 bot 执行 durable 创建）。 */
export function buildCronCreateInstruction(spec: MigratedCronSpec): string {
  const quotedPrompt = JSON.stringify(spec.prompt);
  return [
    '[宿主迁移桥] 请在本次会话中执行一次 SDK 定时任务创建（这是把 IDBots 老定时任务迁移到 SDK durable cron 的操作）：',
    '调用 CronCreate 工具，参数如下（保持原样，不要改写）：',
    `- cron: ${spec.cronExpression}`,
    `- prompt: ${quotedPrompt}`,
    `- recurring: ${spec.recurring ? 'true' : 'false'}`,
    '- durable: true',
    '创建成功后回复一行：已创建 <CronCreate 返回的任务 id>',
    '若 CronCreate 报错，回复一行：创建失败 <错误信息>',
    '不要创建第二个任务，不要执行其它工具。',
  ].join('\n');
}

/**
 * 通用创建桥：构建 CronCreate 指令（用于「新建/编辑/重新启用」这类 UI 发起的创建）。
 * 与迁移桥同结构，但话术为「宿主 UI 新建」、并明确要求 durable=true（跨重启保留）。
 */
export function buildCronCreateUiInstruction(params: {
  cronExpression: string;
  prompt: string;
  recurring: boolean;
}): string {
  const quotedPrompt = JSON.stringify(params.prompt);
  return [
    '[宿主管理桥] 请在本次会话中执行一次 SDK 定时任务创建（这是宿主 UI「新建定时任务」发起的操作，不是普通对话）：',
    '调用 CronCreate 工具，参数如下（保持原样，不要改写 prompt 与 cron）：',
    `- cron: ${params.cronExpression}`,
    `- prompt: ${quotedPrompt}`,
    `- recurring: ${params.recurring ? 'true' : 'false'}`,
    '- durable: true',
    '创建成功后回复一行：已创建 <CronCreate 返回的任务 id>',
    '若 CronCreate 报错，回复一行：创建失败 <错误信息>',
    '不要创建第二个任务，不要执行其它工具。',
  ].join('\n');
}

/**
 * 立即运行桥：SDK 没有「立即触发 cron」工具，立即运行 = 让会话内 bot 当场执行该 cron 的 prompt。
 * 指令把 prompt 原文交给 bot（不带 cron 参数，因为这不是创建/删除，是执行任务本身）。
 */
export function buildCronRunNowInstruction(prompt: string): string {
  return [
    '[宿主管理桥] 请立即执行以下定时任务内容（这是宿主 UI「立即运行」发起的操作）：',
    '直接按下面的内容完成任务，不要调用 CronCreate/CronDelete/CronList 等定时任务工具：',
    '---',
    prompt,
    '---',
  ].join('\n');
}
