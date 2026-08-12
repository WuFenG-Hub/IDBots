import test from 'node:test';
import assert from 'node:assert/strict';

let buildKnowledgeBlock;
let formatKnowledgeRecallResults;
let formatKnowledgeUpsertResult;
let KNOWLEDGE_PROMPT_MAX_ITEMS;
try {
  ({
    buildKnowledgeBlock,
    formatKnowledgeRecallResults,
    formatKnowledgeUpsertResult,
    KNOWLEDGE_PROMPT_MAX_ITEMS,
  } = await import('../dist-electron/main/libs/knowledgePromptBlocks.js'));
} catch {
  ({
    buildKnowledgeBlock,
    formatKnowledgeRecallResults,
    formatKnowledgeUpsertResult,
    KNOWLEDGE_PROMPT_MAX_ITEMS,
  } = await import('../dist-electron/knowledgePromptBlocks.js'));
}

const sampleEntries = () => [
  { topic: '快速开发 3D 网页游戏', summary: 'React Three Fiber + Vite。', kind: 'know_how', category: '技术栈', version: 1 },
  { topic: 'SSR 产物访问 window', summary: '会崩，必须 typeof window 守卫。', kind: 'pitfall', version: 2 },
  { topic: '简约设计原则', summary: '大量留白、两种主色、圆角。', kind: 'principle', category: '设计' },
];

test('buildKnowledgeBlock returns empty string when there are no entries', () => {
  assert.equal(buildKnowledgeBlock([]), '');
  assert.equal(buildKnowledgeBlock(undefined), '');
});

test('buildKnowledgeBlock renders know_how and pitfall entries with labels and escapes XML', () => {
  const block = buildKnowledgeBlock(sampleEntries());
  assert.ok(block.includes('<knowledge>'), 'opens knowledge tag');
  assert.ok(block.includes('</knowledge>'), 'closes knowledge tag');
  assert.ok(block.includes('<know_how'), 'know_how entry rendered');
  assert.ok(block.includes('<pitfall'), 'pitfall entry rendered');
  assert.ok(block.includes('<principle'), 'principle entry rendered');
  assert.ok(block.includes('category="技术栈"'), 'category attribute present');
  assert.ok(block.includes('React Three Fiber'), 'summary content present');
  assert.ok(block.includes('<instruction>'), 'instruction block present');
});

test('buildKnowledgeBlock caps the number of items', () => {
  const many = Array.from({ length: 20 }, (_, index) => ({
    topic: `topic-${index}`,
    summary: 's',
    kind: 'know_how',
  }));
  const block = buildKnowledgeBlock(many, 3, 10000);
  const knowHowCount = (block.match(/<know_how/g) || []).length;
  assert.equal(knowHowCount, 3);
});

test('buildKnowledgeBlock respects the char budget and stays within it', () => {
  const entries = Array.from({ length: 10 }, (_, index) => ({
    topic: `topic-${index}-`.repeat(20),
    summary: 'x'.repeat(200),
    kind: 'know_how',
  }));
  const block = buildKnowledgeBlock(entries, 10, 500);
  assert.ok(block.length <= 500, `block length ${block.length} within budget`);
  assert.ok(block.includes('<knowledge>'));
});

test('buildKnowledgeBlock drops entries missing topic or summary', () => {
  const block = buildKnowledgeBlock([
    { topic: '', summary: 'orphan summary', kind: 'know_how' },
    { topic: 'orphan topic', summary: '', kind: 'know_how' },
    { topic: 'good', summary: 'kept', kind: 'know_how' },
  ], 10, 10000);
  assert.ok(block.includes('good'));
  assert.ok(!block.includes('orphan'));
});

test('buildKnowledgeBlock escapes XML-special characters in topic/summary', () => {
  const block = buildKnowledgeBlock([
    { topic: 'a < b & c > d', summary: '"quote" \'apos\'', kind: 'know_how' },
  ], 10, 10000);
  assert.ok(block.includes('&lt;'));
  assert.ok(block.includes('&gt;'));
  assert.ok(block.includes('&amp;'));
  assert.ok(block.includes('&quot;'));
  assert.ok(block.includes('&apos;'));
});

test('formatKnowledgeRecallResults labels kinds and notes the empty case', () => {
  const text = formatKnowledgeRecallResults([
    { topic: '3D 选型', summary: 'R3F。', kind: 'know_how', version: 1 },
    { topic: 'window 坑', summary: '会崩。', kind: 'pitfall', version: 3 },
  ]);
  assert.ok(text.includes('【做法】'));
  assert.ok(text.includes('【坑】'));
  assert.ok(text.includes('(v3)'));

  const empty = formatKnowledgeRecallResults([]);
  assert.ok(empty.includes('No knowledge points found'));
  assert.ok(empty.includes('knowledge_upsert'));
});

test('formatKnowledgeUpsertResult distinguishes create, revise and no-op', () => {
  assert.ok(formatKnowledgeUpsertResult({ topic: 't', created: true, revised: false, version: 1, kind: 'know_how' }).includes('Saved new'));
  assert.ok(formatKnowledgeUpsertResult({ topic: 't', created: false, revised: true, version: 2, kind: 'pitfall' }).includes('Updated'));
  assert.ok(formatKnowledgeUpsertResult({ topic: 't', created: false, revised: false, version: 1, kind: 'know_how' }).includes('already up to date'));
});

test('KNOWLEDGE_PROMPT_MAX_ITEMS is a sensible positive constant', () => {
  assert.ok(typeof KNOWLEDGE_PROMPT_MAX_ITEMS === 'number' && KNOWLEDGE_PROMPT_MAX_ITEMS > 0);
});
