/**
 * Host-authored group-task copy (zh/en).
 *
 * Pure: no Electron import. Production wires {@link setGroupTaskCopyLanguageGetter}
 * to {@link getPersistedAppLanguage} so English Settings never fall back to
 * Chinese. Tests leave the getter unset and therefore stay on zh, matching
 * the existing Chinese fixtures.
 *
 * Protocol tags ([WORKING], [GROUP_TASK_REVIEW], …) stay ASCII. Human-readable
 * wrappers around them follow the owner language. Group-chat host lines also
 * carry a language-neutral `[GROUP_TASK_NOTICE:<kind>]` prefix so the UI can
 * detect them without matching Chinese.
 */

import type { AppLanguage } from './inferLanguageFromLocale';

export type { AppLanguage };

let languageGetter: (() => AppLanguage) | null = null;

export function setGroupTaskCopyLanguageGetter(getter: (() => AppLanguage) | null): void {
  languageGetter = getter;
}

export function groupTaskLanguage(): AppLanguage {
  try {
    return languageGetter?.() === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

export function pickCopy(zh: string, en: string, language: AppLanguage = groupTaskLanguage()): string {
  return language === 'en' ? en : zh;
}

export const GROUP_TASK_NOTICE = {
  welcome: 'welcome',
  reviewClosing: 'review_closing',
  reviewSummary: 'review_summary',
  checkpointOpen: 'checkpoint_open',
  checkpointResolved: 'checkpoint_resolved',
  longTurn: 'long_turn',
} as const;

export type GroupTaskNoticeKind = (typeof GROUP_TASK_NOTICE)[keyof typeof GROUP_TASK_NOTICE];

export function groupTaskNoticePrefix(kind: GroupTaskNoticeKind): string {
  return `[GROUP_TASK_NOTICE:${kind}]`;
}

export function withGroupTaskNotice(kind: GroupTaskNoticeKind, body: string): string {
  return `${groupTaskNoticePrefix(kind)}\n${body}`;
}

export function hasGroupTaskNotice(content: string, kind?: GroupTaskNoticeKind): boolean {
  const text = String(content ?? '').trimStart();
  if (kind) return text.startsWith(groupTaskNoticePrefix(kind));
  return text.startsWith('[GROUP_TASK_NOTICE:');
}

/**
 * Fold detector for the host acceptance checklist (group transcript).
 * Prefers the language-neutral notice prefix; keeps the pre-i18n Chinese
 * opening so historical messages still fold.
 */
export function isAcceptanceSummaryNotice(content: string): boolean {
  const text = String(content ?? '').trimStart();
  if (text.startsWith(groupTaskNoticePrefix(GROUP_TASK_NOTICE.reviewSummary))) return true;
  return text.startsWith('📦 任务「') && text.includes('已进入验收阶段');
}

/** Presence roll-call — not a work assignment. Must match both host languages. */
const ROLL_CALL_RE = /请确认在线|确认在线|confirm you(?:['’]re| are) online|please confirm (?:you are )?online/i;

export function isRollCallPresenceCheck(content: string): boolean {
  return ROLL_CALL_RE.test(String(content ?? ''));
}

export function buildMemberJoinWelcomeText(
  input: {
    taskId?: number;
    taskTitle: string;
    joinerName: string;
    invitedFor?: string | null;
    existingMemberNames: string[];
  },
  language: AppLanguage = groupTaskLanguage(),
): string {
  const names = input.existingMemberNames.map((name) => name.trim()).filter(Boolean);
  const invitedFor = input.invitedFor?.trim() ?? '';
  const why = invitedFor
    ? pickCopy(`受邀参与:${invitedFor}`, `Invited for: ${invitedFor}`, language)
    : pickCopy('受邀参与本任务协作', 'Invited to collaborate on this task', language);
  const lines = language === 'en'
    ? [
      `🎉 Welcome @${input.joinerName} to task "${input.taskTitle}"!`,
      `${input.joinerName} ${why}.`,
      `@${input.joinerName}: Please greet the group to confirm you are present, then start work.`,
    ]
    : [
      `🎉 欢迎 @${input.joinerName} 加入任务「${input.taskTitle}」!`,
      `${input.joinerName} ${why}。`,
      `@${input.joinerName}:请先向群内打个招呼确认就位,再开始工作。`,
    ];
  if (names.length > 0) {
    const mentions = names.map((name) => `@${name}`).join(' ');
    lines.push(
      language === 'en'
        ? `${mentions}: Please confirm you are online (once each, no small talk).`
        : `${mentions}:请确认在线(每人一次即可,无需客套)。`,
    );
  }
  return withGroupTaskNotice(GROUP_TASK_NOTICE.welcome, lines.join('\n'));
}

export function buildReviewClosingLine(
  taskTitle: string,
  language: AppLanguage = groupTaskLanguage(),
): string {
  const body = language === 'en'
    ? `📦 Task "${taskTitle}" has completed every step and entered acceptance. Waiting for human review.`
    : `📦 任务「${taskTitle}」所有步骤已完成,进入验收阶段,等待人类评审。`;
  return withGroupTaskNotice(GROUP_TASK_NOTICE.reviewClosing, body);
}

export function copyDefaultObserverExpectation(language: AppLanguage = groupTaskLanguage()): string {
  return pickCopy('静默观察 / 待命接手 / 可退出', 'observe silently / stand by / may leave', language);
}

export function copyObserverSectionHeader(language: AppLanguage = groupTaskLanguage()): string {
  return pickCopy('未派活成员预期（observer/standby）：', 'Unassigned members (observer/standby):', language);
}

export function copyObserverLine(
  name: string,
  expectation: string,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en' ? `- ${name}: ${expectation}` : `- ${name}：${expectation}`;
}

export function copyWorkingAckFallback(
  objective: string,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en'
    ? `[WORKING] On it: "${objective}". Will take a little time.`
    : `[WORKING] 已接单，正在处理「${objective}」，预计需要一些时间。`;
}

export function copyWorkingAckExample(language: AppLanguage = groupTaskLanguage()): string {
  return language === 'en'
    ? '[WORKING] On it: X, ETA N min'
    : '[WORKING] 已接单，正在做X，预计N分钟';
}

export function copyStandbyExample(language: AppLanguage = groupTaskLanguage()): string {
  return language === 'en'
    ? '[STANDBY] observing / on standby / can exit'
    : '[STANDBY] 静默观察 / 待命接手 / 可退出';
}

export function copyCorrectionApplied(
  id: number,
  kind: string,
  uri: string,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en'
    ? `✓ Correction applied: deliverable #${id} (${kind}) updated in place to ${uri}`
    : `✓ 更正优先：交付物 #${id}（${kind}）已就地更新为 ${uri}`;
}

export function copyPinidNotSynced(
  pinPrefix: string,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en'
    ? `… Host verification: pinid ${pinPrefix}… not synced (indexer lag, sources disagree); will retry`
    : `… Host verification: pinid ${pinPrefix}… 未同步（索引延迟，多源不一致），将自动重试`;
}

export function copyLocalDeliverableOnChain(
  uri: string,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en'
    ? `✓ Local deliverable published on-chain as ${uri}`
    : `✓ 本地交付物已上链为 ${uri}`;
}

export function copyLocalDeliverableNoPin(
  filePath: string,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en'
    ? `⚠ Local deliverable upload returned no pinId: ${filePath}`
    : `⚠ 本地交付物上传未返回 pinId：${filePath}`;
}

export function copyLocalDeliverableUploadFailed(
  filePath: string,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en'
    ? `⚠ Local deliverable upload failed (${filePath})`
    : `⚠ 本地交付物上传失败（${filePath}）`;
}

export function copyCheckpointNeedDecision(
  summary: string,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en' ? ` Decision needed: ${summary}` : ` 需要你拍板：${summary}`;
}

export function buildCheckpointPauseLine(input: {
  taskId: number;
  taskTitle: string;
  topic: string | null;
  summaryClause: string;
}, language: AppLanguage = groupTaskLanguage()): string {
  const topic = (input.topic ?? '').trim()
    || pickCopy('等待主人决策', 'awaiting owner decision', language);
  const body = language === 'en'
    ? `⏸️ Task #${input.taskId} "${input.taskTitle}" entered a human checkpoint (${topic}): `
      + `work is paused pending the owner's reply.${input.summaryClause}`
      + ' The owner can reply in this group or privately to Twinbot.'
    : `⏸️ 任务 #${input.taskId}「${input.taskTitle}」进入人工确认点（${topic}）：`
      + `任务暂停推进，等待主人反馈。${input.summaryClause}`
      + '主人可直接在本群留言，或与 Twinbot 私聊给出意见。';
  return withGroupTaskNotice(GROUP_TASK_NOTICE.checkpointOpen, body);
}

export function buildCheckpointResumeLine(input: {
  taskId: number;
  taskTitle: string;
  resolution: string | null;
}, language: AppLanguage = groupTaskLanguage()): string {
  const resolution = (input.resolution ?? '').trim()
    || pickCopy('主人已确认', 'owner confirmed', language);
  const body = language === 'en'
    ? `▶️ Task #${input.taskId} "${input.taskTitle}" checkpoint passed (${resolution}); work continues.`
    : `▶️ 任务 #${input.taskId}「${input.taskTitle}」人工确认点已通过（${resolution}），任务继续推进。`;
  return withGroupTaskNotice(GROUP_TASK_NOTICE.checkpointResolved, body);
}

export function buildLongTurnStandbyNote(
  memberName: string,
  language: AppLanguage = groupTaskLanguage(),
): string {
  const body = language === 'en'
    ? `@chair ℹ️ ${memberName} is in a long-running turn (recent progress/delivery). New assignments will wait until this turn finishes; no action needed.`
    : `@chair ℹ️ ${memberName} 正在长回合执行中（近期有进展/交付），新派单将在本回合结束后处理，无需干预。`;
  return withGroupTaskNotice(GROUP_TASK_NOTICE.longTurn, body);
}

export function buildAcceptanceGuidanceText(language: AppLanguage = groupTaskLanguage()): string {
  return language === 'en'
    ? [
      'You can:',
      '1. On the Tasks panel acceptance card, tap Accept & Close and rate (1–5 stars + optional comment) — the task closes;',
      '2. On the card, tap Back to work / Rework — execution resumes and the chair will assign follow-up work;',
      '3. Reply in the group — the chair will act on your feedback.',
    ].join('\n')
    : [
      '你可以：',
      '① 在 Tasks 面板的验收卡点「Accept & Close」并评分（1-5 星 + 可选评语）——任务关闭；',
      '② 在验收卡点「Back to work / Rework」——返回执行，chair 会补派工作；',
      '③ 在群内直接回复意见——chair 会按你的意见处理。',
    ].join('\n');
}

export function acceptanceSummaryCopy(language: AppLanguage = groupTaskLanguage()): {
  header: (title: string) => string;
  conclusion: (text: string) => string;
  goal: (text: string) => string;
  criteria: (text: string) => string;
  criteriaEmpty: string;
  emptyChecklist: string;
  checklistTitle: string;
  omittedProcess: (count: number) => string;
  planChangesTitle: string;
  omittedPlanChanges: (count: number) => string;
  members: (names: string) => string;
  memberJoin: string;
} {
  if (language === 'en') {
    return {
      header: (title) => `📦 Task "${title}" has entered acceptance. Here is the outcome summary.`,
      conclusion: (text) => `Conclusion: ${text}`,
      goal: (text) => `Goal: ${text}`,
      criteria: (text) => `Acceptance criteria: ${text}`,
      criteriaEmpty: '(not specified)',
      emptyChecklist: 'Deliverables: no verified artifacts.',
      checklistTitle: 'Deliverables:',
      omittedProcess: (count) => `(${count} process note(s) omitted; see the in-group report)`,
      planChangesTitle: 'Plan changes:',
      omittedPlanChanges: (count) => `(${count} more change(s); see the in-group log)`,
      members: (names) => `Members: ${names}`,
      memberJoin: ', ',
    };
  }
  return {
    header: (title) => `📦 任务「${title}」已进入验收阶段，以下为成果汇总。`,
    conclusion: (text) => `结论：${text}`,
    goal: (text) => `目标：${text}`,
    criteria: (text) => `验收标准：${text}`,
    criteriaEmpty: '（未填写）',
    emptyChecklist: '成果清单：无已核验交付物。',
    checklistTitle: '成果清单：',
    omittedProcess: (count) => `（另有 ${count} 项过程记录，见群内报告）`,
    planChangesTitle: '方案变更：',
    omittedPlanChanges: (count) => `（另有 ${count} 项变更，见群内记录）`,
    members: (names) => `成员：${names}`,
    memberJoin: '、',
  };
}

export function buildSourceSessionAcceptanceNotice(input: {
  title: string;
  outcome: 'done' | 'cancelled';
  ratingLine: string;
  commentLine: string;
  deliverableCount: number;
  summaryVersion: number | null;
}, language: AppLanguage = groupTaskLanguage()): string {
  if (language === 'en') {
    const artifacts = input.summaryVersion != null
      ? `Artifacts: ${input.deliverableCount} item(s) (see acceptance summary v${input.summaryVersion})`
      : `Artifacts: ${input.deliverableCount} item(s); see the Tasks panel`;
    return [
      `[GROUP_TASK_ACCEPTANCE] Task "${input.title}" acceptance finished:`,
      `Result: ${input.outcome}${input.ratingLine}${input.commentLine}`,
      artifacts,
    ].join('\n');
  }
  return [
    `[GROUP_TASK_ACCEPTANCE] 任务「${input.title}」已完成验收：`,
    `结果：${input.outcome}${input.ratingLine}${input.commentLine}`,
    `成果：${input.deliverableCount} 项${input.summaryVersion != null ? `（详见验收总结 v${input.summaryVersion}）` : '，详见 Tasks 面板'}`,
  ].join('\n');
}

export function copyAcceptanceRatingLine(
  rating: number,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en' ? ` | rating ${rating}/5` : `｜评分 ${rating}/5`;
}

export function copyAcceptanceCommentLine(
  comment: string,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en' ? ` (${comment})` : `（${comment}）`;
}

export function copyReviewVersionTag(
  version: number,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en' ? ` (acceptance summary v${version})` : `（验收摘要 v${version}）`;
}

export function buildSourceSessionReviewNotice(input: {
  title: string;
  versionTag: string;
  conclusion: string;
}, language: AppLanguage = groupTaskLanguage()): string {
  if (language === 'en') {
    return [
      `[GROUP_TASK_REVIEW] Task "${input.title}" has entered acceptance${input.versionTag}.`,
      `Conclusion: ${input.conclusion}`,
      'The full checklist and Accept & Close / Rework actions are on the Tasks panel acceptance card.',
    ].join('\n');
  }
  return [
    `[GROUP_TASK_REVIEW] 任务「${input.title}」已进入验收${input.versionTag}。`,
    `结论：${input.conclusion}`,
    '完整验收清单与 Accept & Close / Rework 操作见 Tasks 面板的验收卡。',
  ].join('\n');
}

export function buildSourceSessionReviewFallback(input: {
  title: string;
  body: string;
}, language: AppLanguage = groupTaskLanguage()): string {
  if (language === 'en') {
    return [
      `[GROUP_TASK_REVIEW] Task "${input.title}" has entered acceptance (host-generated summary; the chair's first-hand verdict is in the group):`,
      input.body,
    ].join('\n');
  }
  return [
    `[GROUP_TASK_REVIEW] 任务「${input.title}」已进入验收（系统生成验收汇总，chair 一手核验结论见群内）：`,
    input.body,
  ].join('\n');
}

export function copyReviewReportTruncated(
  body: string,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en'
    ? `${body}…\n(Report truncated — full acceptance summary is on the Tasks panel and in the group chair summary.)`
    : `${body}…\n（报告过长已截断——完整验收摘要见 Tasks 面板与群内 chair 摘要消息）`;
}

export function buildOrchNotifyCompleted(
  workerName: string,
  taskId: string | number,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en'
    ? `[ORCH-NOTIFY] worker ${workerName} completed task ${taskId} → review; please accept`
    : `[ORCH-NOTIFY] worker ${workerName} 已完成 task ${taskId} → review，请验收`;
}

export function buildOrchNotifyFailed(
  workerName: string,
  taskId: string | number,
  detail: string,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en'
    ? `[ORCH-NOTIFY] worker ${workerName} did not complete task ${taskId}: ${detail} (failed)`
    : `[ORCH-NOTIFY] worker ${workerName} 未完成 task ${taskId}：${detail}（failed）`;
}

export function wrapCrossSessionMessage(
  sourceSessionId: string,
  message: string,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en'
    ? `From ${sourceSessionId}: ${message}`
    : `来自${sourceSessionId} 的信息：${message}`;
}

export function copyRespondingPlaceholder(language: AppLanguage = groupTaskLanguage()): string {
  return pickCopy('响应中…', 'Responding…', language);
}

export function copyMetabotNotFound(language: AppLanguage = groupTaskLanguage()): string {
  return pickCopy('未找到指定的 MetaBot', 'The specified MetaBot was not found', language);
}

export function copyOwnerLanguageName(language: AppLanguage = groupTaskLanguage()): string {
  return language === 'en' ? 'English' : 'Chinese (Simplified)';
}

export function copyConclusionTagInstruction(language: AppLanguage = groupTaskLanguage()): string {
  return language === 'en'
    ? 'the FIRST line of your report must be exactly `Conclusion: <one line, ≤80 chars>` (the host also accepts `【结论】`).'
    : 'the FIRST line of your report must be exactly 【结论】<one line, ≤80 chars> (the host also accepts `Conclusion:`).';
}

export function copyGuestHandshakeExample(
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en'
    ? '`Hi everyone, I am <your name>, present and ready to start.`'
    : '`大家好，我是<your name>，已就位，随时可以开始。`';
}
