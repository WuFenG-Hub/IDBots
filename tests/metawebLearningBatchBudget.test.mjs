import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildMetawebLearningAgentTools,
  formatMetawebPinDetail,
  METAWEB_BATCH_RESULT_CHAR_BUDGET,
} = require('../dist-electron/main/libs/metawebLearningAgentTools.js');

function makePin(pinId, overrides = {}) {
  return {
    pinId,
    currentPinId: pinId,
    protocol: 'simplenote',
    path: '/protocols/simplenote',
    chainName: 'mvc',
    operation: 'create',
    creator: { globalMetaId: 'idq-test', metaid: 'meta-test', name: 'Tester', address: 'addr-test' },
    createdAt: 1789000000,
    contentType: 'text/markdown',
    payload: null,
    text: 'x'.repeat(4000),
    truncated: false,
    totalLength: 4000,
    meta: { title: `Title ${pinId}`, summary: '', tags: [] },
    attachments: [],
    source: 'local',
    version: { latest: pinId, count: 1 },
    ...overrides,
  };
}

function makeHarness(batchEntries) {
  const metawebLearning = {
    search: async () => { throw new Error('not used'); },
    readPin: async () => { throw new Error('not used'); },
    readPinsBatch: async (pinIds) => {
      const out = {};
      for (const id of pinIds) out[id] = batchEntries[id] ?? { pinId: id, error: 'pin missing from batch response' };
      return out;
    },
    pinVersions: async () => { throw new Error('not used'); },
  };
  const tools = buildMetawebLearningAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    metawebLearning,
    resolveMetabotId: () => 1,
  });
  const batch = tools.find((entry) => entry.name === 'read_metaweb_pins_batch');
  return { batch };
}

const resultText = (result) => result.content.map((block) => block.text).join('\n');

const pinIdFor = (index, letter) => `${String(index).padStart(2, '0')}${letter.repeat(62)}i0`;

test('formatMetawebPinDetail: bodyCharCap trims with a labeled pointer, omitBody drops the body', () => {
  const pin = makePin('a'.repeat(64) + 'i0', { text: 'A'.repeat(500) });
  const trimmed = formatMetawebPinDetail(pin, { bodyCharCap: 100 });
  assert.match(trimmed, /showing first 100 of 500 chars — trimmed to fit this batch's result budget/);
  assert.match(trimmed, /read_metaweb_pin/);
  assert.ok(!trimmed.includes('A'.repeat(200)), 'trimmed body must not keep the full 500 chars');

  const omitted = formatMetawebPinDetail(pin, { omitBody: true });
  assert.match(omitted, /content omitted to fit this batch's result budget \(500 chars\)/);
  assert.ok(!omitted.includes('<metaweb_pin_content>'), 'omitted body must not render a content block');

  // Default call shape is unchanged for single reads.
  const full = formatMetawebPinDetail(pin);
  assert.ok(full.includes('A'.repeat(500)));
  assert.doesNotMatch(full, /budget/);
});

test('oversized batches render every meta block under the shaping window, bodies honestly omitted', async () => {
  const entries = {};
  for (let index = 0; index < 20; index += 1) {
    const pinId = pinIdFor(index, 'p');
    entries[pinId] = makePin(pinId, { text: `Body ${index} — ` + 'y'.repeat(8000) });
  }
  const { batch } = makeHarness(entries);
  const result = await batch.handler({ pinIds: Object.keys(entries) });
  const text = resultText(result);
  assert.equal(result.isError, undefined);
  // The whole rendered result must sit under the runtime's 20k-char shaping
  // window (head+tail cut) — that is the entire point of the budget.
  assert.ok(text.length <= 20_000, `rendered ${text.length} chars — over the shaping window`);
  // Every requested pin keeps its complete meta block, first to last.
  for (const pinId of Object.keys(entries)) {
    assert.ok(text.includes(`Pin ${pinId}:`), `missing meta block for ${pinId}`);
    assert.ok(text.includes(`Title ${pinId}`), `missing title for ${pinId}`);
  }
  // No body silently half-rendered: 8k bodies cannot fit, so each is either
  // a labeled omission pointer or a labeled trim — never a bare block.
  const bodyBlocks = text.match(/<metaweb_pin_content>/g)?.length ?? 0;
  if (bodyBlocks > 0) {
    assert.match(text, /trimmed to fit this batch's result budget; full body via read_metaweb_pin/);
  } else {
    assert.match(text, /content omitted to fit this batch's result budget/);
  }
  assert.match(text, /20\/20 pin\(s\) readable in this batch; 20 body\(ies\) trimmed or omitted/);
});

test('mid-size batches trim bodies with per-pin labels and keep water-filled short bodies whole', async () => {
  const entries = {};
  const tinyId = pinIdFor(0, 't');
  entries[tinyId] = makePin(tinyId, { text: 'TINYWHOLEBODY-' + 'z'.repeat(150) });
  for (let index = 1; index <= 11; index += 1) {
    const pinId = pinIdFor(index, 'm');
    entries[pinId] = makePin(pinId, { text: `Body ${index} — ` + 'w'.repeat(1500) });
  }
  const { batch } = makeHarness(entries);
  const result = await batch.handler({ pinIds: Object.keys(entries) });
  const text = resultText(result);
  assert.equal(result.isError, undefined);
  assert.ok(text.length <= 20_000, `rendered ${text.length} chars — over the shaping window`);
  for (const pinId of Object.keys(entries)) {
    assert.ok(text.includes(`Pin ${pinId}:`), `missing meta block for ${pinId}`);
  }
  // Water-filling: the 166-char body renders whole even while the 1,515-char
  // bodies share what is left.
  assert.ok(text.includes('TINYWHOLEBODY-'), 'the short body must render whole');
  assert.match(text, /trimmed to fit this batch's result budget; full body via read_metaweb_pin/);
  assert.match(text, /11 body\(ies\) trimmed or omitted/);
});

test('small batches keep bodies whole (no trim label, full text rendered)', async () => {
  const entries = {};
  for (let index = 0; index < 10; index += 1) {
    const pinId = pinIdFor(index, 'q');
    entries[pinId] = makePin(pinId, { text: `Whole body ${index} — ` + 'z'.repeat(700) });
  }
  const { batch } = makeHarness(entries);
  const result = await batch.handler({ pinIds: Object.keys(entries) });
  const text = resultText(result);
  assert.equal(result.isError, undefined);
  assert.ok(text.length <= 20_000, `rendered ${text.length} chars — over the shaping window`);
  assert.doesNotMatch(text, /trimmed or omitted/);
  assert.ok(text.includes('z'.repeat(700)), 'full bodies must render for a small batch');
});

test('error and no-text entries never lose their lines', async () => {
  const goodId = pinIdFor(0, 'g');
  const errId = pinIdFor(1, 'e');
  const nullId = pinIdFor(2, 'n');
  const entries = {
    [goodId]: makePin(goodId, { text: 'g'.repeat(4000) }),
    [errId]: { pinId: errId, error: 'indexer gap' },
    [nullId]: makePin(nullId, { text: null, truncated: null, totalLength: null }),
  };
  const { batch } = makeHarness(entries);
  const result = await batch.handler({ pinIds: [goodId, errId, nullId] });
  const text = resultText(result);
  assert.ok(text.includes('- error: indexer gap'));
  assert.ok(text.includes('has no readable text content'));
  assert.ok(text.includes(`Pin ${goodId}:`));
  assert.match(text, /1\/3 pin\(s\) readable/);
});

test('degenerate batch (skeletons alone over budget) fails loudly with a split size', async () => {
  const entries = {};
  for (let index = 0; index < 45; index += 1) {
    const pinId = pinIdFor(index, 's');
    entries[pinId] = makePin(pinId, { text: 'w'.repeat(300) });
  }
  const { batch } = makeHarness(entries);
  const result = await batch.handler({ pinIds: Object.keys(entries) });
  const text = resultText(result);
  assert.equal(result.isError, true);
  assert.match(text, /cannot render within the result budget/);
  assert.match(text, /Split it into batches of at most ~\d+ pinIds/);
});

test('budget constant sits safely under the 20k shaping cap', () => {
  assert.ok(METAWEB_BATCH_RESULT_CHAR_BUDGET < 20_000);
  assert.ok(METAWEB_BATCH_RESULT_CHAR_BUDGET >= 15_000, 'budget should stay generous for real batches');
});
