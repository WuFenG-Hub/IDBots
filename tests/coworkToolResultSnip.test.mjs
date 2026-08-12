/**
 * Unit tests for coworkToolResultSnip (Reasonix-style tiered tool-result
 * truncation). Imports the compiled module from dist-electron — run
 * `npm run compile:electron` first (same as the other cowork unit tests).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

async function importSnip() {
  try {
    return await import('../dist-electron/main/libs/coworkToolResultSnip.js');
  } catch {
    return await import('../dist-electron/libs/coworkToolResultSnip.js');
  }
}

function toolResultMessage(toolUseId, content) {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
    Object.freeze(value);
  }
  return value;
}

test('snips a long tool_result inside the head boundary', async () => {
  const { snipStaleToolResultBlocks, COWORK_TOOL_RESULT_SNIP_MARKER } = await importSnip();
  const text = 'A'.repeat(5000);
  const result = snipStaleToolResultBlocks([toolResultMessage('tu-1', text)], 100_000);

  assert.equal(result.stats.snippedBlocks, 1);
  const block = result.messages[0].content[0];
  assert.equal(block.tool_use_id, 'tu-1');
  assert.ok(block.content.startsWith('A'.repeat(600)));
  assert.ok(block.content.endsWith('A'.repeat(300)));
  assert.ok(
    block.content.includes(`\n${COWORK_TOOL_RESULT_SNIP_MARKER} — 4100 bytes omitted; re-read or re-run if needed]\n`),
    `unexpected snipped body: ${block.content.slice(580, 760)}`
  );
});

test('only the head region within the token boundary is snipped; the tail stays intact', async () => {
  const { snipStaleToolResultBlocks, estimateAnthropicContentTokens } = await importSnip();
  const head = toolResultMessage('tu-1', 'B'.repeat(4000));
  const tail = toolResultMessage('tu-2', 'C'.repeat(4000));
  // Boundary exactly covers message 1 (~1000 tokens); message 2 crosses it.
  const boundary = estimateAnthropicContentTokens(head.content);
  const result = snipStaleToolResultBlocks([head, tail], boundary);

  assert.equal(result.stats.snippedBlocks, 1);
  assert.ok(result.messages[0].content[0].content.includes('[snipped tool result'));
  assert.equal(result.messages[1], tail);
  assert.equal(result.messages[1].content[0].content, 'C'.repeat(4000));
});

test('a message straddling the boundary is left fully intact (conservative)', async () => {
  const { snipStaleToolResultBlocks, estimateAnthropicContentTokens } = await importSnip();
  const msg = toolResultMessage('tu-1', 'D'.repeat(4000));
  const boundary = estimateAnthropicContentTokens(msg.content) - 1; // one token short
  const result = snipStaleToolResultBlocks([msg], boundary);
  assert.equal(result.stats.snippedBlocks, 0);
  assert.equal(result.messages[0], msg);
});

test('second pass over snipped output changes nothing (idempotent)', async () => {
  const { snipStaleToolResultBlocks } = await importSnip();
  const messages = [toolResultMessage('tu-1', 'E'.repeat(5000))];
  const first = snipStaleToolResultBlocks(messages, 100_000);
  assert.equal(first.stats.snippedBlocks, 1);

  const second = snipStaleToolResultBlocks(first.messages, 100_000);
  assert.equal(second.stats.snippedBlocks, 0);
  assert.equal(second.stats.savedTokens, 0);
  assert.deepEqual(second.messages, first.messages);
  // Untouched messages keep object identity, so downstream bytes stay stable.
  assert.equal(second.messages[0], first.messages[0]);
});

test('tool_use blocks, pairing fields, and message order stay intact', async () => {
  const { snipStaleToolResultBlocks } = await importSnip();
  const toolUseBlock = { type: 'tool_use', id: 'tu-9', name: 'Bash', input: { command: 'ls -la' } };
  const assistant = { role: 'assistant', content: [toolUseBlock] };
  const user = {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tu-9', is_error: false, content: 'R'.repeat(4000) }],
  };
  const result = snipStaleToolResultBlocks([assistant, user], 100_000);

  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0], assistant);
  assert.equal(result.messages[0].content[0], toolUseBlock);
  const snipped = result.messages[1].content[0];
  assert.equal(snipped.type, 'tool_result');
  assert.equal(snipped.tool_use_id, 'tu-9');
  assert.equal(snipped.is_error, false);
  assert.ok(snipped.content.startsWith('R'.repeat(600)));
  assert.ok(snipped.content.endsWith('R'.repeat(300)));
});

test('image blocks and image-carrying tool_result parts are never touched', async () => {
  const { snipStaleToolResultBlocks } = await importSnip();
  const imagePart = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };
  const mixed = {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tu-mix',
        content: [{ type: 'text', text: 'M'.repeat(3000) }, imagePart],
      },
    ],
  };
  const imageOnly = {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tu-img', content: [imagePart] }],
  };
  const result = snipStaleToolResultBlocks([mixed, imageOnly], 100_000);

  assert.equal(result.stats.snippedBlocks, 1);
  const parts = result.messages[0].content[0].content;
  assert.equal(parts.length, 2);
  assert.ok(parts[0].text.includes('[snipped tool result'));
  assert.equal(parts[1], imagePart);
  assert.equal(result.messages[0].content[0].tool_use_id, 'tu-mix');
  // No text parts at all => whole message keeps identity.
  assert.equal(result.messages[1], imageOnly);
});

test('tool results at or below 1200 chars are left alone', async () => {
  const { snipStaleToolResultBlocks } = await importSnip();
  for (const length of [1100, 1200]) {
    const msg = toolResultMessage(`tu-${length}`, 'S'.repeat(length));
    const result = snipStaleToolResultBlocks([msg], 100_000);
    assert.equal(result.stats.snippedBlocks, 0, `length ${length} should not be snipped`);
    assert.equal(result.messages[0], msg);
  }
});

test('returns a new array and never mutates the input', async () => {
  const { snipStaleToolResultBlocks } = await importSnip();
  const head = toolResultMessage('tu-h', 'H'.repeat(3000));
  const tail = toolResultMessage('tu-t', 'T'.repeat(3000));
  const input = deepFreeze([head, tail]); // throws if the module mutates anything

  const result = snipStaleToolResultBlocks(input, 750); // 3000 chars ~= 750 tokens: covers msg 1 only
  assert.notEqual(result.messages, input);
  assert.notEqual(result.messages[0], head);
  assert.equal(result.messages[1], tail);
  assert.equal(head.content[0].content, 'H'.repeat(3000));
  assert.equal(tail.content[0].content, 'T'.repeat(3000));
});

test('omitted byte count is utf8 bytes, not chars (CJK)', async () => {
  const { snipStaleToolResultBlocks, COWORK_TOOL_RESULT_SNIP_MARKER } = await importSnip();
  const text = '你'.repeat(2000);
  const result = snipStaleToolResultBlocks([toolResultMessage('tu-cjk', text)], 100_000);

  assert.equal(result.stats.snippedBlocks, 1);
  const snipped = result.messages[0].content[0].content;
  const expectedOmittedBytes = Buffer.byteLength('你'.repeat(2000 - 900), 'utf8'); // 3300
  assert.ok(snipped.startsWith('你'.repeat(600)));
  assert.ok(snipped.endsWith('你'.repeat(300)));
  assert.ok(snipped.includes(`${COWORK_TOOL_RESULT_SNIP_MARKER} — ${expectedOmittedBytes} bytes omitted`));
});

test('stats report plausible token savings and the pre-snip total estimate', async () => {
  const { snipStaleToolResultBlocks, estimateAnthropicContentTokens } = await importSnip();
  const msg = toolResultMessage('tu-s', 'A'.repeat(5000));
  const result = snipStaleToolResultBlocks([msg], 100_000);

  assert.equal(result.stats.snippedBlocks, 1);
  assert.equal(result.stats.estimatedTokens, estimateAnthropicContentTokens(msg.content));
  const snippedLength = result.messages[0].content[0].content.length;
  assert.ok(snippedLength < 1100, `snipped length ${snippedLength} should be well under the original 5000`);
  // 5000 ASCII chars ~= 1250 tokens; snipped form ~= 250 tokens.
  assert.ok(
    result.stats.savedTokens > 800 && result.stats.savedTokens <= 1250,
    `savedTokens ${result.stats.savedTokens} out of plausible range`
  );
});

test('plain string content is never rewritten, boundary 0 and malformed input snip nothing', async () => {
  const { snipStaleToolResultBlocks } = await importSnip();
  const stringMessage = { role: 'user', content: 'P'.repeat(5000) };
  const result = snipStaleToolResultBlocks([stringMessage], 100_000);
  assert.equal(result.stats.snippedBlocks, 0);
  assert.equal(result.messages[0], stringMessage);
  assert.ok(result.stats.estimatedTokens > 0);

  const zeroBudget = snipStaleToolResultBlocks([toolResultMessage('tu-z', 'Z'.repeat(5000))], 0);
  assert.equal(zeroBudget.stats.snippedBlocks, 0);

  const malformed = snipStaleToolResultBlocks('not-an-array', 1000);
  assert.deepEqual(malformed.messages, []);
  assert.deepEqual(malformed.stats, { snippedBlocks: 0, savedTokens: 0, estimatedTokens: 0 });
});

test('snipping is deterministic: same input and boundary produce identical bytes', async () => {
  const { snipStaleToolResultBlocks } = await importSnip();
  const build = () => ([
    toolResultMessage('tu-1', 'Q'.repeat(6000)),
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/tmp/a' } }] },
    toolResultMessage('tu-2', 'W'.repeat(3000)),
  ]);
  const a = snipStaleToolResultBlocks(build(), 1600);
  const b = snipStaleToolResultBlocks(build(), 1600);
  assert.equal(JSON.stringify(a.messages), JSON.stringify(b.messages));
});
