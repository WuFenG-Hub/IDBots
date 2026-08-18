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
 * author name.
 *
 * P13 (v1.1): the roster wins over the chain nickname. A worker session may
 * post with a runtime identity nickname (task #22 rendered Builder阿码's
 * delivery as "claude bot") while the deliverable row's authorGlobalmetaid is
 * always the worker's registered identity — so the display name is resolved
 * from the member roster by globalmetaid first, and only falls back to the
 * chain sender name / raw id when the author is not on the roster.
 */
export function buildAcceptanceSummaryDeliverables(
  deliverables: GroupTaskDeliverable[],
  members: GroupTaskMember[] = [],
): GroupTaskAcceptanceSummaryDeliverable[] {
  const nameByGmid = new Map<string, string>();
  for (const member of members) {
    const gmid = (member.globalmetaid ?? '').trim().toLowerCase();
    const name = (member.name ?? member.displayName ?? '').trim();
    if (gmid && name) nameByGmid.set(gmid, name);
  }
  return deliverables.map((deliverable) => {
    const gmid = (deliverable.authorGlobalmetaid ?? '').trim().toLowerCase();
    const rosterName = gmid ? nameByGmid.get(gmid) : undefined;
    const uri = (deliverable.uri ?? '').trim() || null;
    return {
      kind: deliverable.kind ?? null,
      uri,
      status: deliverable.status,
      confirmation: deliverable.confirmation,
      authorName: rosterName || deliverable.sourceSenderName?.trim() || deliverable.authorGlobalmetaid || null,
      preview: uri ? null : textDeliverablePreview(deliverable.sourceContent),
    };
  });
}

/** Digital outcomes: a clickable/copyable URI. Process-text rows stay off the main checklist. */
export function isDigitalDeliverable(
  deliverable: Pick<GroupTaskAcceptanceSummaryDeliverable, 'uri'>,
): boolean {
  return String(deliverable?.uri ?? '').trim().length > 0;
}

/**
 * Acceptance checklist: URI-bearing digital outcomes first. Process-text
 * placeholders (kind=text, no uri, "（见消息原文）") are omitted. When a task's
 * only outcomes are text, rows that carry a body preview stay so the owner
 * can read the actual report instead of a placeholder.
 */
export function selectAcceptanceChecklist(
  deliverables: GroupTaskAcceptanceSummaryDeliverable[] | null | undefined,
): { items: GroupTaskAcceptanceSummaryDeliverable[]; omittedProcessCount: number } {
  const list = Array.isArray(deliverables) ? deliverables : [];
  const digital = list.filter(isDigitalDeliverable);
  if (digital.length > 0) {
    return { items: digital, omittedProcessCount: list.length - digital.length };
  }
  const withBody = list.filter((deliverable) => {
    const uri = String(deliverable.uri ?? '').trim();
    const preview = String(deliverable.preview ?? '').trim();
    return uri.length > 0 || preview.length > 0;
  });
  return { items: withBody, omittedProcessCount: list.length - withBody.length };
}

/** Strip the protocol tag and collapse whitespace so a text row can show the report body. */
export function textDeliverablePreview(sourceContent: string | null | undefined): string | null {
  const stripped = String(sourceContent ?? '')
    .replace(/\[DELIVERABLE\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return null;
  return acceptancePreview(stripped);
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
    `① 在 Tasks 面板的验收卡点「Accept & Close」并评分（1-5 星 + 可选评语）——任务关闭；`,
    `② 在验收卡点「Back to work / Rework」——返回执行，chair 会补派工作；`,
    `③ 在群内直接回复意见——chair 会按你的意见处理。`,
  ].join('\n');
}

/**
 * P12 (v1.2): preview cap for the goal/criteria lines in the group message.
 * Task #23's summary reproduced the full goal (313 chars) + criteria (162) +
 * every deliverable + guidance in one giant host-posted message. The checklist
 * (deliverable lines) is the core content; goal/criteria render as truncated
 * previews — the panel and the summary record keep the full texts.
 */
export const ACCEPTANCE_SUMMARY_PREVIEW_MAX_CHARS = 160;

/** Deterministic preview: full text when short, ellipsized first line-block otherwise. */
export function acceptancePreview(text: string, maxChars: number = ACCEPTANCE_SUMMARY_PREVIEW_MAX_CHARS): string {
  const trimmed = (text ?? '').trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}…`;
}

/**
 * Improvement #4 (v1.3): the "方案变更 / Plan changes" block budget — a few
 * one-line disclosures (original plan -> blocker -> fallback), never a prose
 * re-dump, so the P12 concise-report budget holds. Extra lines collapse into
 * a single overflow pointer to the group transcript.
 */
export const PLAN_CHANGE_MAX_RENDER_LINES = 3;
/** Per-line cap for a rendered plan-change disclosure. */
export const PLAN_CHANGE_LINE_MAX_CHARS = 160;

/**
 * Improvement #1 (single-card acceptance): cap for the chair's one-line
 * conclusion. The conclusion is the card's headline and the lead of the group
 * summary — a verdict, not a paragraph.
 */
export const CHAIR_CONCLUSION_MAX_CHARS = 120;

/** How deep into the report the conclusion tag may appear (narrative below this is prose, not a verdict). */
const CHAIR_CONCLUSION_HEAD_LINES = 6;

const CONCLUSION_TAGGED_RE = /【结论】[ \t]*([^\n\r]+)/;
const CONCLUSION_BOLD_RE = /\*\*结论\*\*[ \t]*[：:]?[ \t]*([^\n\r]+)/;
const CONCLUSION_PLAIN_RE = /^[ \t]*结论[：:][ \t]*([^\n\r]+)/m;

/**
 * Improvement #1: extract the chair's one-line conclusion from the owner-report
 * narrative. The owner-report directive requires the report to OPEN with a
 * `【结论】<verdict>` line; legacy **结论**：/结论： forms are still honored so
 * pre-format reports (task #24 style) parse too. Only the opening lines are
 * searched — a 结论 mentioned deep in the narration is prose, not the verdict.
 * Returns the cleaned, capped string or null when no verdict line exists (the
 * card then falls back to its deterministic deliverable-count headline).
 */
export function extractChairConclusion(report: string): string | null {
  const text = (report ?? '').trim();
  if (!text) return null;
  const head = text.split(/\r?\n/, CHAIR_CONCLUSION_HEAD_LINES).join('\n');
  const match = CONCLUSION_TAGGED_RE.exec(head)
    ?? CONCLUSION_BOLD_RE.exec(head)
    ?? CONCLUSION_PLAIN_RE.exec(head);
  if (!match) return null;
  const cleaned = (match[1] ?? '')
    .replace(/\*\*/g, '')
    .replace(/^#{1,6}[ \t]*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[。.；;，,]+$/, '');
  if (!cleaned) return null;
  return cleaned.length > CHAIR_CONCLUSION_MAX_CHARS
    ? `${cleaned.slice(0, CHAIR_CONCLUSION_MAX_CHARS).trimEnd()}…`
    : cleaned;
}

/** Render the immutable summary record back into the deterministic group message. */
export function buildAcceptanceSummaryMessageText(
  summary: Pick<
    GroupTaskAcceptanceSummary,
    'goal' | 'acceptanceCriteria' | 'deliverables' | 'members' | 'guidance'
  > & { planChanges?: string[] } & Partial<Pick<GroupTaskAcceptanceSummary, 'conclusion'>>,
  taskTitle: string,
): string {
  const lines: string[] = [];
  lines.push(`📦 任务「${taskTitle}」已进入验收阶段，以下为成果汇总。`);
  // Improvement #1: the chair's one-line conclusion leads the message when it
  // was captured before posting — the SAME stored string headlines the Tasks
  // acceptance card and the source-session notice (one authoritative copy).
  const conclusion = (summary.conclusion ?? '').trim();
  if (conclusion) {
    lines.push(`结论：${conclusion}`);
  }
  lines.push('');
  lines.push(`目标：${acceptancePreview(summary.goal)}`);
  lines.push(`验收标准：${(summary.acceptanceCriteria ?? '').trim() ? acceptancePreview(summary.acceptanceCriteria ?? '') : '（未填写）'}`);
  lines.push('');
  const checklist = selectAcceptanceChecklist(summary.deliverables);
  if (checklist.items.length === 0) {
    lines.push('成果清单：无已核验交付物。');
    if (checklist.omittedProcessCount > 0) {
      lines.push(`（另有 ${checklist.omittedProcessCount} 项过程记录，见群内报告）`);
    }
  } else {
    lines.push('成果清单：');
    for (const deliverable of checklist.items) {
      const kind = (deliverable.kind ?? 'text').trim();
      const uri = (deliverable.uri ?? '').trim();
      const preview = (deliverable.preview ?? '').trim();
      const body = uri || preview;
      if (!body) continue;
      const author = (deliverable.authorName ?? '').trim() || 'unknown';
      if (uri) {
        const verification = deliverableVerificationLabel({
          // Reconstruct just enough for the label helper (confirmation + verification JSON).
          confirmation: deliverable.confirmation,
          verification: null,
        } as GroupTaskDeliverable);
        // P3 (v1.1): surface the ledger status when it moved past 'pending' —
        // a verified deliverable must not read as still awaiting.
        const statusNote = deliverable.status === 'pending' ? '' : ` · ${deliverable.status}`;
        lines.push(`- [${kind}] ${body} (${verification}${statusNote}) — ${author}`);
      } else {
        // Text-only outcome: print the body, never "（见消息原文）(unverified)".
        lines.push(`- [${kind}] ${body} — ${author}`);
      }
    }
    if (checklist.omittedProcessCount > 0) {
      lines.push(`（另有 ${checklist.omittedProcessCount} 项过程记录，见群内报告）`);
    }
  }
  const planChanges = (summary.planChanges ?? []).map((line) => line.trim()).filter(Boolean);
  if (planChanges.length > 0) {
    lines.push('');
    lines.push('方案变更：');
    for (const change of planChanges.slice(0, PLAN_CHANGE_MAX_RENDER_LINES)) {
      lines.push(`- ${acceptancePreview(change, PLAN_CHANGE_LINE_MAX_CHARS)}`);
    }
    if (planChanges.length > PLAN_CHANGE_MAX_RENDER_LINES) {
      lines.push(`（另有 ${planChanges.length - PLAN_CHANGE_MAX_RENDER_LINES} 项变更，见群内记录）`);
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
 * review-entry moment (T1). planChanges (Improvement #4 v1.3) snapshots the
 * chair's recorded [PLAN_CHANGE] resolutions so every owner-facing surface
 * renders the same disclosure. After the owner report captures the chair's
 * conclusion onto the saved record, the posted group message is re-rendered
 * from that record via {@link buildAcceptanceSummaryMessageText} so the
 * conclusion leads it (`messageText` here is the conclusion-less pre-render).
 */
export function buildAcceptanceSummary(input: {
  task: Pick<GroupTask, 'title' | 'goal' | 'acceptanceCriteria'>;
  deliverables: GroupTaskDeliverable[];
  members: GroupTaskMember[];
  planChanges?: string[];
}): {
  goal: string;
  acceptanceCriteria: string | null;
  deliverables: GroupTaskAcceptanceSummaryDeliverable[];
  members: GroupTaskAcceptanceSummaryMember[];
  planChanges: string[];
  guidance: string;
  messageText: string;
} {
  const deliverables = buildAcceptanceSummaryDeliverables(input.deliverables, input.members);
  const members = buildAcceptanceSummaryMembers(input.members);
  const guidance = buildAcceptanceGuidance(input.task);
  const planChanges = (input.planChanges ?? []).map((line) => line.trim()).filter(Boolean);
  const summaryShape = {
    goal: input.task.goal,
    acceptanceCriteria: input.task.acceptanceCriteria ?? null,
    deliverables,
    members,
    planChanges,
    guidance,
  };
  const messageText = buildAcceptanceSummaryMessageText(summaryShape, input.task.title);
  return { ...summaryShape, messageText };
}
