import test from 'node:test';
import assert from 'node:assert/strict';

let buildSelfIdentityBlock;
let buildRecentDailySummariesBlock;
let buildExperiencePromptBlocksXml;
let resolveExperienceRecallQuery;
let formatExperienceRecallResults;
let RECENT_SUMMARIES_MAX_CHARS;
let RECALL_WARM_DAYS;
try {
  ({
    buildSelfIdentityBlock,
    buildRecentDailySummariesBlock,
    buildExperiencePromptBlocksXml,
    resolveExperienceRecallQuery,
    formatExperienceRecallResults,
    RECENT_SUMMARIES_MAX_CHARS,
    RECALL_WARM_DAYS,
  } = await import('../dist-electron/main/libs/experiencePromptBlocks.js'));
} catch {
  ({
    buildSelfIdentityBlock,
    buildRecentDailySummariesBlock,
    buildExperiencePromptBlocksXml,
    resolveExperienceRecallQuery,
    formatExperienceRecallResults,
    RECENT_SUMMARIES_MAX_CHARS,
    RECALL_WARM_DAYS,
  } = await import('../dist-electron/libs/experiencePromptBlocks.js'));
}

test('buildSelfIdentityBlock renders the protected identity block with guidance', () => {
  const block = buildSelfIdentityBlock('我是一个 <专注> 视频创作的 MetaBot & 喜欢先验证');
  assert.ok(block.includes('<metabot_self_identity>'));
  assert.ok(block.includes('&lt;专注&gt;'));
  assert.ok(block.includes('&amp;'));
  assert.ok(!block.includes('<专注>'), 'raw XML must be escaped');
  assert.ok(block.includes('do NOT rewrite or delete it casually'));

  assert.equal(buildSelfIdentityBlock(''), '');
  assert.equal(buildSelfIdentityBlock('   '), '');
});

test('buildRecentDailySummariesBlock keeps newest days and drops oldest over budget', () => {
  const summaries = [
    { summaryDate: '2026-08-03', summaryText: '第三天做了很多事' },
    { summaryDate: '2026-08-02', summaryText: '第二天和用户聊了很久' },
    { summaryDate: '2026-08-01', summaryText: '第一天起步' },
  ];

  const full = buildRecentDailySummariesBlock(summaries);
  assert.ok(full.includes('2026-08-03'));
  assert.ok(full.includes('2026-08-01'));
  assert.ok(full.includes('<recent_daily_summaries>'));
  assert.ok(full.includes('experience_recall'));
  assert.ok(full.includes('做梦'), 'summaries are framed as the bot\'s dreams');

  const tight = buildRecentDailySummariesBlock(summaries, 60);
  assert.ok(tight.includes('2026-08-03'), 'newest survives');
  assert.ok(!tight.includes('2026-08-02'), 'later days dropped over budget');
  assert.ok(!tight.includes('2026-08-01'), 'oldest dropped first');

  assert.equal(buildRecentDailySummariesBlock([]), '');
  assert.equal(buildRecentDailySummariesBlock([{ summaryDate: '2026-08-01', summaryText: '  ' }]), '');

  const totalBudgeted = buildRecentDailySummariesBlock(summaries, RECENT_SUMMARIES_MAX_CHARS);
  assert.ok(totalBudgeted.length < RECENT_SUMMARIES_MAX_CHARS + 400);
});

test('buildExperiencePromptBlocksXml joins non-empty blocks', () => {
  const both = buildExperiencePromptBlocksXml({
    identityText: '我是谁……',
    summaries: [{ summaryDate: '2026-08-03', summaryText: '概要' }],
  });
  assert.ok(both.includes('<metabot_self_identity>'));
  assert.ok(both.includes('<recent_daily_summaries>'));

  const identityOnly = buildExperiencePromptBlocksXml({ identityText: '我是谁……', summaries: [] });
  assert.ok(identityOnly.includes('<metabot_self_identity>'));
  assert.ok(!identityOnly.includes('<recent_daily_summaries>'));

  assert.equal(buildExperiencePromptBlocksXml({ summaries: [] }), '');
});

test('resolveExperienceRecallQuery: bare call is warm, keyword goes cold, dates pass through', () => {
  const today = new Date(2026, 7, 15, 12, 0);

  const warm = resolveExperienceRecallQuery({}, today);
  assert.equal(warm.query, undefined);
  assert.equal(warm.dateFrom, '2026-07-16', `${RECALL_WARM_DAYS} days back`);
  assert.equal(warm.limit, 10);

  const cold = resolveExperienceRecallQuery({ query: '发布计划' }, today);
  assert.equal(cold.query, '发布计划');
  assert.equal(cold.dateFrom, undefined, 'keyword search has no date bound by default');

  const pinned = resolveExperienceRecallQuery({ date_from: '2026-01-01', date_to: '2026-01-31', limit: 99 }, today);
  assert.equal(pinned.dateFrom, '2026-01-01');
  assert.equal(pinned.dateTo, '2026-01-31');
  assert.equal(pinned.limit, 30, 'limit clamped');

  const invalidDate = resolveExperienceRecallQuery({ date_from: 'last week' }, today);
  assert.equal(invalidDate.dateFrom, '2026-07-16', 'invalid date falls back to warm default');
});

test('formatExperienceRecallResults renders entries plus the index hint', () => {
  const text = formatExperienceRecallResults([
    { summaryDate: '2026-08-03', summaryText: '第三天\n做了很多事\n按行分开' },
  ]);
  assert.ok(text.startsWith('2026-08-03: 第三天 做了很多事 按行分开'));
  assert.ok(text.includes('index your full experience records'));

  const empty = formatExperienceRecallResults([]);
  assert.ok(empty.includes('No experience summaries found'));

  const longText = '长'.repeat(1000);
  const truncated = formatExperienceRecallResults([{ summaryDate: '2026-08-03', summaryText: longText }]);
  assert.ok(truncated.includes('…'));
});
