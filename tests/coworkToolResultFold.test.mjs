/**
 * GT#12 N5 unit tests: foldLowValueToolResults — polling-shaped low-value
 * tool_result blocks are folded to one-line placeholders during playback
 * assembly, keeping only the most recent ones fully intact. Storage is never
 * touched; tool_use/tool_result pairing is preserved (content-only rewrite).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

async function importFold() {
  try {
    return await import('../dist-electron/main/libs/coworkToolResultFold.js');
  } catch {
    return await import('../dist-electron/libs/coworkToolResultFold.js');
  }
}

function toolResultMessage(toolUseId, content) {
  return {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: toolUseId, content },
    ],
  };
}

function toolUseMessage(toolUseId, toolName = 'Bash') {
  return {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: toolUseId, name: toolName, input: {} },
    ],
  };
}

const POLLING_RESULT = '状态: executing | 消息数: 5 | working...';
const NORMAL_RESULT = 'Report generated: /tmp/report.md with 42 rows of data and full details.';

function buildReplay(nPolling, extra = []) {
  const messages = [];
  for (let index = 0; index < nPolling; index += 1) {
    messages.push(toolUseMessage(`tu-${index}`));
    messages.push(toolResultMessage(`tu-${index}`, POLLING_RESULT));
  }
  return [...messages, ...extra];
}

test('N5: fewer than MIN_COUNT polling results are left untouched (byte-stable)', async () => {
  const { foldLowValueToolResults, LOW_VALUE_TOOL_RESULT_MIN_COUNT } = await importFold();

  assert.equal(LOW_VALUE_TOOL_RESULT_MIN_COUNT, 3);
  const messages = buildReplay(2);
  const result = foldLowValueToolResults(messages);

  assert.equal(result.messages, messages, 'input array must be returned as-is when nothing is folded');
  assert.deepEqual(result.stats, { total: 2, folded: 0, kept: 0 });
});

test('N5: 5 polling results fold the oldest 3 and keep the most recent 2 intact', async () => {
  const { foldLowValueToolResults, LOW_VALUE_TOOL_RESULT_KEEP_RECENT } = await importFold();

  assert.equal(LOW_VALUE_TOOL_RESULT_KEEP_RECENT, 2);
  const messages = buildReplay(5);
  const result = foldLowValueToolResults(messages);

  assert.deepEqual(result.stats, { total: 5, folded: 3, kept: 2 });

  const toolResults = result.messages
    .filter((message) => Array.isArray(message.content))
    .map((message) => message.content.find((block) => block?.type === 'tool_result'))
    .filter(Boolean);

  assert.equal(toolResults.length, 5, 'all tool_result blocks must stay in place (pairing preserved)');

  // Oldest folded block carries the summary line.
  assert.match(toolResults[0].content, /轮询类 tool_result ×5 已折叠/);
  assert.match(toolResults[0].content, /最近 2 条保留完整/);
  // The two most recent results stay byte-identical.
  assert.equal(toolResults[3].content, POLLING_RESULT);
  assert.equal(toolResults[4].content, POLLING_RESULT);
  // Every folded block keeps its tool_use_id.
  assert.equal(toolResults[0].tool_use_id, 'tu-0');
  assert.equal(toolResults[1].tool_use_id, 'tu-1');
});

test('N5: polling results separated by normal results are still found and folded', async () => {
  const { foldLowValueToolResults } = await importFold();

  const messages = [
    toolUseMessage('tu-0'),
    toolResultMessage('tu-0', POLLING_RESULT),
    toolUseMessage('tu-1'),
    toolResultMessage('tu-1', '状态: pending'),
    toolUseMessage('tu-2'),
    toolResultMessage('tu-2', POLLING_RESULT),
    toolUseMessage('tu-3'),
    toolResultMessage('tu-3', POLLING_RESULT),
    toolUseMessage('tu-4'),
    toolResultMessage('tu-4', NORMAL_RESULT),
  ];
  const result = foldLowValueToolResults(messages);

  assert.deepEqual(result.stats, { total: 4, folded: 2, kept: 2 });
  // Normal (non-polling) result is never touched.
  const lastToolResult = messages.find(
    (message) => Array.isArray(message.content)
      && message.content.some((block) => block?.type === 'tool_result' && block.content === NORMAL_RESULT)
  );
  assert.ok(lastToolResult);
  const lastBlock = lastToolResult.content.find((block) => block.type === 'tool_result');
  assert.equal(lastBlock.content, NORMAL_RESULT);
});

test('N5: long results (>1KB) are never treated as low-value polling', async () => {
  const { foldLowValueToolResults, isLowValuePollingToolResult } = await importFold();

  const longPolling = `${POLLING_RESULT} ${'x'.repeat(2000)}`;
  assert.equal(isLowValuePollingToolResult(longPolling), false);

  const messages = buildReplay(3).map((message, index) => {
    if (index % 2 === 1) {
      return { ...message, content: [{ ...message.content[0], content: longPolling }] };
    }
    return message;
  });
  const result = foldLowValueToolResults(messages);
  assert.deepEqual(result.stats, { total: 0, folded: 0, kept: 0 });
});

test('N5: non-string and empty tool_result contents are not folded', async () => {
  const { isLowValuePollingToolResult } = await importFold();

  assert.equal(isLowValuePollingToolResult(''), false);
  assert.equal(isLowValuePollingToolResult('   '), false);
  assert.equal(isLowValuePollingToolResult(null), false);
  assert.equal(isLowValuePollingToolResult(undefined), false);
  assert.equal(isLowValuePollingToolResult({ type: 'text', text: '状态: done' }), false);
  assert.equal(isLowValuePollingToolResult('status: ok'), true);
  assert.equal(isLowValuePollingToolResult('poll: none'), true);
});

test('N5: folding composes with non-tool messages and never rewrites unrelated blocks', async () => {
  const { foldLowValueToolResults } = await importFold();

  const messages = [
    { role: 'user', content: '请继续执行' },
    ...buildReplay(4),
    { role: 'assistant', content: '完成' },
  ];
  const result = foldLowValueToolResults(messages);

  assert.deepEqual(result.stats, { total: 4, folded: 2, kept: 2 });
  assert.equal(result.messages[0], messages[0], 'unrelated user message reference preserved');
  assert.equal(result.messages[result.messages.length - 1], messages[messages.length - 1], 'assistant reply reference preserved');
});
