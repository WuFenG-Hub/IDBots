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
 * Host wording follows the owner app language (zh/en). Verification badges
 * reuse the renderer's English labels (on-chain ✓ / pending sync / unverified).
 */

import type { AppLanguage } from '../libs/inferLanguageFromLocale';
import {
  GROUP_TASK_NOTICE,
  acceptanceSummaryCopy,
  buildAcceptanceGuidanceText,
  groupTaskLanguage,
  withGroupTaskNotice,
} from '../libs/groupTaskCopy';
import type {
  GroupTask,
  GroupTaskDeliverable,
  GroupTaskMember,
  GroupTaskAcceptanceSummary,
  GroupTaskAcceptanceSummaryDeliverable,
  GroupTaskAcceptanceSummaryMember,
  GroupTaskAcceptanceCriteriaVerdict,
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
export function buildAcceptanceGuidance(
  _task: Pick<GroupTask, 'title'>,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return buildAcceptanceGuidanceText(language);
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
const CONCLUSION_BOLD_RE = /\*\*(?:结论|Conclusion)\*\*[ \t]*[：:]?[ \t]*([^\n\r]+)/i;
const CONCLUSION_PLAIN_RE = /^[ \t]*(?:结论|Conclusion)[：:][ \t]*([^\n\r]+)/im;
const CONCLUSION_BRACKET_EN_RE = /【Conclusion】[ \t]*([^\n\r]+)/i;

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
    ?? CONCLUSION_BRACKET_EN_RE.exec(head)
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

// ---------------------------------------------------------------------------
// G-05: create-time-aligned acceptance verdicts.
//
// The owner-report directive requires the chair to answer EACH create-time
// acceptance criterion on its own ASCII-protocol line and to park anything the
// criteria never asked for under [OBSERVATION]. The host parses only those
// labels (never natural-language intent) and stamps the result onto the
// acceptance-summary record, so the group summary, the Tasks acceptance card
// and the origin-session notice all render the same per-circuit verdict, with
// extra findings visibly NON-blocking.
// ---------------------------------------------------------------------------

/** Cap for one parsed criterion/observation line. */
export const CRITERIA_VERDICT_LINE_MAX_CHARS = 200;

const CRITERION_VERDICT_LINE_RE = /^[ \t]*(?:[-*][ \t]+)?\[CRITERION:[ \t]*(PASS|FAIL|UNCLEAR)\][ \t]*[-—–:]?[ \t]*(.+)$/gim;
const OBSERVATION_LINE_RE = /^[ \t]*(?:[-*][ \t]+)?\[OBSERVATION\][ \t]*[-—–:]?[ \t]*(.+)$/gim;

function capVerdictLine(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= CRITERIA_VERDICT_LINE_MAX_CHARS) return cleaned;
  return `${cleaned.slice(0, CRITERIA_VERDICT_LINE_MAX_CHARS).trimEnd()}…`;
}

/**
 * G-05: parse the per-criterion verdict block and the non-blocking
 * observations out of the chair's owner report. ASCII protocol tags only;
 * everything else in the narrative is prose and ignored. Order preserved.
 */
export function extractCriteriaVerdicts(report: string): {
  verdicts: GroupTaskAcceptanceCriteriaVerdict[];
  observations: string[];
} {
  const text = String(report ?? '');
  const verdicts: GroupTaskAcceptanceCriteriaVerdict[] = [];
  for (const match of text.matchAll(CRITERION_VERDICT_LINE_RE)) {
    const verdict = match[1]?.toLowerCase();
    const line = capVerdictLine(match[2] ?? '');
    if ((verdict === 'pass' || verdict === 'fail' || verdict === 'unclear') && line) {
      verdicts.push({ verdict, text: line });
    }
  }
  const observations: string[] = [];
  for (const match of text.matchAll(OBSERVATION_LINE_RE)) {
    const line = capVerdictLine(match[1] ?? '');
    if (line) observations.push(line);
  }
  return { verdicts, observations };
}

/** Render the immutable summary record back into the deterministic group message. */
export function buildAcceptanceSummaryMessageText(
  summary: Pick<
    GroupTaskAcceptanceSummary,
    'goal' | 'acceptanceCriteria' | 'deliverables' | 'members' | 'guidance'
  > & { planChanges?: string[] } & Partial<Pick<GroupTaskAcceptanceSummary, 'conclusion'>> & {
    criteriaVerdicts?: GroupTaskAcceptanceCriteriaVerdict[];
    observations?: string[];
  },
  taskTitle: string,
  language: AppLanguage = groupTaskLanguage(),
): string {
  const copy = acceptanceSummaryCopy(language);
  const lines: string[] = [];
  lines.push(copy.header(taskTitle));
  const conclusion = (summary.conclusion ?? '').trim();
  if (conclusion) {
    lines.push(copy.conclusion(conclusion));
  }
  lines.push('');
  lines.push(copy.goal(acceptancePreview(summary.goal)));
  lines.push(copy.criteria(
    (summary.acceptanceCriteria ?? '').trim()
      ? acceptancePreview(summary.acceptanceCriteria ?? '')
      : copy.criteriaEmpty,
  ));
  // G-05: per-criterion verdicts against the CREATE-TIME criteria — the
  // owner sees exactly which declared item passed/failed/needs verification.
  const verdicts = summary.criteriaVerdicts ?? [];
  if (verdicts.length > 0) {
    lines.push('');
    lines.push(copy.criteriaCheckTitle);
    for (const entry of verdicts) {
      if (entry.verdict === 'pass') lines.push(copy.criteriaPass(entry.text));
      else if (entry.verdict === 'fail') lines.push(copy.criteriaFail(entry.text));
      else lines.push(copy.criteriaUnclear(entry.text));
    }
  }
  lines.push('');
  const checklist = selectAcceptanceChecklist(summary.deliverables);
  if (checklist.items.length === 0) {
    lines.push(copy.emptyChecklist);
    if (checklist.omittedProcessCount > 0) {
      lines.push(copy.omittedProcess(checklist.omittedProcessCount));
    }
  } else {
    lines.push(copy.checklistTitle);
    for (const deliverable of checklist.items) {
      const kind = (deliverable.kind ?? 'text').trim();
      const uri = (deliverable.uri ?? '').trim();
      const preview = (deliverable.preview ?? '').trim();
      const body = uri || preview;
      if (!body) continue;
      const author = (deliverable.authorName ?? '').trim() || 'unknown';
      if (uri) {
        const verification = deliverableVerificationLabel({
          confirmation: deliverable.confirmation,
          verification: null,
        } as GroupTaskDeliverable);
        const statusNote = deliverable.status === 'pending' ? '' : ` · ${deliverable.status}`;
        lines.push(`- [${kind}] ${body} (${verification}${statusNote}) — ${author}`);
      } else {
        lines.push(`- [${kind}] ${body} — ${author}`);
      }
    }
    if (checklist.omittedProcessCount > 0) {
      lines.push(copy.omittedProcess(checklist.omittedProcessCount));
    }
  }
  const planChanges = (summary.planChanges ?? []).map((line) => line.trim()).filter(Boolean);
  if (planChanges.length > 0) {
    lines.push('');
    lines.push(copy.planChangesTitle);
    for (const change of planChanges.slice(0, PLAN_CHANGE_MAX_RENDER_LINES)) {
      lines.push(`- ${acceptancePreview(change, PLAN_CHANGE_LINE_MAX_CHARS)}`);
    }
    if (planChanges.length > PLAN_CHANGE_MAX_RENDER_LINES) {
      lines.push(copy.omittedPlanChanges(planChanges.length - PLAN_CHANGE_MAX_RENDER_LINES));
    }
  }
  // G-05: findings OUTSIDE the declared criteria render as explicitly
  // non-blocking observations — never as acceptance gaps (task #48: "archive
  // not on-chain" listed as a gap although the criteria never asked for it).
  const observations = (summary.observations ?? []).map((line) => line.trim()).filter(Boolean);
  if (observations.length > 0) {
    lines.push('');
    lines.push(copy.observationsTitle);
    for (const observation of observations.slice(0, PLAN_CHANGE_MAX_RENDER_LINES)) {
      lines.push(`- ${acceptancePreview(observation, PLAN_CHANGE_LINE_MAX_CHARS)}`);
    }
    if (observations.length > PLAN_CHANGE_MAX_RENDER_LINES) {
      lines.push(copy.omittedPlanChanges(observations.length - PLAN_CHANGE_MAX_RENDER_LINES));
    }
  }
  lines.push('');
  if (summary.members.length > 0) {
    lines.push(copy.members(summary.members.map((member) => member.name ?? 'unknown').join(copy.memberJoin)));
    lines.push('');
  }
  lines.push(summary.guidance.trim());
  return withGroupTaskNotice(GROUP_TASK_NOTICE.reviewSummary, lines.join('\n'));
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
  language?: AppLanguage;
}): {
  goal: string;
  acceptanceCriteria: string | null;
  deliverables: GroupTaskAcceptanceSummaryDeliverable[];
  members: GroupTaskAcceptanceSummaryMember[];
  planChanges: string[];
  guidance: string;
  messageText: string;
} {
  const language = input.language ?? groupTaskLanguage();
  const deliverables = buildAcceptanceSummaryDeliverables(input.deliverables, input.members);
  const members = buildAcceptanceSummaryMembers(input.members);
  const guidance = buildAcceptanceGuidance(input.task, language);
  const planChanges = (input.planChanges ?? []).map((line) => line.trim()).filter(Boolean);
  const summaryShape = {
    goal: input.task.goal,
    acceptanceCriteria: input.task.acceptanceCriteria ?? null,
    deliverables,
    members,
    planChanges,
    guidance,
  };
  const messageText = buildAcceptanceSummaryMessageText(summaryShape, input.task.title, language);
  return { ...summaryShape, messageText };
}
