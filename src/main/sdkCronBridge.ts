import type { MigratedCronSpec } from './sdkCronMigration';

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
