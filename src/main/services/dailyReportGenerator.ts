/**
 * Daily Report (每日汇报) generator — turns the collector's facts into the
 * briefing that lands in the Twin chat and the self-contained HTML report
 * file.
 *
 * Two layers, deliberately split:
 *
 * 1. Deterministic assembler (NEVER delegated to the LLM): the follow-up
 *    list with `[title](idbots://session/<id>)` deep links and overdue
 *    badges (omitted entirely when nothing is pending), the owner-task
 *    table, machine-activity ROLLUPS (counts + named failures only — never
 *    the run-by-run ledger), the per-bot activity rollup table, and the
 *    HTML report. Ids and links are attached here — the brain only ever
 *    sees titles, so it can never invent a wrong link.
 * 2. Brain prose: ONE chat-completion call (dream-style ladder injected by
 *    the service: twin/system brain primary → fallback) writes a
 *    principle-based briefing in the owner's language: big-picture opening
 *    that NAMES the main tasks (real titles, overall %, driver, blockers)
 *    before any detail, progress bullets that say what each task IS, and a
 *    needs-you part only when follow-ups exist. Bounded input (facts JSON),
 *    bounded output (~1200 tokens), 120s wall timeout. On timeout/failure/
 *    no-brain the report degrades to the deterministic sections — the
 *    report always ships.
 *
 * Language: the deterministic strings come from a small zh/en table selected
 * by the UI locale at generation time (default English, Chinese when the
 * locale is zh); the brain prompt itself is locale-native — the zh prompt
 * instructs in Chinese that ALL output must be Simplified Chinese (owner
 * rework 2026-10-23: English headings leaked into a Chinese report).
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
  fleetTitle: string;
  overdueBadge: string;
  waitingDaysSuffix: string;
  ownerTasksIntro: string;
  columnTask: string;
  columnStatus: string;
  columnSteps: string;
  columnProgress: string;
  columnBot: string;
  columnSessions: string;
  columnScheduledRuns: string;
  columnDMs: string;
  columnGroupMessages: string;
  scheduledRunsLabel: string;
  allSucceededLabel: string;
  failedSkippedLabel: string;
  groupTasksRollupLabel: string;
  twinDelegateIntro: string;
  longTermIntro: string;
  stepsDone: string;
  viewFullReport: string;
  fallbackHeadline: string;
  generatedAtLabel: string;
  newSessionsMetaLabel: string;
  htmlNeedsYou: string;
  htmlOwnerTasks: string;
  htmlLongTerm: string;
  htmlBotRollup: string;
  htmlStatus: string;
  htmlSteps: string;
}

export const DAILY_REPORT_STRINGS_EN: DailyReportStrings = {
  language: 'en',
  reportTitle: 'Daily Report',
  windowLabel: 'Window',
  needsYouTitle: 'Needs you',
  fleetTitle: 'Fleet & automation',
  overdueBadge: 'overdue',
  waitingDaysSuffix: 'd waiting',
  ownerTasksIntro: 'Owner-sourced tasks:',
  columnTask: 'Task',
  columnStatus: 'Status',
  columnSteps: 'Steps',
  columnProgress: 'Progress',
  columnBot: 'Bot',
  columnSessions: 'Sessions',
  columnScheduledRuns: 'Runs',
  columnDMs: 'DMs',
  columnGroupMessages: 'Group msgs',
  scheduledRunsLabel: 'Scheduled runs',
  allSucceededLabel: 'all succeeded',
  failedSkippedLabel: 'failed/skipped',
  groupTasksRollupLabel: 'Group task updates',
  twinDelegateIntro: 'Twin-delegated orchestrations touched:',
  longTermIntro: 'Long-term projects:',
  stepsDone: 'steps done',
  viewFullReport: 'View the full report',
  fallbackHeadline: 'Here is your daily briefing.',
  generatedAtLabel: 'Generated',
  newSessionsMetaLabel: 'New sessions',
  htmlNeedsYou: 'Needs you',
  htmlOwnerTasks: 'Owner tasks',
  htmlLongTerm: 'Long-term projects',
  htmlBotRollup: 'Per-bot activity',
  htmlStatus: 'Status',
  htmlSteps: 'Steps',
};

export const DAILY_REPORT_STRINGS_ZH: DailyReportStrings = {
  language: 'zh',
  reportTitle: '每日汇报',
  windowLabel: '统计区间',
  needsYouTitle: '需要你处理',
  fleetTitle: 'Bot 与自动化',
  overdueBadge: '已逾期',
  waitingDaysSuffix: '天待处理',
  ownerTasksIntro: '你发起的任务：',
  columnTask: '任务',
  columnStatus: '状态',
  columnSteps: '步骤',
  columnProgress: '进度',
  columnBot: 'Bot',
  columnSessions: '会话',
  columnScheduledRuns: '定时任务',
  columnDMs: '私信',
  columnGroupMessages: '群消息',
  scheduledRunsLabel: '定时任务',
  allSucceededLabel: '全部成功',
  failedSkippedLabel: '失败/跳过',
  groupTasksRollupLabel: '群任务动态',
  twinDelegateIntro: 'Twin 自动派单触及：',
  longTermIntro: '长期项目：',
  stepsDone: '步已完成',
  viewFullReport: '查看完整报告',
  fallbackHeadline: '这是你的每日简报。',
  generatedAtLabel: '生成时间',
  newSessionsMetaLabel: '新建会话',
  htmlNeedsYou: '需要你处理',
  htmlOwnerTasks: 'Owner 任务',
  htmlLongTerm: '长期项目',
  htmlBotRollup: '各 Bot 活动',
  htmlStatus: '状态',
  htmlSteps: '步骤',
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

/** Run statuses that count as not-succeeded for the rollup naming. */
const isFailedOrSkippedRun = (status: string): boolean =>
  status === 'failed' || status === 'error' || status === 'skipped';

/**
 * Deterministic follow-up list — present ONLY when something actually needs
 * the owner (an empty pending set omits the section entirely, in both the
 * markdown and the HTML). Links are attached here, never by the LLM.
 */
export const buildDailyReportFollowUpListMarkdown = (
  facts: DailyReportFacts,
  strings: DailyReportStrings,
): string => {
  if (facts.pendingFollowUps.length === 0) return '';
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

export interface DailyReportBotRollupRow {
  botName: string;
  sessions: number;
  scheduledRuns: number;
  dms: number;
  groupMessages: number;
}

/**
 * Per-bot activity rollup, computed deterministically from facts the
 * collector already gathers (humanSessions / scheduledRuns / onlineActivity
 * keyed by botName). One row per bot with any activity — the briefing shows
 * this table INSTEAD of digest diaries or session-by-session listings.
 */
export const buildDailyReportBotRollupRows = (facts: DailyReportFacts): DailyReportBotRollupRow[] => {
  const byBot = new Map<string, DailyReportBotRollupRow>();
  const entry = (botName: string | null | undefined): DailyReportBotRollupRow | null => {
    const name = typeof botName === 'string' ? botName.trim() : '';
    if (!name) return null;
    const existing = byBot.get(name);
    if (existing) return existing;
    const row: DailyReportBotRollupRow = { botName: name, sessions: 0, scheduledRuns: 0, dms: 0, groupMessages: 0 };
    byBot.set(name, row);
    return row;
  };
  for (const session of facts.humanSessions) {
    const row = entry(session.botName);
    if (row) row.sessions += 1;
  }
  for (const run of facts.machineActivity.scheduledRuns) {
    const row = entry(run.botName);
    if (row) row.scheduledRuns += 1;
  }
  for (const online of facts.onlineActivity) {
    const row = entry(online.botName);
    if (!row) continue;
    row.dms += online.privateMessageCount;
    row.groupMessages += online.groupMessageCount;
  }
  return [...byBot.values()].sort((a, b) =>
    (b.sessions + b.scheduledRuns + b.dms + b.groupMessages) - (a.sessions + a.scheduledRuns + a.dms + a.groupMessages)
    || a.botName.localeCompare(b.botName));
};

/** Per-bot rollup as a markdown table (bot | sessions | runs | DMs | group). */
export const buildDailyReportBotRollupMarkdown = (
  facts: DailyReportFacts,
  strings: DailyReportStrings,
): string => {
  const rows = buildDailyReportBotRollupRows(facts);
  if (rows.length === 0) return '';
  const header = `| ${strings.columnBot} | ${strings.columnSessions} | ${strings.columnScheduledRuns} | ${strings.columnDMs} | ${strings.columnGroupMessages} |`;
  const divider = '| --- | --- | --- | --- | --- |';
  const lines = rows.map((row) =>
    `| ${markdownTableCell(row.botName)} | ${row.sessions} | ${row.scheduledRuns} | ${row.dms} | ${row.groupMessages} |`);
  return [header, divider, ...lines].join('\n');
};

/**
 * Machine-activity ROLLUPS (owner rework 2026-10-23: no流水账). One summary
 * line for scheduled runs — total count, "all succeeded" when true, and the
 * failed/skipped runs NAMED (max 3, with their bot); one count line for
 * group-task transitions; the twin-delegate count line. Long-term journal
 * events never reach the briefing.
 */
export const buildDailyReportMachineRollupMarkdown = (
  facts: DailyReportFacts,
  strings: DailyReportStrings,
): string[] => {
  const lines: string[] = [];
  const runs = facts.machineActivity.scheduledRuns;
  if (runs.length > 0) {
    const troubled = runs.filter((run) => isFailedOrSkippedRun(run.status)).slice(0, 3);
    let line = `${strings.scheduledRunsLabel} ${runs.length} · `;
    line += troubled.length === 0
      ? strings.allSucceededLabel
      : `${strings.failedSkippedLabel} ${troubled.length}:`;
    lines.push(line);
    for (const run of troubled) {
      const skip = run.skipReason ? ` (${run.skipReason})` : '';
      lines.push(`- ${statusEmoji(run.status)} ${sanitizeMarkdownLinkText(run.taskName)}${run.botName ? ` · ${run.botName}` : ''} — ${run.status}${skip}`);
    }
  }
  if (facts.machineActivity.groupTaskTransitions.length > 0) {
    lines.push(`${strings.groupTasksRollupLabel} ${facts.machineActivity.groupTaskTransitions.length}`);
  }
  if (facts.machineActivity.twinDelegateOrchestrationsInWindow > 0) {
    lines.push(`${strings.twinDelegateIntro} ${facts.machineActivity.twinDelegateOrchestrationsInWindow}`);
  }
  return lines;
};

/**
 * The deterministic briefing — the fallback the report degrades to when the
 * brain is unavailable, and the base the brain prose is spliced into.
 * humanSessions / botDigests / onlineActivity are BRAIN INPUT ONLY: the
 * owner-facing output is the follow-up list (when non-empty), owner-task
 * table, long-term progress, machine rollups, and the per-bot rollup table.
 */
export const buildDeterministicBriefing = (
  facts: DailyReportFacts,
  strings: DailyReportStrings,
): string => {
  const sections: string[] = [];

  const followUps = buildDailyReportFollowUpListMarkdown(facts, strings);
  if (followUps) sections.push(followUps);

  const ownerTasks = buildDailyReportOwnerTasksMarkdown(facts, strings);
  if (ownerTasks) sections.push(ownerTasks);

  if (facts.machineActivity.longTermProgress.length > 0) {
    const lines = facts.machineActivity.longTermProgress.map((task) =>
      `- ${sanitizeMarkdownLinkText(task.title)} — ${task.stage} · ${task.percentComplete}% (${task.subtasksAccepted}/${task.subtasksTotal} ${strings.stepsDone})`,
    );
    sections.push([strings.longTermIntro, ...lines].join('\n'));
  }

  const machineRollups = buildDailyReportMachineRollupMarkdown(facts, strings);
  const botRollup = buildDailyReportBotRollupMarkdown(facts, strings);
  if (machineRollups.length > 0 || botRollup) {
    const fleetParts: string[] = [];
    if (machineRollups.length > 0) fleetParts.push(machineRollups.join('\n'));
    if (botRollup) fleetParts.push(botRollup);
    sections.push(`**${strings.fleetTitle}**\n\n${fleetParts.join('\n\n')}`);
  }

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

  const longTermRows = facts.machineActivity.longTermProgress.map((task) => `<tr>
    <td>${escapeHtml(task.title)}</td>
    <td>${escapeHtml(task.stage)}</td>
    <td>${task.percentComplete}% (${task.subtasksAccepted}/${task.subtasksTotal})</td>
  </tr>`).join('');

  // Machine rollups (same contract as the markdown): summary line + named
  // failures only — never the run-by-run ledger, never journal events.
  const machineRollupItems = buildDailyReportMachineRollupMarkdown(facts, strings)
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join('');

  const botRollupRows = buildDailyReportBotRollupRows(facts).map((row) => `<tr>
    <td>${escapeHtml(row.botName)}</td>
    <td>${row.sessions}</td>
    <td>${row.scheduledRuns}</td>
    <td>${row.dms}</td>
    <td>${row.groupMessages}</td>
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
  <div class="meta">${escapeHtml(strings.windowLabel)}: ${escapeHtml(formatLocalDate(facts.windowStartMs))} → ${escapeHtml(formatLocalDate(facts.windowEndMs))} · ${escapeHtml(strings.generatedAtLabel)}: ${escapeHtml(generatedAt)} · ${escapeHtml(strings.newSessionsMetaLabel)}: ${facts.newSessionCount}</div>
  ${input.headlineText && !input.proseHtml ? `<div class="headline">${escapeHtml(input.headlineText)}</div>` : ''}
  ${input.proseHtml ? `<div class="headline prose">${input.proseHtml}</div>` : ''}
  ${section(strings.htmlNeedsYou, followUpRows ? `<table><tbody>${followUpRows}</tbody></table>` : '')}
  ${section(strings.htmlOwnerTasks, ownerTaskRows ? `<table><thead><tr><th>${escapeHtml(strings.columnTask)}</th><th>${escapeHtml(strings.htmlStatus)}</th><th>${escapeHtml(strings.htmlSteps)}</th><th>${escapeHtml(strings.columnProgress)}</th></tr></thead><tbody>${ownerTaskRows}</tbody></table>` : '')}
  ${section(strings.htmlLongTerm, longTermRows ? `<table><thead><tr><th>${escapeHtml(strings.columnTask)}</th><th>${escapeHtml(strings.htmlStatus)}</th><th>${escapeHtml(strings.columnProgress)}</th></tr></thead><tbody>${longTermRows}</tbody></table>` : '')}
  ${section(strings.fleetTitle, [
      machineRollupItems ? `<ul>${machineRollupItems}</ul>` : '',
      botRollupRows ? `<h2>${escapeHtml(strings.htmlBotRollup)}</h2><table><thead><tr><th>${escapeHtml(strings.columnBot)}</th><th>${escapeHtml(strings.columnSessions)}</th><th>${escapeHtml(strings.columnScheduledRuns)}</th><th>${escapeHtml(strings.columnDMs)}</th><th>${escapeHtml(strings.columnGroupMessages)}</th></tr></thead><tbody>${botRollupRows}</tbody></table>` : '',
    ].filter(Boolean).join(''))}
</div>
</body>
</html>`;
};

// ── Brain prose ────────────────────────────────────────────────────────────

/**
 * Minimal, safe markdown→HTML for the brain's briefing prose: escape FIRST,
 * then lift only the constructs the prompt asks for (## headings, `-`
 * bullets, `**bold**`, paragraphs). Anything else renders as plain text.
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

const DAILY_REPORT_BRAIN_PROMPT_ZH =
  '你是 IDBots 团队（本地 AI Bot 群 + Twin Bot）负责人的执行助理，正在呈交每日简报。\n'
  + '受众只有负责人本人：他们只关心自己发起的工作、等待他们拍板的事项、以及真正重要的异常。'
  + '绝对不要叙述 Bot 之间的 A2A 琐事、例行定时任务执行、或每个 Bot 的日记式流水。\n'
  + '输出要求：使用与用户界面一致的语言撰写（当前界面语言为中文），任务标题等专有名词保持原文；GitHub 风格 markdown；不要使用代码块；不要输出任何链接、id 或会话号；篇幅约 150–250 字。\n'
  + '内容原则（结构仅为建议，不设固定章节标题）：\n'
  + '1. 开头 1–3 句平铺直叙的整体态势：点名主要任务的正式名称，给出可推导的整体进度百分比、由谁负责、是否有阻塞；先讲大局，再讲细节；不要只报抽象汇总数字而不点名任务。\n'
  + '2. 若干条进展要点：每条先说明任务是什么，再讲现状、结果或百分比、负责方、阻塞。\n'
  + '3. 仅当 facts 中存在待跟进事项时，才写需要你处理的部分：使用事项的确切标题；逾期项附一句提醒和建议动作。\n'
  + '4. 可选：以一条具体建议收尾。\n'
  + '严禁编造 id、链接或会话；严禁罗列原始会话日志。';

const DAILY_REPORT_BRAIN_PROMPT_EN =
  'You are the executive assistant to the owner of an IDBots fleet (local AI bots + the Twin bot), delivering the daily briefing.\n'
  + 'The audience is the owner only: they care about work THEY initiated, decisions waiting on them, and genuinely important anomalies. '
  + 'Never narrate bot-to-bot A2A plumbing, routine scheduled-run execution, or per-bot diaries.\n'
  + 'Output requirements: write in the same language as the user\'s UI (currently English), keeping task titles and other proper nouns verbatim; GitHub-flavored markdown; no code fences; no links, ids, or session references; about 120–180 words.\n'
  + 'Content principles (structure is a suggestion, not fixed headings):\n'
  + '1. Open with 1–3 plain-language sentences on the overall state: name the actual main tasks by their real titles, give overall progress % where derivable, who is driving each, and any blocker. Big picture before details — no abstract aggregates without naming the task.\n'
  + '2. A few progress bullets: each says what the task IS first, then where it stands, the outcome/%, who drives it, and any blocker.\n'
  + '3. A needs-you part ONLY when follow-ups exist in the facts: use each item\'s exact title; overdue items get a one-sentence nudge with a suggested action.\n'
  + '4. Optionally end with one concrete suggestion.\n'
  + 'Never invent ids or links; never list raw session logs.';

/**
 * Locale-native, principle-based briefing contract (owner rework 2026-10-23:
 * the old template mandated English section names that leaked into Chinese
 * reports). Each locale's prompt is written in that language and requires the
 * output to follow the USER'S UI language — no hardcoded variant like
 * "Simplified Chinese", so Traditional-Chinese and future locales stay correct.
 * No mandated section names.
 */
export const buildDailyReportBrainSystemPrompt = (strings: DailyReportStrings): string =>
  strings.language === 'zh' ? DAILY_REPORT_BRAIN_PROMPT_ZH : DAILY_REPORT_BRAIN_PROMPT_EN;

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
