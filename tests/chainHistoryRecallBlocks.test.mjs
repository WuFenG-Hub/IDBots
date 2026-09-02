import test from 'node:test';
import assert from 'node:assert/strict';

const {
  resolveChainHistoryRecallQuery,
  formatChainHistoryRecallResults,
  DEFAULT_CHAIN_HISTORY_RECALL_LIMIT,
  MAX_CHAIN_HISTORY_RECALL_LIMIT,
} = await import('../dist-electron/main/libs/chainHistoryRecallBlocks.js')
  .catch(() => import('../dist-electron/libs/chainHistoryRecallBlocks.js'));
const { getDayBoundsMs } = await import('../dist-electron/main/libs/dreamPrompt.js')
  .catch(() => import('../dist-electron/libs/dreamPrompt.js'));

test('resolveChainHistoryRecallQuery applies defaults and clamps', () => {
  const resolved = resolveChainHistoryRecallQuery({});
  assert.equal(resolved.query, null);
  assert.equal(resolved.kind, 'both');
  assert.equal(resolved.fromMs, null);
  assert.equal(resolved.toMs, null);
  assert.equal(resolved.limit, DEFAULT_CHAIN_HISTORY_RECALL_LIMIT);

  assert.equal(resolveChainHistoryRecallQuery({ kind: 'write' }).kind, 'write');
  assert.equal(resolveChainHistoryRecallQuery({ kind: 'read' }).kind, 'read');
  assert.equal(resolveChainHistoryRecallQuery({ kind: 'bogus' }).kind, 'both', 'unknown kind falls back to both');
  assert.equal(resolveChainHistoryRecallQuery({ query: '  ' }).query, null, 'blank query is treated as absent');
  assert.equal(resolveChainHistoryRecallQuery({ query: ' meta web ' }).query, 'meta web');
  assert.equal(resolveChainHistoryRecallQuery({ limit: 0 }).limit, 1);
  assert.equal(resolveChainHistoryRecallQuery({ limit: 999 }).limit, MAX_CHAIN_HISTORY_RECALL_LIMIT);
});

test('resolveChainHistoryRecallQuery parses local date bounds and ignores bad dates', () => {
  const resolved = resolveChainHistoryRecallQuery({ date_from: '2026-09-01', date_to: '2026-09-02' });
  assert.equal(resolved.fromMs, getDayBoundsMs('2026-09-01').startMs, 'from is local midnight of date_from');
  assert.equal(resolved.toMs, getDayBoundsMs('2026-09-02').endMs, 'to is exclusive end of date_to');
  assert.deepEqual(
    resolveChainHistoryRecallQuery({ date_from: 'yesterday', date_to: '2026/13/99' }),
    { query: null, kind: 'both', fromMs: null, toMs: null, limit: DEFAULT_CHAIN_HISTORY_RECALL_LIMIT },
    'malformed dates are dropped, not fatal',
  );
});

const write = (overrides = {}) => ({
  id: 1, metabotId: 7, pinId: 'w1', txId: null, path: '/protocols/simplebuzz', operation: 'create',
  contentText: '今天发布了新功能', contentTruncated: false, contentBytes: 10, contentType: 'text/plain',
  summary: null, summaryStatus: 'skipped', summaryAttempts: 0, summarizedAtMs: null,
  origin: 'tool:post_buzz', occurredAtMs: Date.parse('2026-09-01T02:00:00.000Z'),
  createdAt: '', ...overrides,
});

const read = (overrides = {}) => ({
  id: 2, metabotId: 7, pinId: 'r1', path: '/protocols/simplenote', protocol: 'simplenote',
  title: 'MetaWeb 指南', authorGlobalMetaId: 'gm-author', contentExcerpt: '指南正文',
  contentBytes: 12, summary: '介绍基本用法', summaryStatus: 'done', summaryAttempts: 0,
  summarizedAtMs: Date.parse('2026-09-01T03:00:00.000Z'), savedToKb: true, kbId: 'kb-1',
  source: 'read_metaweb_pin', firstReadAtMs: Date.parse('2026-09-01T01:00:00.000Z'),
  lastReadAtMs: Date.parse('2026-09-01T05:00:00.000Z'), readCount: 3, createdAt: '', ...overrides,
});

test('formatChainHistoryRecallResults renders writes and reads with pin ids and gists', () => {
  const text = formatChainHistoryRecallResults([write()], [read()]);
  assert.ok(text.includes('[write] pinId=w1'), 'write line carries the pinId');
  assert.ok(text.includes('/protocols/simplebuzz'));
  assert.ok(text.includes('今天发布了新功能'), 'write without summary falls back to stored text');
  assert.ok(text.includes('via tool:post_buzz'), 'origin is surfaced');
  assert.ok(text.includes('[read] pinId=r1'), 'read line carries the pinId');
  assert.ok(text.includes('「MetaWeb 指南」'));
  assert.ok(text.includes('author=gm-author'));
  assert.ok(text.includes('saved to knowledge base'), 'KB flag is surfaced');
  assert.ok(text.includes('read 3 times'), 'repeat reads are surfaced');
  assert.ok(text.includes('介绍基本用法'), 'read gist prefers the summary over the excerpt');
  assert.ok(text.includes('read_metaweb_pin'), 're-open hint present');
});

test('formatChainHistoryRecallResults prefers summaries and degrades gracefully', () => {
  const summarized = write({ summary: '发布了一篇长文', contentText: 'x'.repeat(1000) });
  const binary = write({ pinId: 'w2', contentText: null });
  const noExcerpt = read({ pinId: 'r2', title: null, path: null, protocol: null, contentExcerpt: null, summary: null, authorGlobalMetaId: null, savedToKb: false, readCount: 1 });
  const text = formatChainHistoryRecallResults([summarized, binary], [noExcerpt]);
  assert.ok(text.includes('发布了一篇长文'), 'summary wins over full text');
  assert.ok(!text.includes('x'.repeat(1000)));
  assert.ok(text.includes('(binary content)'), 'binary writes degrade to a marker');
  assert.ok(text.includes('(no excerpt)') && text.includes('(unknown)'), 'bare reads stay readable');
});

test('formatChainHistoryRecallResults caps long gists and reports empty results', () => {
  const longGist = write({ summary: '摘'.repeat(500) });
  const text = formatChainHistoryRecallResults([longGist], []);
  assert.ok(!text.includes('摘'.repeat(500)), 'gist is truncated');
  assert.ok(text.includes('…'));
  assert.ok(
    formatChainHistoryRecallResults([], []).includes('No matching records'),
    'empty results get an explicit message',
  );
});
