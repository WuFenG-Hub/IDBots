import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);

function loadCompiled(modulePath) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => process.cwd(),
        },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

const loadPromptModule = () => {
  try {
    return loadCompiled('../dist-electron/main/libs/deepConsolidationPrompt.js');
  } catch {
    return loadCompiled('../dist-electron/main/libs/deepConsolidationPrompt.js');
  }
};

const {
  buildDeepConsolidationPrompt,
  parseDeepConsolidationOutput,
  describeDeepConsolidationParseFailure,
  deepConsolidationRetireCap,
} = loadPromptModule();

const items = (count) =>
  Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    kind: 'value_boundary',
    text: `boundary ${index}`,
  }));

test('retire cap rounds a quarter of the inventory up', () => {
  assert.equal(deepConsolidationRetireCap(8), 2);
  assert.equal(deepConsolidationRetireCap(9), 3);
  assert.equal(deepConsolidationRetireCap(155), 39);
});

test('prompt states the retire cap so the model budgets its own proposal', () => {
  const prompt = buildDeepConsolidationPrompt({ botName: 'Twin', items: items(12) });
  assert.ok(
    prompt.includes('Propose at most 3 combined actions across retire_memory_ids, retire_knowledge_ids and rewrite_memories'),
    'cap rule states the computed limit and counts memory rewrites',
  );
  assert.ok(prompt.includes('Keep notes under 80 words'));
});

test('prompt carries the three merge rules, evidence lines and read-only markers', () => {
  const prompt = buildDeepConsolidationPrompt({
    botName: 'Twin',
    items: [
      ...items(6),
      {
        id: 'fact-dream',
        kind: 'profile_fact',
        text: '老板偏好周五发版',
        origin: 'dream',
        rewritable: true,
        proofCount: 3,
        quotes: ['我们一般周五发版', 'x'.repeat(200)],
        firstSeen: '2026-09-01',
        lastSeen: '2026-10-20',
      },
      {
        id: 'fact-owner',
        kind: 'profile_fact',
        text: '记住:以后改成周三发版',
        origin: 'conversation',
        rewritable: false,
        proofCount: 1,
        quotes: ['记住:以后改成周三发版'],
        firstSeen: '2026-10-22',
        lastSeen: '2026-10-22',
      },
      { id: 'know-1', kind: 'knowledge', text: 'deploy: steps', extra: 'kind=know_how, v2' },
    ],
  });
  assert.ok(prompt.includes('- Redundant:'), 'redundant rule');
  assert.ok(prompt.includes('- Direct contradiction:'), 'contradiction rule');
  assert.ok(prompt.includes('- State change:'), 'state-change rule');
  assert.ok(prompt.includes('must never appear in retire_memory_ids or rewrite_memories'), 'read-only items are context only');
  assert.ok(prompt.includes('at most 300 characters'), 'rewrite length stays under the store cap');
  assert.ok(
    prompt.includes('- fact-dream | profile_fact | 老板偏好周五发版 [origin=dream, proof=3, first=2026-09-01, last=2026-10-20]'),
    'memory meta renders inline',
  );
  assert.ok(prompt.includes('- fact-owner | profile_fact | 记住:以后改成周三发版 [origin=conversation, read-only, proof=1'), 'read-only marker');
  const evidenceLine = prompt.split('\n').find((line) => line.includes('evidence: "我们一般周五发版"'));
  assert.ok(evidenceLine, 'evidence quotes render under the item');
  assert.ok(evidenceLine.includes('…'), 'long quotes are clipped');
  assert.ok(!evidenceLine.includes('x'.repeat(121)), 'clip is at 120 chars');
  assert.ok(prompt.includes('- know-1 | knowledge | deploy: steps [kind=know_how, v2]'), 'knowledge rows keep their extra tag');
  assert.ok(prompt.includes('"rewrite_memories": [{"id"'), 'output shape names the new field');
});

test('parser reads rewrite_memories, normalizes reasons and stays backward compatible', () => {
  const withRewrites = parseDeepConsolidationOutput(JSON.stringify({
    retire_memory_ids: ['old'],
    retire_knowledge_ids: [],
    rewrite_memories: [
      { id: 'a', text: ' 曾偏好周五发版,10月起改为周三 ', reason: 'contradiction' },
      { id: 'b', text: '从 X 改为 Y', reason: 'bogus-reason' },
      { id: 'c', text: '   ' },
      { id: 'd' },
      'not-an-object',
    ],
    rewrite_knowledge: [],
    notes: 'ok',
  }));
  assert.deepEqual(withRewrites?.rewriteMemories, [
    { id: 'a', text: '曾偏好周五发版,10月起改为周三', reason: 'contradiction' },
    { id: 'b', text: '从 X 改为 Y', reason: 'state_change' },
  ], 'trimmed text, unknown reason → state_change, textless/malformed entries dropped');

  const legacy = parseDeepConsolidationOutput(JSON.stringify({
    retire_memory_ids: ['a'],
    retire_knowledge_ids: [],
    rewrite_knowledge: [],
    notes: 'legacy shape',
  }));
  assert.deepEqual(legacy?.rewriteMemories, [], 'a proposal without the field parses as no rewrites');
});

test('parser accepts fenced JSON and tolerates prose wrappers', () => {
  const payload = JSON.stringify({
    retire_memory_ids: ['a'],
    retire_knowledge_ids: [],
    rewrite_knowledge: [],
    notes: 'kept most items',
  });
  const fenced = parseDeepConsolidationOutput('```json\n' + payload + '\n```');
  assert.deepEqual(fenced?.retireMemoryIds, ['a']);
  const wrapped = parseDeepConsolidationOutput('Here is my review:\n' + payload + '\nDone.');
  assert.deepEqual(wrapped?.retireMemoryIds, ['a']);
});

test('parser rejects truncated JSON streams', () => {
  const full = JSON.stringify({
    retire_memory_ids: ['a', 'b', 'c'],
    retire_knowledge_ids: [],
    rewrite_knowledge: [],
    notes: 'x',
  });
  // The 2026-09-02 failure mode: output cut mid-list at the token budget.
  const truncated = full.slice(0, full.indexOf('"b"'));
  assert.equal(parseDeepConsolidationOutput(truncated), null);
});

test('parse-failure diagnosis distinguishes truncation from malformed JSON', () => {
  assert.equal(describeDeepConsolidationParseFailure(''), 'empty output');
  assert.equal(describeDeepConsolidationParseFailure('   \n'), 'empty output');
  // Prose / truncated stream: no complete {...} pair anywhere.
  assert.match(
    describeDeepConsolidationParseFailure('Let me analyze the inventory carefully. 1. `867f'),
    /no complete JSON object in \d+ chars/,
  );
  // Truncated mid-JSON: an opening brace exists but no closing one after it.
  assert.match(
    describeDeepConsolidationParseFailure('{"retire_memory_ids": ["a", "b"'),
    /no complete JSON object in \d+ chars/,
  );
  // Complete braces but invalid JSON inside.
  assert.match(
    describeDeepConsolidationParseFailure('{retire_memory_ids: [a, b]}'),
    /malformed JSON object \(\d+ chars\)/,
  );
});
