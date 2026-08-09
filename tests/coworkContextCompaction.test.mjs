import test from 'node:test';
import assert from 'node:assert/strict';

test('buildCoworkCompactedPrompt creates summary, recent tail, and current request without thinking blocks', async () => {
  const {
    buildCoworkCompactedPrompt,
  } = await import('../dist-electron/main/libs/coworkContextCompaction.js');

  const currentPrompt = '请继续修复 compact retry';
  const result = buildCoworkCompactedPrompt({
    messages: [
      {
        id: 'old-user',
        type: 'user',
        content: '早期需求：分析 cowork 上下文问题',
        timestamp: 1,
      },
      {
        id: 'thinking',
        type: 'assistant',
        content: 'private chain of thought that must not be replayed',
        timestamp: 2,
        metadata: { isThinking: true },
      },
      {
        id: 'recent-assistant',
        type: 'assistant',
        content: '最近结论：resume 的 SDK 会话可能超过模型窗口',
        timestamp: 3,
      },
      {
        id: 'current-user',
        type: 'user',
        content: currentPrompt,
        timestamp: 4,
      },
    ],
    currentPrompt,
    modelLimits: { contextWindow: 4_000, maxOutputTokens: 500 },
    maxRecentMessages: 1,
  });

  assert.match(result.prompt, /<session_summary>/);
  assert.match(result.prompt, /早期需求：分析 cowork 上下文问题/);
  assert.match(result.prompt, /<recent_tail>/);
  assert.match(result.prompt, /最近结论：resume 的 SDK 会话可能超过模型窗口/);
  assert.match(result.prompt, /<current_user_request>/);
  assert.match(result.prompt, /请继续修复 compact retry/);
  assert.equal(result.prompt.includes('private chain of thought'), false);
  assert.equal(result.prompt.match(/请继续修复 compact retry/g)?.length, 1);
  assert.equal(result.recentMessages, 1);
  assert.equal(result.summarizedMessages, 1);
});

test('buildCoworkCompactedPrompt respects tight summary and tail budgets', async () => {
  const {
    buildCoworkCompactedPrompt,
  } = await import('../dist-electron/main/libs/coworkContextCompaction.js');

  const result = buildCoworkCompactedPrompt({
    messages: [
      {
        id: 'old',
        type: 'user',
        content: 'old '.repeat(200),
        timestamp: 1,
      },
      {
        id: 'recent',
        type: 'assistant',
        content: 'recent '.repeat(200),
        timestamp: 2,
      },
    ],
    currentPrompt: 'current task',
    modelLimits: { contextWindow: 800, maxOutputTokens: 100 },
    maxSummaryChars: 120,
    maxRecentTailTokens: 20,
  });

  assert.ok(result.prompt.length < 1_200);
  assert.match(result.prompt, /truncated/);
  assert.equal(result.estimatedTokens <= 300, true);
});

// ---------------------------------------------------------------------------
// GT#12 N6: image blocks in compact summaries become semantic placeholders —
// no raw base64 garbage in the compacted prompt.
// ---------------------------------------------------------------------------

const BASE64_IMAGE_CONTENT = JSON.stringify([
  {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/jpeg',
      data: 'A'.repeat(120_000),
    },
  },
]);

test('N6: image blocks render as a semantic placeholder with size, never base64', async () => {
  const {
    buildCoworkCompactedPrompt,
    describeImageContent,
  } = await import('../dist-electron/main/libs/coworkContextCompaction.js');

  const result = buildCoworkCompactedPrompt({
    messages: [
      {
        id: 'image-msg',
        type: 'tool_result',
        content: BASE64_IMAGE_CONTENT,
        timestamp: 1,
        metadata: { toolName: 'Read' },
      },
    ],
    currentPrompt: '继续',
    modelLimits: { contextWindow: 4_000, maxOutputTokens: 500 },
  });

  assert.equal(result.prompt.includes('A'.repeat(100)), false, 'no base64 payload may leak into the compact prompt');
  assert.match(result.prompt, /\[图片: image\/jpeg，base64 约 117KB，已省略\]/);
  assert.equal(result.prompt.includes('[truncated]'), false, 'image block must not be truncated as text');

  // describeImageContent is exported for direct unit testing.
  const summary = describeImageContent(BASE64_IMAGE_CONTENT);
  assert.equal(summary.includes('image/jpeg'), true);
  assert.equal(summary.includes('117KB'), true);
  assert.equal(summary.includes('AAAA'), false);
});

test('N6: image_url style blocks (proxy shape) are also recognized', async () => {
  const { describeImageContent } = await import('../dist-electron/main/libs/coworkContextCompaction.js');

  const summary = describeImageContent(JSON.stringify([
    { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'B'.repeat(2048) } },
  ]));
  assert.match(summary, /\[图片: image\/png/);
  assert.match(summary, /约 2KB/);
  assert.equal(summary.includes('BBBB'), false);
});

test('N6: plain text messages keep the previous compaction behavior exactly', async () => {
  const {
    buildCoworkCompactedPrompt,
    describeImageContent,
  } = await import('../dist-electron/main/libs/coworkContextCompaction.js');

  // describeImageContent returns null for non-image content.
  assert.equal(describeImageContent('normal text'), null);
  assert.equal(describeImageContent(JSON.stringify({ type: 'text', text: 'hello' })), null);
  assert.equal(describeImageContent(''), null);

  const longText = 'word '.repeat(2000);
  const result = buildCoworkCompactedPrompt({
    messages: [
      { id: 'text-msg', type: 'assistant', content: longText, timestamp: 1 },
    ],
    currentPrompt: '继续',
    modelLimits: { contextWindow: 4_000, maxOutputTokens: 500 },
  });

  // Same truncation marker as before the change.
  assert.match(result.prompt, /\.\.\. \[truncated\]/);
  assert.match(result.prompt, /word/);
});
