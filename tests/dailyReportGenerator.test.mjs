// src/main/services/dailyReportGenerator.ts — briefing + HTML report builder.
//
// Contract under test (no LLM in tests), owner rework 2026-10-23:
//   a. follow-up list — `[title](idbots://session/<id>)` links + overdue
//      badges; the section is OMITTED ENTIRELY when pendingFollowUps is
//      empty (markdown + HTML), never an empty-state line;
//   b. owner-task table — step counts / percent, never the LLM's job;
//   c. machine rollups — one scheduled-runs summary line (total; "all
//      succeeded" when true; only failed/skipped NAMED, max 3, with bot),
//      one group-task count line, twin-delegate count; long-term journal
//      events never appear;
//   d. per-bot rollup — one table row per bot with any activity (sessions /
//      runs / DMs / group msgs) computed from existing facts; digest TEXT
//      never reaches markdown or HTML (brain input only); the
//      humanSessions listing is gone from both;
//   e. brain prompt — locale-native (zh prompt is Chinese and demands
//      Simplified Chinese output), principle-based, NO mandated section
//      names (no "## Headline" template);
//   f. prose renderer — escape-first markdown→HTML (headings/bullets/bold);
//   g. HTML — self-contained, data escaped, deep links preserved, new-
//      session count only in the meta line;
//   h. generateDailyReport — no brain / failing brain → deterministic
//      fallback ships; brain prose splices in and embeds in the HTML.
//
// The pure module is loaded straight from src/ (Node type stripping); there
// are no runtime relative imports in this test file.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildDailyReportBotRollupMarkdown,
  buildDailyReportBotRollupRows,
  buildDailyReportFollowUpListMarkdown,
  buildDailyReportMachineRollupMarkdown,
  buildDailyReportOwnerTasksMarkdown,
  buildDailyReportBrainSystemPrompt,
  buildDeterministicBriefing,
  buildDailyReportHtml,
  generateDailyReport,
  renderDailyReportProseMarkdown,
  resolveDailyReportStrings,
  DAILY_REPORT_STRINGS_EN,
  DAILY_REPORT_STRINGS_ZH,
} from '../src/main/services/dailyReportGenerator.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

const sampleFacts = (overrides = {}) => ({
  generatedAtMs: Date.now(),
  windowStartMs: Date.now() - DAY_MS,
  windowEndMs: Date.now(),
  pendingFollowUps: [
    { sessionId: 'sess-1', title: 'Approve deploy plan', botName: 'Twin', source: 'cerebellum', ageDays: 3, overdue: true },
    { sessionId: 'sess-2', title: 'Pick a color <script>', botName: null, source: 'ask_user', ageDays: 0, overdue: false },
  ],
  ownerOrchestrations: [
    { taskId: 'ot1', title: 'Build landing | page', status: 'running', stepsDone: 2, stepsTotal: 4, percentComplete: 50, workerSessionIds: ['ws1'], updatedAt: null },
  ],
  humanSessions: [
    { sessionId: 'hs1', title: 'Landing copy', botName: 'Writer', sessionType: 'standard', humanUserMessages: 3, assistantMessages: 5, lastAssistantExcerpt: 'Draft ready', lastUserExcerpt: 'go' },
  ],
  machineActivity: {
    scheduledRuns: [{ taskName: 'Nightly inspect', botName: 'Ops', status: 'success', skipReason: null, startedAt: null, error: null }],
    groupTaskTransitions: [{ taskId: 9, title: 'Group push', fromStatus: 'executing', toStatus: 'review', actor: 'chair', reason: null, createdAt: null }],
    longTermEvents: [{ taskId: 'lt1', taskTitle: 'Q4 roadmap', subtaskId: null, kind: 'stage_changed', actor: 'twin', detail: 'active', createdAt: null }],
    longTermProgress: [{ taskId: 'lt1', title: 'Q4 roadmap', stage: 'active', subtasksAccepted: 1, subtasksTotal: 4, percentComplete: 25 }],
    twinDelegateOrchestrationsInWindow: 2,
  },
  botDigests: [{ botName: 'Ops', isTwin: false, summaryDate: '2026-10-21', summaryText: 'Inspected 12 hosts.' }],
  onlineActivity: [{ botName: 'Ops', privateMessageCount: 4, groupMessageCount: 1 }],
  newSessionCount: 5,
  hasAnyActivity: true,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

test('resolveDailyReportStrings: zh prefix → Chinese, default English', () => {
  assert.equal(resolveDailyReportStrings('zh').language, 'zh');
  assert.equal(resolveDailyReportStrings('zh-CN').language, 'zh');
  assert.equal(resolveDailyReportStrings('en').language, 'en');
  assert.equal(resolveDailyReportStrings(null).language, 'en');
  assert.equal(resolveDailyReportStrings('fr').language, 'en');
  assert.notEqual(DAILY_REPORT_STRINGS_ZH.reportTitle, DAILY_REPORT_STRINGS_EN.reportTitle);
});

// ---------------------------------------------------------------------------
// Deterministic assembler
// ---------------------------------------------------------------------------

test('follow-up list: deep links + overdue badges, never LLM output', () => {
  const markdown = buildDailyReportFollowUpListMarkdown(sampleFacts(), DAILY_REPORT_STRINGS_EN);
  assert.match(markdown, /\[Approve deploy plan\]\(idbots:\/\/session\/sess-1\)/);
  assert.match(markdown, /\[Pick a color <script>\]\(idbots:\/\/session\/sess-2\)/, 'raw title kept as link text data');
  assert.match(markdown, /overdue/);
  assert.match(markdown, /3d waiting/);
});

test('follow-up list: empty pending set → section omitted entirely (no empty-state line)', () => {
  const markdown = buildDailyReportFollowUpListMarkdown(
    sampleFacts({ pendingFollowUps: [] }),
    DAILY_REPORT_STRINGS_EN,
  );
  assert.equal(markdown, '');
  assert.doesNotMatch(markdown, /Nothing is waiting/);
  const zh = buildDailyReportFollowUpListMarkdown(
    sampleFacts({ pendingFollowUps: [] }),
    DAILY_REPORT_STRINGS_ZH,
  );
  assert.equal(zh, '');
});

test('owner-task table: steps + percent + pipe escaping', () => {
  const markdown = buildDailyReportOwnerTasksMarkdown(sampleFacts(), DAILY_REPORT_STRINGS_EN);
  assert.match(markdown, /\| Task \| Status \| Steps \| Progress \|/);
  assert.match(markdown, /Build landing \\| page \| running \| 2\/4 \| 50% \|/);
});

test('machine rollups: all-succeeded line, count lines, no journal events', () => {
  const lines = buildDailyReportMachineRollupMarkdown(sampleFacts(), DAILY_REPORT_STRINGS_EN);
  assert.deepEqual(lines, [
    'Scheduled runs 1 · all succeeded',
    'Group task updates 1',
    'Twin-delegated orchestrations touched: 2',
  ]);
  const joined = lines.join('\n');
  assert.doesNotMatch(joined, /stage_changed/, 'long-term journal events never reach the briefing');
  assert.doesNotMatch(joined, /Nightly inspect/, 'successful runs are not named one by one');
});

test('machine rollups: failed/skipped runs named (max 3) with bot; success still counted', () => {
  const facts = sampleFacts({
    machineActivity: {
      ...sampleFacts().machineActivity,
      scheduledRuns: [
        { taskName: 'Nightly inspect', botName: 'Ops', status: 'success', skipReason: null, startedAt: null, error: null },
        { taskName: 'Backup check', botName: 'Ops', status: 'failed', skipReason: null, startedAt: null, error: 'disk full' },
        { taskName: 'Site patrol', botName: 'Guard', status: 'skipped', skipReason: 'already_running', startedAt: null, error: null },
        { taskName: 'Feed fetch', botName: 'Scout', status: 'error', skipReason: null, startedAt: null, error: 'timeout' },
        { taskName: 'Fifth failure', botName: 'Ops', status: 'failed', skipReason: null, startedAt: null, error: 'x' },
        { taskName: 'Sixth failure', botName: 'Ops', status: 'failed', skipReason: null, startedAt: null, error: 'x' },
      ],
    },
  });
  const lines = buildDailyReportMachineRollupMarkdown(facts, DAILY_REPORT_STRINGS_EN);
  assert.match(lines[0], /^Scheduled runs 6 · failed\/skipped 3:/);
  const named = lines.slice(1).filter((l) => l.startsWith('- '));
  assert.equal(named.length, 3, 'at most 3 failed/skipped runs are named');
  assert.match(named.join('\n'), /Backup check · Ops — failed/);
  assert.match(named.join('\n'), /Site patrol · Guard — skipped \(already_running\)/);
  assert.match(named.join('\n'), /Feed fetch/);
  assert.doesNotMatch(named.join('\n'), /Sixth failure/, 'failures beyond the cap are not named');
  assert.doesNotMatch(named.join('\n'), /Nightly inspect/, 'successful runs stay unnamed');
});

test('bot rollup rows: computed from humanSessions / scheduledRuns / onlineActivity by botName', () => {
  const rows = buildDailyReportBotRollupRows(sampleFacts());
  const byBot = new Map(rows.map((row) => [row.botName, row]));
  assert.deepEqual(byBot.get('Ops'), { botName: 'Ops', sessions: 0, scheduledRuns: 1, dms: 4, groupMessages: 1 });
  assert.deepEqual(byBot.get('Writer'), { botName: 'Writer', sessions: 1, scheduledRuns: 0, dms: 0, groupMessages: 0 });
});

test('bot rollup markdown: one table, digest text absent', () => {
  const markdown = buildDailyReportBotRollupMarkdown(sampleFacts(), DAILY_REPORT_STRINGS_ZH);
  assert.match(markdown, /\| Bot \| 会话 \| 定时任务 \| 私信 \| 群消息 \|/);
  assert.match(markdown, /\| Ops \| 0 \| 1 \| 4 \| 1 \|/);
  assert.match(markdown, /\| Writer \| 1 \| 0 \| 0 \| 0 \|/);
  assert.doesNotMatch(markdown, /Inspected 12 hosts/, 'digest diary never reaches the table');
});

test('deterministic briefing: follow-ups + owner tasks + rollups; no流水账 sections', () => {
  const markdown = buildDeterministicBriefing(sampleFacts(), DAILY_REPORT_STRINGS_ZH);
  assert.match(markdown, /需要你处理/);
  assert.match(markdown, /idbots:\/\/session\/sess-1/);
  assert.match(markdown, /你发起的任务：/);
  assert.match(markdown, /长期项目：/);
  assert.match(markdown, /Bot 与自动化/);
  assert.match(markdown, /定时任务 1 · 全部成功/);
  assert.match(markdown, /群任务动态 1/);
  assert.match(markdown, /Twin 自动派单触及： 2/);
  assert.match(markdown, /\| Bot \| 会话 \| 定时任务 \| 私信 \| 群消息 \|/);
  // Owner rework: these listings are gone from the owner-facing briefing.
  assert.doesNotMatch(markdown, /Landing copy/, 'humanSessions listing removed (brain input only)');
  assert.doesNotMatch(markdown, /Inspected 12 hosts/, 'digest diary removed (brain input only)');
  assert.doesNotMatch(markdown, /新建会话/, 'new-session count dropped from the chat message');
  assert.doesNotMatch(markdown, /stage_changed/, 'long-term journal events removed');
});

test('deterministic briefing: empty follow-ups → no needs-you section, rest intact', () => {
  const markdown = buildDeterministicBriefing(
    sampleFacts({ pendingFollowUps: [] }),
    DAILY_REPORT_STRINGS_EN,
  );
  assert.doesNotMatch(markdown, /Needs you/);
  assert.doesNotMatch(markdown, /Nothing is waiting/, 'no empty-state line');
  assert.match(markdown, /Owner-sourced tasks:/, 'other sections still ship');
  assert.match(markdown, /Scheduled runs 1 · all succeeded/);
});

// ---------------------------------------------------------------------------
// Brain prompt (locale-native, principle-based)
// ---------------------------------------------------------------------------

test('brain prompt: zh is locale-native and mandates Simplified Chinese output', () => {
  const prompt = buildDailyReportBrainSystemPrompt(DAILY_REPORT_STRINGS_ZH);
  assert.match(prompt, /执行助理/);
  assert.match(prompt, /全部使用简体中文/);
  assert.match(prompt, /不设固定章节标题/);
  assert.doesNotMatch(prompt, /## Headline/, 'no mandated English section names');
  assert.doesNotMatch(prompt, /## Progress/);
  assert.doesNotMatch(prompt, /## Needs you/);
});

test('brain prompt: en mirrors the principles without fixed headings', () => {
  const prompt = buildDailyReportBrainSystemPrompt(DAILY_REPORT_STRINGS_EN);
  assert.match(prompt, /executive assistant/i);
  assert.match(prompt, /write entirely in English/i);
  assert.match(prompt, /not fixed headings/i);
  assert.match(prompt, /real titles/);
  assert.doesNotMatch(prompt, /## Headline/);
  assert.doesNotMatch(prompt, /## Progress/);
  assert.doesNotMatch(prompt, /## Needs you/);
});

// ---------------------------------------------------------------------------
// Prose renderer (escape-first)
// ---------------------------------------------------------------------------

test('renderDailyReportProseMarkdown: escape-first, lifts headings/bullets/bold only', () => {
  const html = renderDailyReportProseMarkdown(
    '## 今日态势\n**Bold** <script>alert(1)</script>\n- first **item**\n- [click](javascript:evil)\nplain',
  );
  assert.match(html, /<h2>今日态势<\/h2>/);
  assert.match(html, /<strong>Bold<\/strong> &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<li>first <strong>item<\/strong><\/li>/);
  assert.match(html, /\[click\]\(javascript:evil\)/, 'link text inert — escaped, not an anchor');
  assert.match(html, /<p>plain<\/p>/);
  assert.ok(!html.includes('<script>alert'));
});

// ---------------------------------------------------------------------------
// HTML report
// ---------------------------------------------------------------------------

test('buildDailyReportHtml: rollups + per-bot table, diary/listings removed', () => {
  const html = buildDailyReportHtml({
    facts: sampleFacts(),
    strings: DAILY_REPORT_STRINGS_EN,
    dateLabel: '2026-10-22',
    proseHtml: '<p>brain <strong>prose</strong></p>',
  });
  assert.match(html, /<title>Daily Report 2026-10-22<\/title>/);
  assert.match(html, /brain <strong>prose<\/strong>/, 'brain prose embedded');
  assert.match(html, /href="idbots:\/\/session\/sess-1"/);
  assert.match(html, /Pick a color &lt;script&gt;/, 'title escaped');
  assert.ok(!html.includes('<script>alert'));
  assert.match(html, /Scheduled runs 1 · all succeeded/);
  assert.match(html, /Per-bot activity/);
  assert.match(html, /<td>Ops<\/td>\s*<td>0<\/td>\s*<td>1<\/td>\s*<td>4<\/td>\s*<td>1<\/td>/);
  assert.match(html, /New sessions: 5/, 'session count kept in the meta line');
  // Owner rework removals.
  assert.doesNotMatch(html, /Inspected 12 hosts/, 'digest table removed from HTML');
  assert.doesNotMatch(html, /Landing copy/, 'human-session table removed from HTML');
  assert.doesNotMatch(html, /stage_changed/, 'machine item list removed from HTML');
});

test('buildDailyReportHtml: empty follow-ups → no needs-you section at all', () => {
  const html = buildDailyReportHtml({
    facts: sampleFacts({ pendingFollowUps: [] }),
    strings: DAILY_REPORT_STRINGS_EN,
    dateLabel: '2026-10-22',
  });
  assert.doesNotMatch(html, /Needs you/);
  assert.doesNotMatch(html, /Nothing is waiting/);
  assert.match(html, /Owner tasks/, 'other sections still render');
});

// ---------------------------------------------------------------------------
// generateDailyReport end-to-end (no real LLM)
// ---------------------------------------------------------------------------

test('generateDailyReport: no brain → deterministic fallback ships + HTML written', async () => {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-test-'));
  const result = await generateDailyReport({
    facts: sampleFacts(),
    strings: DAILY_REPORT_STRINGS_EN,
    dateLabel: '2026-10-22',
    reportDir,
    brain: null,
    performChat: async () => { throw new Error('must not be called'); },
  });
  assert.equal(result.usedFallback, true);
  assert.match(result.briefingMarkdown, /Here is your daily briefing\./);
  assert.match(result.briefingMarkdown, /idbots:\/\/session\/sess-1/);
  assert.match(result.briefingMarkdown, /Scheduled runs 1 · all succeeded/);
  assert.doesNotMatch(result.briefingMarkdown, /Inspected 12 hosts/);
  assert.equal(path.basename(result.htmlFilePath), '2026-10-22.html');
  assert.ok(fs.existsSync(result.htmlFilePath), 'HTML file written');
  assert.match(result.htmlFileUrl, /^file:\/\//);
  const html = fs.readFileSync(result.htmlFilePath, 'utf8');
  assert.match(html, /Approve deploy plan/);
  fs.rmSync(reportDir, { recursive: true, force: true });
});

test('generateDailyReport: failing brain degrades to fallback (report never goes missing)', async () => {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-test-'));
  const result = await generateDailyReport({
    facts: sampleFacts(),
    strings: DAILY_REPORT_STRINGS_EN,
    dateLabel: '2026-10-22',
    reportDir,
    brain: { llmId: 'glm-test' },
    performChat: async () => { throw new Error('LLM request failed: 429 slow down'); },
  });
  assert.equal(result.usedFallback, true);
  assert.match(result.briefingMarkdown, /idbots:\/\/session\/sess-1/);
  assert.ok(fs.existsSync(result.htmlFilePath));
  fs.rmSync(reportDir, { recursive: true, force: true });
});

test('generateDailyReport: brain prose is spliced in and embedded in the HTML', async () => {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-test-'));
  let seen = null;
  const result = await generateDailyReport({
    facts: sampleFacts(),
    strings: DAILY_REPORT_STRINGS_EN,
    dateLabel: '2026-10-22',
    reportDir,
    brain: { llmId: 'glm-test', fallbackLlmId: 'glm-backup' },
    performChat: async (systemPrompt, userMessage, llmId, options) => {
      seen = { systemPrompt, userMessage, llmId, options };
      return 'A calm day overall: "Build landing page" is halfway there on Writer, nothing is blocked.\n\n- **Build landing page** — 2/4 steps done (50%), driven by Writer.\n\n"Approve deploy plan" is waiting on you; it is 3 days old — suggest confirming the rollout window.';
    },
  });
  assert.equal(result.usedFallback, false);
  assert.equal(seen.llmId, 'glm-test');
  assert.equal(seen.options.fallbackLlmId, 'glm-backup', 'brain ladder rides primary→fallback');
  assert.equal(seen.options.webSearch, false);
  assert.match(seen.systemPrompt, /daily briefing/);
  assert.match(seen.userMessage, /"sessionId":"sess-1"/);
  assert.match(result.briefingMarkdown, /A calm day overall/, 'prose first');
  assert.match(result.briefingMarkdown, /\[Approve deploy plan\]\(idbots:\/\/session\/sess-1\)/, 'deterministic links still attached');
  const html = fs.readFileSync(result.htmlFilePath, 'utf8');
  assert.match(html, /<strong>Build landing page<\/strong>/, 'brain prose embedded in HTML');
  fs.rmSync(reportDir, { recursive: true, force: true });
});

test('generateDailyReport: zh locale keeps the Chinese prompt and Chinese fallback', async () => {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-report-test-'));
  let seen = null;
  const result = await generateDailyReport({
    facts: sampleFacts({ pendingFollowUps: [] }),
    strings: DAILY_REPORT_STRINGS_ZH,
    dateLabel: '2026-10-22',
    reportDir,
    brain: { llmId: 'glm-test' },
    performChat: async (systemPrompt) => {
      seen = systemPrompt;
      return '今天整体平稳："Build landing page" 由 Writer 推进到 50%，没有阻塞，也没有待拍板的事项。';
    },
  });
  assert.match(seen, /全部使用简体中文/);
  assert.equal(result.usedFallback, false);
  assert.match(result.briefingMarkdown, /今天整体平稳/);
  assert.doesNotMatch(result.briefingMarkdown, /需要你处理/, 'needs-you header absent when no follow-ups');
  assert.doesNotMatch(result.briefingMarkdown, /当前没有等待你处理的事项/, 'no empty-state line');
  fs.rmSync(reportDir, { recursive: true, force: true });
});
