// src/main/services/dailyReportGenerator.ts — briefing + HTML report builder.
//
// Contract under test (no LLM in tests):
//   a. deterministic assembler — follow-up list ALWAYS carries
//      `[title](idbots://session/<id>)` links and overdue badges; the
//      owner-task table carries step counts / percent; never the LLM's job;
//   b. strings — zh/en table selection by locale prefix, default English;
//   c. prose renderer — escape-first markdown→HTML (headings/bullets/bold);
//   d. HTML report — self-contained, data escaped, deep links preserved;
//   e. generateDailyReport — no brain / failing brain → deterministic
//      fallback ships; brain prose is spliced in when it returns text; the
//      HTML file lands at <reportDir>/<YYYY-MM-DD>.html and the file:// URL
//      comes back for the message link.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildDailyReportFollowUpListMarkdown,
  buildDailyReportOwnerTasksMarkdown,
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

test('follow-up list: empty window says so', () => {
  const markdown = buildDailyReportFollowUpListMarkdown(
    sampleFacts({ pendingFollowUps: [] }),
    DAILY_REPORT_STRINGS_EN,
  );
  assert.match(markdown, /Nothing is waiting/);
});

test('owner-task table: steps + percent + pipe escaping', () => {
  const markdown = buildDailyReportOwnerTasksMarkdown(sampleFacts(), DAILY_REPORT_STRINGS_EN);
  assert.match(markdown, /\| Task \| Status \| Steps \| Progress \|/);
  assert.match(markdown, /Build landing \\| page \| running \| 2\/4 \| 50% \|/);
});

test('deterministic briefing: every section present and linked', () => {
  const markdown = buildDeterministicBriefing(sampleFacts(), DAILY_REPORT_STRINGS_ZH);
  assert.match(markdown, /需要你处理/);
  assert.match(markdown, /idbots:\/\/session\/sess-1/);
  assert.match(markdown, /你的工作进展|你发起的任务/);
  assert.match(markdown, /Bot 与自动化动态|定时任务/);
  assert.match(markdown, /Inspected 12 hosts\./);
  assert.match(markdown, /新建会话： 5/);
});

// ---------------------------------------------------------------------------
// Prose renderer (escape-first)
// ---------------------------------------------------------------------------

test('renderDailyReportProseMarkdown: escape-first, lifts headings/bullets/bold only', () => {
  const html = renderDailyReportProseMarkdown(
    '## Headline\n**Bold** <script>alert(1)</script>\n- first **item**\n- [click](javascript:evil)\nplain',
  );
  assert.match(html, /<h2>Headline<\/h2>/);
  assert.match(html, /<strong>Bold<\/strong> &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<li>first <strong>item<\/strong><\/li>/);
  assert.match(html, /\[click\]\(javascript:evil\)/, 'link text inert — escaped, not an anchor');
  assert.match(html, /<p>plain<\/p>/);
  assert.ok(!html.includes('<script>alert'));
});

// ---------------------------------------------------------------------------
// HTML report
// ---------------------------------------------------------------------------

test('buildDailyReportHtml: self-contained, data escaped, deep links preserved', () => {
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
  assert.match(html, /Q4 roadmap/, 'long-term progress table');
  assert.match(html, /Inspected 12 hosts\./);
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
      return '## Headline\nA calm day.\n\n## Progress\n- **Landing page** hit 50%.\n\n## Needs you\n"Approve deploy plan" is waiting.';
    },
  });
  assert.equal(result.usedFallback, false);
  assert.equal(seen.llmId, 'glm-test');
  assert.equal(seen.options.fallbackLlmId, 'glm-backup', 'brain ladder rides primary→fallback');
  assert.equal(seen.options.webSearch, false);
  assert.match(seen.systemPrompt, /daily briefing/);
  assert.match(seen.userMessage, /"sessionId":"sess-1"/);
  assert.match(result.briefingMarkdown, /A calm day\./, 'prose first');
  assert.match(result.briefingMarkdown, /\[Approve deploy plan\]\(idbots:\/\/session\/sess-1\)/, 'deterministic links still attached');
  const html = fs.readFileSync(result.htmlFilePath, 'utf8');
  assert.match(html, /Landing page<\/strong> hit 50%/, 'brain prose embedded in HTML');
  fs.rmSync(reportDir, { recursive: true, force: true });
});
