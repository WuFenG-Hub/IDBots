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
    return loadCompiled('../dist-electron/libs/deepConsolidationPrompt.js');
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
  assert.ok(prompt.includes('Propose at most 3 combined retire/rewrite actions'), 'cap rule states the computed limit');
  assert.ok(prompt.includes('Keep notes under 80 words'));
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
