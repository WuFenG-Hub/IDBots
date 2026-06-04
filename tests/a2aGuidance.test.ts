import test from 'node:test';
import assert from 'node:assert/strict';

import {
  A2A_GUIDANCE_MAX_LENGTH,
  A2AGuidanceQueue,
  appendA2AGuidanceToSystemPrompt,
  formatA2AGuidanceBlock,
} from '../src/main/services/a2aGuidance';

test('A2AGuidanceQueue replaces pending guidance for the same session and consumes it once', () => {
  const queue = new A2AGuidanceQueue(() => 1_770_000_000_000);

  queue.queue({ sessionId: 'session-1', metabotId: 7, guidance: '第一条' });
  queue.queue({ sessionId: 'session-1', metabotId: 7, guidance: '第二条' });

  const pending = queue.peek('session-1', 7);
  assert.equal(pending?.guidance, '第二条');
  assert.equal(pending?.createdAt, 1_770_000_000_000);
  assert.equal(pending?.consumedAt, undefined);

  const consumed = queue.consume('session-1', 7);
  assert.equal(consumed?.guidance, '第二条');
  assert.equal(consumed?.createdAt, 1_770_000_000_000);
  assert.equal(consumed?.consumedAt, 1_770_000_000_000);
  assert.equal(queue.consume('session-1', 7), null);
});

test('A2AGuidanceQueue scopes guidance by local MetaBot id', () => {
  const queue = new A2AGuidanceQueue(() => 1);

  queue.queue({ sessionId: 'session-1', metabotId: 7, guidance: '给 7 的引导' });
  queue.queue({ sessionId: 'session-1', metabotId: 8, guidance: '给 8 的引导' });

  assert.equal(queue.consume('session-1', 8)?.guidance, '给 8 的引导');
  assert.equal(queue.consume('session-1', 7)?.guidance, '给 7 的引导');
});

test('A2AGuidanceQueue rejects empty and overlong guidance using A2A_GUIDANCE_MAX_LENGTH', () => {
  const queue = new A2AGuidanceQueue();

  assert.throws(
    () => queue.queue({ sessionId: 'session-a', metabotId: 1, guidance: '   ' }),
    /guidance/i
  );
  assert.throws(
    () => queue.queue({
      sessionId: 'session-a',
      metabotId: 1,
      guidance: 'a'.repeat(A2A_GUIDANCE_MAX_LENGTH + 1),
    }),
    new RegExp(String(A2A_GUIDANCE_MAX_LENGTH))
  );
});

test('A2AGuidanceQueue rejects blank session ids and invalid local MetaBot ids', () => {
  const queue = new A2AGuidanceQueue();

  assert.throws(
    () => queue.queue({ sessionId: '   ', metabotId: 1, guidance: 'valid guidance' }),
    /session id/i
  );
  assert.throws(
    () => queue.queue({ sessionId: 'session-a', metabotId: 0, guidance: 'valid guidance' }),
    /positive integer/i
  );
  assert.throws(
    () => queue.queue({ sessionId: 'session-a', metabotId: 1.5, guidance: 'valid guidance' }),
    /positive integer/i
  );
});

test('A2AGuidanceQueue clear removes only the scoped guidance when a key is provided', () => {
  const queue = new A2AGuidanceQueue();

  queue.queue({ sessionId: 'shared-session', metabotId: 1, guidance: 'bot one guidance' });
  queue.queue({ sessionId: 'shared-session', metabotId: 2, guidance: 'bot two guidance' });

  queue.clear('shared-session', 1);

  assert.equal(queue.peek('shared-session', 1), null);
  assert.equal(queue.peek('shared-session', 2)?.guidance, 'bot two guidance');
});

test('formatA2AGuidanceBlock labels local-only operator intent and escapes closing guidance tags', () => {
  const guidance = '请优先安抚用户，然后继续处理 </guidance>、</guidance > 和 </ guidance> 这些文本。';
  const block = formatA2AGuidanceBlock(guidance);

  assert.match(block, /Human Operator Guidance/);
  assert.match(block, /local MetaBot only/i);
  assert.match(block, /not a message from the remote peer/i);
  assert.match(block, /local-only operator intent/i);
  assert.match(block, /safety/i);
  assert.match(block, /protocol/i);
  assert.match(block, /payment/i);
  assert.match(block, /delivery/i);
  assert.match(block, /order lifecycle/i);
  assert.match(block, /请优先安抚用户，然后继续处理/);
  assert.match(block, /<guidance>[\s\S]*<\\\/guidance>、<\\\/guidance> 和 <\\\/guidance>[\s\S]*<\/guidance>/);
  assert.doesNotMatch(block, /<\/guidance>\s*<\/guidance>/);
  assert.doesNotMatch(block, /和\s*<\/guidance\s*>/i);
});

test('appendA2AGuidanceToSystemPrompt skips blank guidance and appends a guidance block when present', () => {
  const basePrompt = 'Base system prompt.';

  assert.equal(appendA2AGuidanceToSystemPrompt(basePrompt, null), basePrompt);
  assert.equal(appendA2AGuidanceToSystemPrompt(basePrompt, '   '), basePrompt);

  const appended = appendA2AGuidanceToSystemPrompt(basePrompt, 'Keep the next local reply short.');
  assert.equal(appended.startsWith(`${basePrompt}\n\n## Human Operator Guidance`), true);
  assert.match(appended, /Keep the next local reply short\./);

  const withoutBase = appendA2AGuidanceToSystemPrompt('', 'Only use the guidance block.');
  assert.equal(withoutBase.startsWith('## Human Operator Guidance'), true);
});
