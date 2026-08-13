/**
 * R1 验收总结 — host-generated, deterministic acceptance summary.
 *
 * Pure aggregation over data the host already owns (task goal/acceptance +
 * recorded deliverables + members). This module is the single text-rendering
 * authority: the group review-closing message, the owner private report, and
 * the R2 acceptance notification all render from the {@link GroupTaskAcceptanceSummary}
 * record it produces, so the three channels can never drift.
 *
 * Determinism is the whole point: the same inputs always yield the same message
 * (no LLM in the loop), which makes it testable and auditable. The LLM only
 * narrates this record downstream — it never re-organizes the deliverable list.
 *
 * Message wording stays Chinese to match the existing review closing line
 * (`buildReviewClosingLine`) and the chair's group-task playbook, preserving
 * continuity for existing users; verification badges reuse the renderer's
 * English labels (on-chain ✓ / pending sync / unverified).
 */

import type {
  GroupTask,
  GroupTaskDeliverable,
  GroupTaskMember,
  GroupTaskAcceptanceSummary,
  GroupTaskAcceptanceSummaryDeliverable,
  GroupTaskAcceptanceSummaryMember,
} from '../groupTaskStore';

/** Human-readable verification label mirroring the renderer badge text. */
export function deliverableVerificationLabel(deliverable: GroupTaskDeliverable): string {
  if (deliverable.confirmation === 'confirmed') return 'on-chain ✓';
  let report: { verified?: unknown; sources?: Array<{ outcome?: unknown }> } | null = null;
  try {
    const parsed = deliverable.verification ? JSON.parse(deliverable.verification) : null;
    if (parsed && typeof parsed === 'object') {
      report = parsed as { verified?: unknown; sources?: Array<{ outcome?: unknown }> };
    }
  } catch {
    // Malformed verification JSON → treat as unknown/unverified.
  }
  const sources = Array.isArray(report?.sources) ? report!.sources : [];
  if (report?.verified === true) return 'on-chain ✓';
  if (
    sources.some((entry) => entry?.outcome === 'not_found')
    && sources.some((entry) => entry?.outcome === 'found')
  ) {
    return 'pending sync';
  }
  return 'unverified';
}

/**
 * Snapshot a deliverable for the immutable summary record. Strips the heavy
 * verification JSON (the label is enough for display) and resolves a display
 * author name (sender name preferred over the raw globalmetaid).
 */
export function buildAcceptanceSummaryDeliverables(
  deliverables: GroupTaskDeliverable[],
): GroupTaskAcceptanceSummaryDeliverable[] {
  return deliverables.map((deliverable) => ({
    kind: deliverable.kind ?? null,
    uri: deliverable.uri ?? null,
    status: deliverable.status,
    confirmation: deliverable.confirmation,
    authorName: deliverable.sourceSenderName?.trim() || deliverable.authorGlobalmetaid || null,
  }));
}

/**
 * Snapshot a member for the immutable summary record. `workStatus` is the
 * self-reported status today; the host-derived workStatus (idle/working/error/
 * timeout/unknown) is a P1/R6 concern layered on later — the field name is
 * reserved so the shape stays forward-compatible.
 */
export function buildAcceptanceSummaryMembers(
  members: GroupTaskMember[],
): GroupTaskAcceptanceSummaryMember[] {
  return members
    .filter((member) => member.removedAt == null)
    .map((member) => ({
      name: member.name?.trim() || member.displayName?.trim() || null,
      role: member.role,
      workStatus: member.status,
    }));
}

/**
 * Deterministic acceptance guidance: the three actions the owner can take,
 * restated verbatim every time. Worded to never end on an open question (the
 * owner only confirms acceptance, requests rework, or replies in-group).
 */
export function buildAcceptanceGuidance(task: Pick<GroupTask, 'title'>): string {
  return [
    `你可以：`,
    `① 在 Tasks 面板点「Accept & Close」并评分（1-5 星 + 可选评语）——任务关闭；`,
    `② 点「Back to work / Rework」——返回执行，chair 会补派工作；`,
    `③ 在群内直接回复意见——chair 会按你的意见处理。`,
  ].join('\n');
}

/** Render the immutable summary record back into the deterministic group message. */
export function buildAcceptanceSummaryMessageText(
  summary: Pick<
    GroupTaskAcceptanceSummary,
    'goal' | 'acceptanceCriteria' | 'deliverables' | 'members' | 'guidance'
  >,
  taskTitle: string,
): string {
  const lines: string[] = [];
  lines.push(`📦 任务「${taskTitle}」已进入验收阶段，以下为成果汇总。`);
  lines.push('');
  lines.push(`目标：${summary.goal.trim()}`);
  lines.push(`验收标准：${(summary.acceptanceCriteria ?? '').trim() || '（未填写）'}`);
  lines.push('');
  if (summary.deliverables.length === 0) {
    lines.push('成果清单：无已核验交付物。');
  } else {
    lines.push('成果清单：');
    for (const deliverable of summary.deliverables) {
      const kind = (deliverable.kind ?? 'text').trim();
      const uri = (deliverable.uri ?? '').trim();
      const verification = deliverableVerificationLabel({
        // Reconstruct just enough for the label helper (confirmation + verification JSON).
        confirmation: deliverable.confirmation,
        verification: null,
      } as GroupTaskDeliverable);
      const author = (deliverable.authorName ?? '').trim() || 'unknown';
      const body = uri || '（见消息原文）';
      lines.push(`- [${kind}] ${body} (${verification}) — ${author}`);
    }
  }
  lines.push('');
  if (summary.members.length > 0) {
    lines.push(`成员：${summary.members.map((member) => member.name ?? 'unknown').join('、')}`);
    lines.push('');
  }
  lines.push(summary.guidance.trim());
  return lines.join('\n');
}

/**
 * Build a fresh acceptance summary (un-persisted) plus the deterministic group
 * message from the live task + recorded deliverables + members. The daemon
 * persists the result via {@link GroupTaskStore.saveAcceptanceSummary} at the
 * review-entry moment (T1) and posts `messageText` as the group's last message.
 */
export function buildAcceptanceSummary(input: {
  task: Pick<GroupTask, 'title' | 'goal' | 'acceptanceCriteria'>;
  deliverables: GroupTaskDeliverable[];
  members: GroupTaskMember[];
}): {
  goal: string;
  acceptanceCriteria: string | null;
  deliverables: GroupTaskAcceptanceSummaryDeliverable[];
  members: GroupTaskAcceptanceSummaryMember[];
  guidance: string;
  messageText: string;
} {
  const deliverables = buildAcceptanceSummaryDeliverables(input.deliverables);
  const members = buildAcceptanceSummaryMembers(input.members);
  const guidance = buildAcceptanceGuidance(input.task);
  const summaryShape = {
    goal: input.task.goal,
    acceptanceCriteria: input.task.acceptanceCriteria ?? null,
    deliverables,
    members,
    guidance,
  };
  const messageText = buildAcceptanceSummaryMessageText(summaryShape, input.task.title);
  return { ...summaryShape, messageText };
}
