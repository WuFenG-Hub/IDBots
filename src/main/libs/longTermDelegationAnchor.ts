import type { LongTermSubtask, LongTermTaskDetail } from '../../renderer/types/longTermTask';

/**
 * Long-term delegation anchor — the single implementation of the
 * `<longterm_anchor>` block that must ride every delegation of a long-term
 * sub-project (agent tool `longterm_delegation_anchor` and the hard gate in
 * TwinOrchestrationService.withLongTermAnchor). It carries the ids, the goal,
 * the acceptance criteria, recent journal events, and the worker's duties, so
 * the worker pulls full context from the source instead of relying on the
 * Twin's relay.
 */

export const LONGTERM_ANCHOR_MARKER = '<longterm_anchor>';

export function buildDelegationAnchorBlock(
  detail: LongTermTaskDetail,
  subtask: LongTermSubtask,
  language: string,
): string {
  const zh = language === 'zh';
  const criteria = subtask.acceptanceCriteria.length > 0
    ? subtask.acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n')
    : zh ? '  （未写验收标准）' : '  (no acceptance criteria on file)';
  const events = detail.events
    .slice(0, 5)
    .map((e) => `  - [${e.kind}/${e.actor}] ${e.detail.replace(/\s+/g, ' ').slice(0, 160)}`);
  const lines = zh
    ? [
        LONGTERM_ANCHOR_MARKER,
        `taskId: ${detail.id}`,
        `subtaskId: ${subtask.id}`,
        `任务: ${detail.title}`,
        `目标: ${detail.goal}`,
        `子项目 #${subtask.ordinal}: ${subtask.title}`,
        `说明: ${subtask.description || '—'}`,
        '验收标准:',
        criteria,
        `执行通道: ${subtask.preferredChannel ?? '未定'}`,
        `当前状态: ${subtask.status}${subtask.waitNote ? `（等待: ${subtask.waitNote}）` : ''}`,
        events.length > 0 ? '近期动态（最近事件）:' : '',
        ...events,
        '工作要求:',
        '  1. 动手前先调用 longterm_task_get(taskId) 读取全量上下文（目标、全部子项目、事件流水）——不要只凭本简报行动。',
        '  2. 本委派只是该子项目的一个执行切片：禁止自行发明基建/配置面/通道；任何未经验证的前提先问，不要先建。',
        '  3. 交付物须对照上述验收标准逐条自证（证据：本地目录 / metaapp:// / pin:// / URL）。',
        '  4. 重大发现、前提修正或偏差，用 longterm_event_note(taskId, subtaskId) 记回任务事件流。',
        '</longterm_anchor>',
      ]
    : [
        LONGTERM_ANCHOR_MARKER,
        `taskId: ${detail.id}`,
        `subtaskId: ${subtask.id}`,
        `Task: ${detail.title}`,
        `Goal: ${detail.goal}`,
        `Sub-project #${subtask.ordinal}: ${subtask.title}`,
        `Description: ${subtask.description || '—'}`,
        'Acceptance criteria:',
        criteria,
        `Preferred channel: ${subtask.preferredChannel ?? 'undecided'}`,
        `Current status: ${subtask.status}${subtask.waitNote ? ` (waiting: ${subtask.waitNote})` : ''}`,
        events.length > 0 ? 'Recent journal events:' : '',
        ...events,
        'Worker duties:',
        '  1. Before acting, call longterm_task_get(taskId) for the full context (goal, all sub-projects, event journal) — never act on this brief alone.',
        '  2. This delegation is one execution slice of the sub-project: never invent infrastructure/config surfaces/channels; ask about any unverified premise before building.',
        '  3. Prove every acceptance criterion with evidence (local dir / metaapp:// / pin:// / URL).',
        '  4. Journal major findings, premise corrections, or drift back with longterm_event_note(taskId, subtaskId).',
        '</longterm_anchor>',
      ];
  return lines.filter((line) => line !== '').join('\n');
}
