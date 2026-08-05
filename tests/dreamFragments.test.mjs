import test from 'node:test';
import assert from 'node:assert/strict';

let chunkDreamActivity;
let estimateDreamActivityTokens;
let summariesToActivity;
try {
  ({ chunkDreamActivity, estimateDreamActivityTokens, summariesToActivity } = await import('../dist-electron/main/libs/dreamFragments.js'));
} catch {
  ({ chunkDreamActivity, estimateDreamActivityTokens, summariesToActivity } = await import('../dist-electron/libs/dreamFragments.js'));
}

test('chunkDreamActivity preserves chronological message content and coverage', () => {
  const first = '甲'.repeat(1800);
  const second = '乙'.repeat(900);
  const activity = {
    sessions: [{
      sessionId: 's1',
      title: '长会话',
      sessionType: 'standard',
      peerName: null,
      isOrder: false,
      messages: [
        { type: 'user', content: first, createdAt: 1 },
        { type: 'assistant', content: second, createdAt: 2 },
      ],
    }],
    taskRuns: [{ taskName: '巡检', status: 'success', startedAt: 3, sessionId: 's1' }],
    orderCount: 2,
  };

  const chunks = chunkDreamActivity(activity, 500);
  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].taskRuns.length, 1);
  assert.equal(chunks[0].orderCount, 2);
  assert.equal(chunks.slice(1).every((chunk) => chunk.taskRuns.length === 0 && chunk.orderCount === 0), true);
  assert.equal(
    chunks.flatMap((chunk) => chunk.messages).map((message) => message.content).join(''),
    `${first}${second}`,
  );
  assert.ok(chunks.every((chunk) => chunk.estimatedInputTokens <= 500 || chunk.messages.length === 1));
  assert.ok(estimateDreamActivityTokens(activity) > 500);
});

test('summariesToActivity retains fragment provenance and day-level counters', () => {
  const activity = summariesToActivity([
    { fragmentKey: 'session:s1:0', sessionId: 's1', title: '发布讨论', chunkIndex: 0, output: { dailySummary: '证据' } },
  ], [{ taskName: '巡检', status: 'success', startedAt: 1, sessionId: 's1' }], 3);
  assert.equal(activity.sessions[0].sessionType, 'dream_fragment');
  assert.equal(activity.sessions[0].messages[0].type, 'assistant');
  assert.ok(activity.sessions[0].messages[0].content.includes('session:s1:0'));
  assert.equal(activity.taskRuns.length, 1);
  assert.equal(activity.orderCount, 3);
});
