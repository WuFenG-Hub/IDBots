/**
 * Daily Report (每日汇报) generator — turns the collector's facts into the
 * briefing that lands in the Twin chat and the self-contained HTML report
 * file.
 *
 * Two layers, deliberately split:
 *
 * 1. Deterministic assembler (NEVER delegated to the LLM): the follow-up
 *    list with `[title](idbots://session/<id>)` deep links and overdue
 *    badges, the owner-task table, the machine/fleet sections, and the HTML
 *    report. Ids and links are attached here — the brain only ever sees
 *    titles, so it can never invent a wrong link.
 * 2. Brain prose: ONE chat-completion call (dream-style ladder injected by
 *    the service: twin/system brain primary → fallback) writes the headline,
 *    ≤7 progress bullets and a "needs your decision" paragraph keyed to the
 *    follow-up TITLES. Bounded input (facts JSON), bounded output (~1200
 *    tokens), 120s wall timeout. On timeout/failure/no-brain the report
 *    degrades to pure-data deterministic prose — the report always ships.
 *
 * Language: the deterministic strings come from a small zh/en table selected
 * by the UI locale at generation time (default English, Chinese when the
 * locale is zh); the brain is instructed to write in the same language.
 *
 * Kept free of runtime relative imports so plain-Node tests can load it with
 * type stripping (fs/path/node:url only).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { DailyReportFacts } from './dailyReportCollector';

/** Local YYYY-MM-DD (inlined so this module stays free of runtime relative
 * imports — plain-Node tests load it with type stripping). */
const formatLocalDate = (ms: number): string => {
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
};

// ── Locale strings ─────────────────────────────────────────────────────────

export type DailyReportLanguage = 'en' | 'zh';

export interface DailyReportStrings {
  language: DailyReportLanguage;
  reportTitle: string;
  windowLabel: string;
  needsYouTitle: string;
  progressTitle: string;
  fleetTitle: string;
  overdueBadge: string;
  waitingDaysSuffix: string;
  noOpenItems: string;
  ownerTasksIntro: string;
  columnTask: string;
  columnStatus: string;
  columnSteps: string;
  columnProgress: string;
  columnBot: string;
  columnMessages: string;
  humanSessionsIntro: string;
  scheduledRunsIntro: string;
  groupTasksIntro: string;
  longTermIntro: string;
  twinDelegateIntro: string;
  digestsIntro: string;
  onlineIntro: string;
  newSessionsIntro: string;
  statusLabel: string;
  stepsDone: string;
  viewFullReport: string;
  fallbackHeadline: string;
  generatedAtLabel: string;
  htmlNeedsYou: string;
  htmlProgress: string;
  htmlFleet: string;
  htmlOwnerTasks: string;
  htmlLongTerm: string;
  htmlDigests: string;
  htmlOnline: string;
  htmlMachine: string;
  htmlStatus: string;
  htmlSteps: string;
  htmlBot: string;
}

export const DAILY_REPORT_STRINGS_EN: DailyReportStrings = {
  language: 'en',
  reportTitle: 'Daily Report',
  windowLabel: 'Window',
  needsYouTitle: 'Needs you',
  progressTitle: 'Progress on your work',
  fleetTitle: 'Fleet & machine activity',
  overdueBadge: 'overdue',
  waitingDaysSuffix: 'd waiting',
  noOpenItems: 'Nothing is waiting on you right now.',
  ownerTasksIntro: 'Owner-sourced tasks:',
  columnTask: 'Task',
  columnStatus: 'Status',
  columnSteps: 'Steps',
  columnProgress: 'Progress',
  columnBot: 'Bot',
  columnMessages: 'Messages',
  humanSessionsIntro: 'Sessions you worked in:',
  scheduledRunsIntro: 'Scheduled runs:',
  groupTasksIntro: 'Group task updates:',
  longTermIntro: 'Long-term projects:',
  twinDelegateIntro: 'Twin-delegated orchestrations touched:',
  digestsIntro: 'Bot daily digests:',
  onlineIntro: 'Online activity:',
  newSessionsIntro: 'New sessions created:',
  statusLabel: 'status',
  stepsDone: 'steps done',
  viewFullReport: 'View the full report',
  fallbackHeadline: 'Here is your daily briefing.',
  generatedAtLabel: 'Generated',
  htmlNeedsYou: 'Needs you',
  htmlProgress: 'Progress',
  htmlFleet: 'Fleet & machine activity',
  htmlOwnerTasks: 'Owner tasks',
  htmlLongTerm: 'Long-term projects',
  htmlDigests: 'Bot digests',
  htmlOnline: 'Online activity',
  htmlMachine: 'Machine activity',
  htmlStatus: 'Status',
  htmlSteps: 'Steps',
  htmlBot: 'Bot',
};

export const DAILY_REPORT_STRINGS_ZH: DailyReportStrings = {
  language: 'zh',
  reportTitle: '每日汇报',
  windowLabel: '统计区间',
  needsYouTitle: '需要你处理',
  progressTitle: '你的工作进展',
  fleetTitle: 'Bot 与自动化动态',
  overdueBadge: '已逾期',
  waitingDaysSuffix: '天待处理',
  noOpenItems: '当前没有等待你处理的事项。',
  ownerTasksIntro: '你发起的任务：',
  columnTask: '任务',
  columnStatus: '状态',
  columnSteps: '步骤',
  columnProgress: '进度',
  columnBot: 'Bot',
  columnMessages: '消息数',
  humanSessionsIntro: '你参与的会话：',
  scheduledRunsIntro: '定时任务执行：',
  groupTasksIntro: '群任务动态：',
  longTermIntro: '长期项目：',
  twinDelegateIntro: 'Twin 自动派单触及：',
  digestsIntro: 'Bot 每日摘要：',
  onlineIntro: '在线活动：',
  newSessionsIntro: '新建会话：',
  statusLabel: '状态',
  stepsDone: '步已完成',
  viewFullReport: '查看完整报告',
  fallbackHeadline: '这是你的每日简报。',
  generatedAtLabel: '生成时间',
  htmlNeedsYou: '需要你处理',
  htmlProgress: '进展',
  htmlFleet: 'Bot 与自动化动态',
  htmlOwnerTasks: 'Owner 任务',
  htmlLongTerm: '长期项目',
  htmlDigests: 'Bot 摘要',
  htmlOnline: '在线活动',
  htmlMachine: '自动化执行',
  htmlStatus: '状态',
  htmlSteps: '步骤',
  htmlBot: 'Bot',
};

/** Small zh/en table; anything that is not explicitly Chinese stays English. */
export const resolveDailyReportStrings = (locale: string | null | undefined): DailyReportStrings =>
  typeof locale === 'string' && locale.trim().toLowerCase().startsWith('zh')
    ? DAILY_REPORT_STRINGS_ZH
    : DAILY_REPORT_STRINGS_EN;

// ── Markdown helpers ───────────────────────────────────────────────────────

export const sessionDeepLink = (sessionId: string): string => `idbots://session/${sessionId}`;

/** Link text must not contain markdown control characters. */
export const sanitizeMarkdownLinkText = (text: string): string =>
  text.replace(/([\[\]\\])/g, ' ').replace(/\s+/g, ' ').trim() || '(untitled)';

const escapeHtml = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const markdownTableCell = (value: unknown): string =>
  String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

const STATUS_EMOJI: Record<string, string> = {
  completed: '✅',
  done: '✅',
  success: '✅',
  skipped: '⏭️',
  failed: '❌',
  error: '❌',
  running: '▶️',
  executing: '▶️',
  review: '🔎',
  planning: '📋',
  pending: '⏳',
};

const statusEmoji = (status: string): string => STATUS_EMOJI[status] ?? '•';

/**
 * Deterministic follow-up list — always present, links attached here. The
 * brain may additionally write prose keyed to these titles, but the list
 * itself never comes from the LLM.
 */
export const buildDailyReportFollowUpListMarkdown = (
  facts: DailyReportFacts,
  strings: DailyReportStrings,
): string => {
  if (facts.pendingFollowUps.length === 0) {
    return `**${strings.needsYouTitle}** — ${strings.noOpenItems}`;
  }
  const lines = facts.pendingFollowUps.map((item) => {
    const age = item.ageDays !== null && item.ageDays > 0
      ? ` · ${item.ageDays}${strings.waitingDaysSuffix}`
      : '';
    const overdue = item.overdue ? ` · **${strings.overdueBadge}**` : '';
    const bot = item.botName ? ` · ${item.botName}` : '';
    return `- [${sanitizeMarkdownLinkText(item.title)}](${sessionDeepLink(item.sessionId)})${bot}${age}${overdue}`;
  });
  return [`**${strings.needsYouTitle}**`, ...lines].join('\n');
};

/** Deterministic owner-task table with step counts / percent complete. */
export const buildDailyReportOwnerTasksMarkdown = (
  facts: DailyReportFacts,
  strings: DailyReportStrings,
): string => {
  if (facts.ownerOrchestrations.length === 0) return '';
  const header = `| ${strings.columnTask} | ${strings.columnStatus} | ${strings.columnSteps} | ${strings.columnProgress} |`;
  const divider = '| --- | --- | --- | --- |';
  const rows = facts.ownerOrchestrations.map((task) => {
    const steps = task.stepsTotal > 0 ? `${task.stepsDone}/${task.stepsTotal}` : '—';
    const progress = task.percentComplete !== null ? `${task.percentComplete}%` : '—';
    return `| ${markdownTableCell(task.title)} | ${task.status} | ${steps} | ${progress} |`;
  });
  return [strings.ownerTasksIntro, header, divider, ...rows].join('\n');
};

/**
 * The full deterministic briefing — the fallback the report degrades to when
 * the brain is unavailable, and the base the brain prose is spliced into.
 */
export const buildDeterministicBriefing = (
  facts: DailyReportFacts,
  strings: DailyReportStrings,
): string => {
  const sections: string[] = [];

  sections.push(buildDailyReportFollowUpListMarkdown(facts, strings));

  const ownerTasks = buildDailyReportOwnerTasksMarkdown(facts, strings);
  if (ownerTasks) sections.push(ownerTasks);

  if (facts.humanSessions.length > 0) {
    const lines = facts.humanSessions.map((session) => {
      const bot = session.botName ? ` · ${session.botName}` : '';
      const counts = ` · ${session.humanUserMessages}/${session.assistantMessages} ${strings.columnMessages.toLowerCase()}`;
      return `- [${sanitizeMarkdownLinkText(session.title)}](${sessionDeepLink(session.sessionId)})${bot}${counts}`;
    });
    sections.push([strings.humanSessionsIntro, ...lines].join('\n'));
  }

  if (facts.machineActivity.longTermProgress.length > 0) {
    const lines = facts.machineActivity.longTermProgress.map((task) =>
      `- ${sanitizeMarkdownLinkText(task.title)} — ${task.stage} · ${task.percentComplete}% (${task.subtasksAccepted}/${task.subtasksTotal} ${strings.stepsDone})`,
    );
    sections.push([strings.longTermIntro, ...lines].join('\n'));
  }

  const machineLines: string[] = [];
  for (const run of facts.machineActivity.scheduledRuns) {
    const skip = run.skipReason ? ` (${run.skipReason})` : '';
    machineLines.push(`- ${statusEmoji(run.status)} ${run.taskName} — ${run.status}${skip}${run.botName ? ` · ${run.botName}` : ''}`);
  }
  for (const transition of facts.machineActivity.groupTaskTransitions) {
    machineLines.push(`- ${statusEmoji(transition.toStatus)} ${sanitizeMarkdownLinkText(transition.title)} — ${transition.fromStatus ?? '?'} → ${transition.toStatus}`);
  }
  for (const event of facts.machineActivity.longTermEvents.slice(0, 5)) {
    machineLines.push(`- ${sanitizeMarkdownLinkText(event.taskTitle)} — ${event.kind}${event.detail ? `: ${event.detail}` : ''}`);
  }
  if (facts.machineActivity.twinDelegateOrchestrationsInWindow > 0) {
    machineLines.push(`- ${strings.twinDelegateIntro} ${facts.machineActivity.twinDelegateOrchestrationsInWindow}`);
  }
  if (machineLines.length > 0) {
    sections.push([strings.scheduledRunsIntro.replace(/:$/, '') + ' / ' + strings.fleetTitle, ...machineLines].join('\n'));
  }

  if (facts.onlineActivity.length > 0) {
    const lines = facts.onlineActivity.map((entry) =>
      `- ${entry.botName} — ${strings.columnMessages}: ${entry.privateMessageCount} DM / ${entry.groupMessageCount} group`,
    );
    sections.push([strings.onlineIntro, ...lines].join('\n'));
  }

  if (facts.botDigests.length > 0) {
    const lines = facts.botDigests.map((digest) => {
      const twin = digest.isTwin ? ' ★' : '';
      return `- **${digest.botName}${twin}** (${digest.summaryDate}): ${digest.summaryText}`;
    });
    sections.push([strings.digestsIntro, ...lines].join('\n'));
  }

  sections.push(`${strings.newSessionsIntro} ${facts.newSessionCount}`);

  return sections.filter(Boolean).join('\n\n');
};

// ── HTML report (deterministic) ────────────────────────────────────────────

export const buildDailyReportHtml = (input: {
  facts: DailyReportFacts;
  strings: DailyReportStrings;
  dateLabel: string;
  headlineText?: string | null;
  proseHtml?: string | null;
}): string => {
  const { facts, strings, dateLabel } = input;
  const followUpRows = facts.pendingFollowUps.map((item) => {
    const badges = [
      item.botName ? escapeHtml(item.botName) : '',
      item.ageDays !== null && item.ageDays > 0 ? `${item.ageDays}${escapeHtml(strings.waitingDaysSuffix)}` : '',
      item.overdue ? `<span class="badge overdue">${escapeHtml(strings.overdueBadge)}</span>` : '',
    ].filter(Boolean).join(' · ');
    return `<tr><td><a href="${sessionDeepLink(item.sessionId)}">${escapeHtml(item.title)}</a></td><td>${badges}</td></tr>`;
  }).join('');

  const ownerTaskRows = facts.ownerOrchestrations.map((task) => `<tr>
    <td>${escapeHtml(task.title)}</td>
    <td>${escapeHtml(task.status)}</td>
    <td>${task.stepsTotal > 0 ? `${task.stepsDone}/${task.stepsTotal}` : '—'}</td>
    <td>${task.percentComplete !== null ? `${task.percentComplete}%` : '—'}</td>
  </tr>`).join('');

  const humanSessionRows = facts.humanSessions.map((session) => `<tr>
    <td><a href="${sessionDeepLink(session.sessionId)}">${escapeHtml(session.title)}</a></td>
    <td>${escapeHtml(session.botName ?? '—')}</td>
    <td>${session.humanUserMessages}/${session.assistantMessages}</td>
  </tr>`).join('');

  const longTermRows = facts.machineActivity.longTermProgress.map((task) => `<tr>
    <td>${escapeHtml(task.title)}</td>
    <td>${escapeHtml(task.stage)}</td>
    <td>${task.percentComplete}% (${task.subtasksAccepted}/${task.subtasksTotal})</td>
  </tr>`).join('');

  const machineItems = [
    ...facts.machineActivity.scheduledRuns.map((run) =>
      `<li>${statusEmoji(run.status)} ${escapeHtml(run.taskName)} — ${escapeHtml(run.status)}${run.skipReason ? ` (${escapeHtml(run.skipReason)})` : ''}${run.botName ? ` · ${escapeHtml(run.botName)}` : ''}</li>`),
    ...facts.machineActivity.groupTaskTransitions.map((transition) =>
      `<li>${statusEmoji(transition.toStatus)} ${escapeHtml(transition.title)} — ${escapeHtml(transition.fromStatus ?? '?')} → ${escapeHtml(transition.toStatus)}</li>`),
    ...facts.machineActivity.longTermEvents.slice(0, 5).map((event) =>
      `<li>${escapeHtml(event.taskTitle)} — ${escapeHtml(event.kind)}</li>`),
  ].join('');

  const digestRows = facts.botDigests.map((digest) => `<tr>
    <td>${escapeHtml(digest.botName)}${digest.isTwin ? ' ★' : ''}</td>
    <td>${escapeHtml(digest.summaryDate)}</td>
    <td>${escapeHtml(digest.summaryText)}</td>
  </tr>`).join('');

  const onlineRows = facts.onlineActivity.map((entry) => `<tr>
    <td>${escapeHtml(entry.botName)}</td>
    <td>${entry.privateMessageCount}</td>
    <td>${entry.groupMessageCount}</td>
  </tr>`).join('');

  const generatedAt = new Date(facts.generatedAtMs).toLocaleString(strings.language === 'zh' ? 'zh-CN' : 'en-US');

  const section = (title: string, body: string) =>
    body ? `<section><h2>${escapeHtml(title)}</h2>${body}</section>` : '';

  return `<!DOCTYPE html>
<html lang="${strings.language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(strings.reportTitle)} ${escapeHtml(dateLabel)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "PingFang SC", "Segoe UI", sans-serif; margin: 0; padding: 32px 20px; background: #0f1115; color: #e6e8ee; }
  .wrap { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .meta { color: #8a90a2; font-size: 12px; margin-bottom: 24px; }
  .headline { font-size: 17px; line-height: 1.6; margin: 0 0 24px; padding: 14px 16px; background: #171a22; border: 1px solid #262b38; border-radius: 10px; }
  section { margin-bottom: 26px; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .06em; color: #9aa3b8; margin: 0 0 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #232837; vertical-align: top; }
  th { color: #9aa3b8; font-weight: 600; }
  a { color: #6ea8fe; text-decoration: none; }
  ul { margin: 0; padding-left: 18px; font-size: 13px; }
  li { margin: 4px 0; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; }
  .badge.overdue { background: #5a2b2b; color: #ffb4b4; }
</style>
</head>
<body>
<div class="wrap">
  <h1>${escapeHtml(strings.reportTitle)} · ${escapeHtml(dateLabel)}</h1>
  <div class="meta">${escapeHtml(strings.windowLabel)}: ${escapeHtml(formatLocalDate(facts.windowStartMs))} → ${escapeHtml(formatLocalDate(facts.windowEndMs))} · ${escapeHtml(strings.generatedAtLabel)}: ${escapeHtml(generatedAt)}</div>
  ${input.headlineText && !input.proseHtml ? `<div class="headline">${escapeHtml(input.headlineText)}</div>` : ''}
  ${input.proseHtml ? `<div class="headline prose">${input.proseHtml}</div>` : ''}
  ${section(strings.htmlNeedsYou, followUpRows ? `<table><tbody>${followUpRows}</tbody></table>` : `<p>${escapeHtml(strings.noOpenItems)}</p>`)}
  ${section(strings.htmlProgress, humanSessionRows ? `<table><thead><tr><th>${escapeHtml(strings.columnTask)}</th><th>${escapeHtml(strings.htmlBot)}</th><th>${escapeHtml(strings.columnMessages)}</th></tr></thead><tbody>${humanSessionRows}</tbody></table>` : '')}
  ${section(strings.htmlOwnerTasks, ownerTaskRows ? `<table><thead><tr><th>${escapeHtml(strings.columnTask)}</th><th>${escapeHtml(strings.htmlStatus)}</th><th>${escapeHtml(strings.htmlSteps)}</th><th>${escapeHtml(strings.columnProgress)}</th></tr></thead><tbody>${ownerTaskRows}</tbody></table>` : '')}
  ${section(strings.htmlLongTerm, longTermRows ? `<table><thead><tr><th>${escapeHtml(strings.columnTask)}</th><th>${escapeHtml(strings.htmlStatus)}</th><th>${escapeHtml(strings.columnProgress)}</th></tr></thead><tbody>${longTermRows}</tbody></table>` : '')}
  ${section(strings.htmlMachine, machineItems ? `<ul>${machineItems}</ul>` : '')}
  ${section(strings.htmlOnline, onlineRows ? `<table><thead><tr><th>${escapeHtml(strings.htmlBot)}</th><th>DM</th><th>Group</th></tr></thead><tbody>${onlineRows}</tbody></table>` : '')}
  ${section(strings.htmlDigests, digestRows ? `<table><thead><tr><th>${escapeHtml(strings.htmlBot)}</th><th>Date</th><th>${escapeHtml(strings.columnTask)}</th></tr></thead><tbody>${digestRows}</tbody></table>` : '')}
</div>
</body>
</html>`;
};

// ── Brain prose ────────────────────────────────────────────────────────────

/**
 * Minimal, safe markdown→HTML for the brain's briefing prose: escape FIRST,
 * then lift only the constructs the prompt contract asks for (## headings,
 * `-` bullets, `**bold**`, paragraphs). Anything else renders as plain text.
 */
export const renderDailyReportProseMarkdown = (markdown: string): string => {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let listOpen = false;
  const inline = (escaped: string): string =>
    escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const closeList = () => {
    if (listOpen) {
      html.push('</ul>');
      listOpen = false;
    }
  };
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      continue;
    }
    const heading = /^##+\s+(.*)$/.exec(trimmed);
    if (heading) {
      closeList();
      html.push(`<h2>${inline(escapeHtml(heading[1]))}</h2>`);
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      if (!listOpen) {
        html.push('<ul>');
        listOpen = true;
      }
      html.push(`<li>${inline(escapeHtml(bullet[1]))}</li>`);
      continue;
    }
    closeList();
    html.push(`<p>${inline(escapeHtml(trimmed))}</p>`);
  }
  closeList();
  return html.join('');
};

export const DAILY_REPORT_BRAIN_TIMEOUT_MS = 120_000;
export const DAILY_REPORT_BRAIN_MAX_TOKENS = 1200;

export interface DailyReportBrainOptions {
  llmId: string | null;
  llmProvider?: string | null;
  effort?: string | null;
  fallbackLlmId?: string | null;
  fallbackLlmProvider?: string | null;
  fallbackEffort?: string | null;
}

export type DailyReportPerformChat = (
  systemPrompt: string,
  userMessage: string,
  llmId?: string | null,
  options?: {
    signal?: AbortSignal;
    maxTokens?: number;
    fallbackLlmId?: string | null;
    fallbackLlmProvider?: string | null;
    effort?: string | null;
    fallbackEffort?: string | null;
    llmProvider?: string | null;
    throwOnEmptyContent?: boolean;
    thinking?: 'enabled' | 'disabled';
    webSearch?: boolean;
    attemptTimeoutMs?: number;
  },
) => Promise<string>;

export const buildDailyReportBrainSystemPrompt = (strings: DailyReportStrings): string =>
  `You are the executive assistant of the owner of an IDBots fleet (local AI bots + the Twin bot). `
  + `Write the owner's daily briefing in ${strings.language === 'zh' ? 'Chinese (Simplified)' : 'English'}. `
  + 'Output GitHub-flavored markdown with exactly three parts and nothing else:\n'
  + '1. A `## Headline` section: ONE sentence summarizing the day.\n'
  + '2. A `## Progress` section: at most 7 bullets on progress of work the OWNER started or participated in; '
  + 'include the percent number when the facts give one; mention bot-to-bot/A2A work only when it produced an important result or anomaly.\n'
  + '3. A `## Needs you` section: ONE short paragraph naming the follow-up items that need the owner\'s decision, '
  + 'referring to each item BY ITS TITLE EXACTLY AS GIVEN in the facts. Never invent ids, links, or sessions. '
  + 'If an item is overdue, add one nudge sentence with the suggested action.\n'
  + 'Tone: concise executive assistant. No preamble, no sign-off, no code fences.';

export const buildDailyReportBrainUserMessage = (input: {
  facts: DailyReportFacts;
  strings: DailyReportStrings;
  dateLabel: string;
}): string =>
  `Report date: ${input.dateLabel}\n`
  + `Window (ms since epoch): ${input.facts.windowStartMs} → ${input.facts.windowEndMs}\n`
  + 'Facts (JSON):\n'
  + JSON.stringify(input.facts);

// ── Orchestration ──────────────────────────────────────────────────────────

export interface DailyReportGenerationResult {
  briefingMarkdown: string;
  usedFallback: boolean;
  htmlFilePath: string;
  htmlFileUrl: string;
}

/**
 * Generate the daily report: try the brain once (bounded, 120s wall), on any
 * failure degrade to the deterministic pure-data briefing. Either way the
 * HTML file is written and the returned markdown ends ready for the message
 * (caller appends the file link).
 */
export const generateDailyReport = async (input: {
  facts: DailyReportFacts;
  strings: DailyReportStrings;
  dateLabel: string;
  reportDir: string;
  brain: DailyReportBrainOptions | null;
  performChat: DailyReportPerformChat;
  brainTimeoutMs?: number;
}): Promise<DailyReportGenerationResult> => {
  const { facts, strings, dateLabel } = input;
  const reportDir = input.reportDir;
  fs.mkdirSync(reportDir, { recursive: true });
  const htmlFilePath = path.join(reportDir, `${dateLabel}.html`);

  let headlineText: string | null = null;
  let proseMarkdown: string | null = null;
  let usedFallback = true;

  if (input.brain?.llmId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, input.brainTimeoutMs ?? DAILY_REPORT_BRAIN_TIMEOUT_MS));
    try {
      const prose = await input.performChat(
        buildDailyReportBrainSystemPrompt(strings),
        buildDailyReportBrainUserMessage({ facts, strings, dateLabel }),
        input.brain.llmId,
        {
          signal: controller.signal,
          maxTokens: DAILY_REPORT_BRAIN_MAX_TOKENS,
          llmProvider: input.brain.llmProvider ?? null,
          effort: input.brain.effort ?? null,
          fallbackLlmId: input.brain.fallbackLlmId ?? null,
          fallbackLlmProvider: input.brain.fallbackLlmProvider ?? null,
          fallbackEffort: input.brain.fallbackEffort ?? null,
          attemptTimeoutMs: input.brainTimeoutMs ?? DAILY_REPORT_BRAIN_TIMEOUT_MS,
          thinking: 'disabled',
          webSearch: false,
          throwOnEmptyContent: true,
        },
      );
      const trimmed = prose?.trim();
      if (trimmed) {
        proseMarkdown = trimmed;
        usedFallback = false;
        // Headline = first non-heading, non-empty line of the prose.
        headlineText = trimmed.split('\n').map((line) => line.trim()).find((line) => line && !line.startsWith('#')) ?? null;
      }
    } catch (error) {
      console.warn('[DailyReportGenerator] brain prose failed; using deterministic briefing:', error);
    } finally {
      clearTimeout(timer);
    }
  }

  const deterministic = buildDeterministicBriefing(facts, strings);
  const briefingMarkdown = proseMarkdown
    ? `${proseMarkdown}\n\n${deterministic}`
    : `**${strings.fallbackHeadline}**\n\n${deterministic}`;

  const html = buildDailyReportHtml({
    facts,
    strings,
    dateLabel,
    headlineText,
    // Brain prose rides into the self-contained page through the safe
    // markdown→HTML renderer (escape-first); the deterministic sections
    // escape their own data.
    proseHtml: proseMarkdown ? renderDailyReportProseMarkdown(proseMarkdown) : null,
  });
  fs.writeFileSync(htmlFilePath, html, 'utf8');

  return {
    briefingMarkdown,
    usedFallback,
    htmlFilePath,
    htmlFileUrl: pathToFileURL(htmlFilePath).toString(),
  };
};
