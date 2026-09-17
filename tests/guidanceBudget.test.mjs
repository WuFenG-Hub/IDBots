import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);

const {
  buildExperiencePromptBlocksXml,
  buildValueBoundariesBlock,
  GUIDANCE_MAX_CHARS,
} = require('../dist-electron/main/libs/experiencePromptBlocks.js');
const { buildDreamPrompt } = require('../dist-electron/main/libs/dreamPrompt.js');
const { buildCounterfactualReplayPrompt } = require('../dist-electron/main/libs/counterfactualReplayPrompt.js');

test('value boundaries instruction frames rules as boundaries, not scripts', () => {
  const block = buildValueBoundariesBlock([{ text: '不确定时不要不懂装懂' }]);
  assert.ok(block.includes('boundaries, not scripts'));
  assert.ok(block.includes('adapt deliberately'));
});

test('guidance blocks share one budget; least-distilled layer trims first', () => {
  const long = (label, chars) => `${label}:${'详'.repeat(chars)}`;
  const input = {
    summaries: [],
    valueBoundaries: Array.from({ length: 5 }, (_, i) => ({ text: long(`边界${i}`, 200) })),
    workReviews: Array.from({ length: 5 }, (_, i) => ({ text: long(`复盘${i}`, 400) })),
    provenTechniques: Array.from({ length: 5 }, (_, i) => ({ title: `技巧${i}`, description: long('做法', 300) })),
  };
  const xml = buildExperiencePromptBlocksXml(input);
  // Value boundaries are the last layer trimmed; at this size the ladder lands
  // on [3, 0, 0]: the three newest boundaries survive, reviews and techniques
  // are dropped entirely.
  assert.ok(xml.includes('边界0'));
  assert.ok(xml.includes('边界2'));
  assert.ok(!xml.includes('边界3'));
  assert.ok(!xml.includes('<work_reviews>'));
  assert.ok(!xml.includes('<proven_techniques>'));
  assert.ok(xml.length <= GUIDANCE_MAX_CHARS, `guidance should fit the budget, got ${xml.length}`);
});

test('small guidance sets pass through untouched under the budget', () => {
  const xml = buildExperiencePromptBlocksXml({
    summaries: [],
    valueBoundaries: [{ text: '边界一' }],
    workReviews: [{ text: '复盘一' }],
    provenTechniques: [{ title: '技巧一', description: '做法一' }],
  });
  assert.ok(xml.includes('<value_boundaries>'));
  assert.ok(xml.includes('<work_reviews>'));
  assert.ok(xml.includes('<proven_techniques>'));
});

test('dream and replay prompts demand boundary-style lessons, not directives', () => {
  const dream = buildDreamPrompt({
    botName: '小火',
    date: '2026-08-12',
    activity: { sessions: [], taskRuns: [], orderCount: 0, groupTasks: [] },
  });
  assert.ok(dream.user.includes('写成「边界」'));
  assert.ok(dream.user.includes('不要写成「指令」'));

  const replay = buildCounterfactualReplayPrompt({
    botName: '小火',
    date: '2026-08-12',
    points: [{
      id: 'msg:s1:1',
      kind: 'thumbs_down',
      situation: '会话「t」:\n对方: 太慢了',
      botAction: '已经完成了',
      outcome: '人类对这条回复点了踩。',
    }],
  });
  assert.ok(replay.system.includes('边界(什么情况不该这么做)'));
});
