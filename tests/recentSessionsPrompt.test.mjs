// Recent-sessions pulse: builder unit tests (compiled dist-electron) plus
// static wiring anchors for the volatile-tail injection. The pulse gives a
// cowork bot ambient awareness of its own other recent conversations —
// format/budget/exclusion behavior is contract, so pin it here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const {
  buildRecentSessionsPromptBlock,
  formatRecentSessionAge,
  RECENT_SESSIONS_BLOCK_MAX_CHARS,
  RECENT_SESSIONS_SNIPPET_MAX_CHARS,
  RECENT_SESSIONS_PROMPT_LIMIT,
} = await import('../dist-electron/main/libs/recentSessionsPrompt.js');

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);

const entry = (overrides = {}) => ({
  sessionId: '948ca88c-1f68-4a50-bb6d-01bc1fe27de5',
  title: 'ACR 凭据',
  activityAt: NOW - 3 * 3600_000,
  human: '好像不是给了给你容器镜像服务的密码吗',
  assistant: '已配置完成，CI 推镜像已通过',
  ...overrides,
});

test('renders a digest line per session with link, age, title, and both snippets', () => {
  const block = buildRecentSessionsPromptBlock([entry()], NOW);
  assert.match(block, /^<recent_sessions>\n/);
  assert.match(block, /\n<\/recent_sessions>$/);
  assert.match(block, /\(3h ago\) IDBots:\/\/948ca88c-1f68-4a50-bb6d-01bc1fe27de5 "ACR 凭据"/);
  assert.match(block, /owner: 好像不是给了给你容器镜像服务的密码吗/);
  assert.match(block, /you: 已配置完成，CI 推镜像已通过/);
  assert.match(block, /cross-check here first/);
});

test('empty input, empty sessions, and snippet-less sessions render nothing', () => {
  assert.equal(buildRecentSessionsPromptBlock([], NOW), '');
  assert.equal(buildRecentSessionsPromptBlock(undefined, NOW), '');
  const silent = entry({ human: '', assistant: '' });
  assert.equal(buildRecentSessionsPromptBlock([silent], NOW), '');
});

test('snippets and titles are trimmed to budget, whitespace-collapsed, and xml-escaped', () => {
  const block = buildRecentSessionsPromptBlock([
    entry({
      title: '<长标题 & 溢出>'.repeat(6),
      human: `${'甲'.repeat(500)}\n\n乙   丙`,
    })], NOW);
  const line = block.split('\n').find((l) => l.startsWith('- ('));
  const titlePart = line.slice(line.indexOf('"'), line.indexOf('"', line.indexOf('"') + 1) + 1);
  assert.ok(titlePart.length <= RECENT_SESSIONS_SNIPPET_MAX_CHARS + 2);
  assert.ok(!titlePart.includes('<长'));
  assert.match(titlePart, /&lt;/);
  assert.match(titlePart, /&amp;/);
  const ownerPart = line.slice(line.indexOf('owner: '), line.indexOf(' | you: '));
  assert.ok(ownerPart.length <= 'owner: '.length + RECENT_SESSIONS_SNIPPET_MAX_CHARS);
  assert.ok(!ownerPart.includes('\n'));
  assert.ok(ownerPart.includes('甲'));
  assert.ok(!ownerPart.includes('乙'));
});

test('lone surrogates never survive into the rendered block', () => {
  const block = buildRecentSessionsPromptBlock([
    entry({ title: '坏 surrogate \ud83c', human: 'half pair \udfff' }),
  ], NOW);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(block));
});

test('block stays within its char cap and prefers the newest sessions', () => {
  const entries = Array.from({ length: 12 }, (_, i) =>
    entry({
      sessionId: `session-${String(i).padStart(2, '0')}`,
      title: `任务 ${'X'.repeat(20)} ${i}`,
      activityAt: NOW - (i + 1) * 3600_000,
      human: '人'.repeat(80),
      assistant: '答'.repeat(80),
    }));
  const block = buildRecentSessionsPromptBlock(entries, NOW);
  assert.ok(block.length <= RECENT_SESSIONS_BLOCK_MAX_CHARS + 8);
  // Newest first: session-00 (1h ago) must be present, the oldest must drop
  // off once the cap forces a choice.
  assert.match(block, /IDBots:\/\/session-00 /);
  assert.doesNotMatch(block, /IDBots:\/\/session-11 /);
});

test('relative age formatting buckets', () => {
  assert.equal(formatRecentSessionAge(NOW - 60_000, NOW), 'just now');
  assert.equal(formatRecentSessionAge(NOW - 5 * 60_000, NOW), '5m ago');
  assert.equal(formatRecentSessionAge(NOW - 3 * 3600_000, NOW), '3h ago');
  assert.equal(formatRecentSessionAge(NOW - 30 * 86_400_000, NOW), '30d ago');
});

// --- Static wiring anchors -------------------------------------------------

const readSource = (rel) => readFileSync(join(repoRoot, rel), 'utf8');

test('wiring: cowork volatile tail carries the recent-sessions section behind the memory gate', () => {
  const source = readSource('src/main/libs/coworkRunner.ts');
  assert.match(source, /key: 'recent-sessions'/);
  assert.match(source, /this\.buildRecentSessionsPromptBlockXml\(sessionId\)/);
  assert.match(source, /RECENT_SESSIONS_PROMPT_LIMIT/);
});

test('wiring: memory strategy tells the bot to cross-check the digest before asking the owner', () => {
  const source = readSource('src/main/libs/coworkRunner.ts');
  assert.match(source, /<recent_sessions> digest rides the turn/);
  assert.match(source, /cross-check the digest first/);
});

test('wiring: store pulse query is metabot-scoped and follows session-list visibility rules', () => {
  const source = readSource('src/main/coworkStore.ts');
  assert.match(source, /recentSessionPulse\(/);
  assert.match(source, /COALESCE\(s\.hidden_from_session_list, 0\) = 0/);
  assert.match(source, /s\.archived_at IS NULL/);
  assert.match(source, /episode\.next_session_id IS NOT NULL/);
});

test('wiring: the pulse is deliberately NOT a cerebellum-gated block (ambient by design)', () => {
  const source = readSource('src/main/cerebellum/volatileBlockGate.ts');
  assert.ok(!source.includes("'recent-sessions'"));
  assert.ok(RECENT_SESSIONS_PROMPT_LIMIT >= 6);
});
