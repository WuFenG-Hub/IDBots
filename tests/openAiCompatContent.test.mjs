/**
 * Unit tests for openAiCompatContent — the family-aware decision behind the
 * openai-compat resolver's reasoning_content promotion in
 * services/cognitiveChatCompletion.ts. Born from the 2026-10-23 ack-bubble
 * leak: an always-thinking GLM-5.x brain burned the ack budget in hidden
 * reasoning, content came back empty, and the then-unconditional fallback
 * promoted reasoning_content — a mid-thought English analysis fragment then
 * shipped as the ack bubble.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// The helper depends on modelThinking (the wire-family authority), and
// electron-tsconfig forbids .ts-suffixed imports — so, like
// modelThinking.test.mjs, this suite tests the compiled output of
// `pnpm run compile:electron`.
const { resolveOpenAiCompatContent } = await import('../dist-electron/main/libs/openAiCompatContent.js');

// ---------------------------------------------------------------------------
// GLM family: reasoning_content is ALWAYS hidden thinking — never promote
// ---------------------------------------------------------------------------

test('glm: empty content + reasoning_content -> no promotion, reasoning-only block types', () => {
  // The exact 2026-10-23 leak shape: GLM-5.x ack with thinking-only output.
  const glm = resolveOpenAiCompatContent('glm-5.3-flash', {
    content: '',
    reasoning_content: 'The user is asking about scheduled tasks.',
  });
  assert.equal(glm.content, '');
  assert.equal(glm.promotedFromReasoning, false);
  assert.deepEqual(glm.contentBlockTypes, ['reasoning']);

  // Gateway-prefixed ids resolve to the same family.
  const prefixed = resolveOpenAiCompatContent('z-ai/glm-5.3-flash', {
    content: null,
    reasoning_content: 'mid-thought analysis',
  });
  assert.equal(prefixed.content, '');
  assert.equal(prefixed.promotedFromReasoning, false);
  assert.deepEqual(prefixed.contentBlockTypes, ['reasoning']);

  // Switchable-thinking GLM-4.x is still the GLM family: no promotion.
  const glm4 = resolveOpenAiCompatContent('glm-4.7-flash', {
    content: '   ',
    reasoning_content: 'thinking text',
  });
  assert.equal(glm4.content, '');
  assert.equal(glm4.promotedFromReasoning, false);
  assert.deepEqual(glm4.contentBlockTypes, ['reasoning']);
});

// ---------------------------------------------------------------------------
// DeepSeek dialect: the final answer can land in reasoning_content — promote
// ---------------------------------------------------------------------------

test('deepseek: empty content + reasoning_content -> promotion still happens', () => {
  const ds = resolveOpenAiCompatContent('deepseek-v4-flash', {
    content: '',
    reasoning_content: 'final answer lives here',
  });
  assert.equal(ds.content, 'final answer lives here');
  assert.equal(ds.promotedFromReasoning, true);
  assert.deepEqual(ds.contentBlockTypes, ['reasoning']);

  const prefixed = resolveOpenAiCompatContent('deepseek/deepseek-flash', {
    content: null,
    reasoning_content: 'answer',
  });
  assert.equal(prefixed.content, 'answer');
  assert.equal(prefixed.promotedFromReasoning, true);

  // Some relays use `reasoning` instead of `reasoning_content`.
  const legacyField = resolveOpenAiCompatContent('deepseek-reasoner', {
    content: null,
    reasoning: 'answer via legacy field',
  });
  assert.equal(legacyField.content, 'answer via legacy field');
  assert.equal(legacyField.promotedFromReasoning, true);
});

// ---------------------------------------------------------------------------
// Unknown family: keep the historical promote-if-empty behavior
// ---------------------------------------------------------------------------

test('unknown family: empty content + reasoning_content -> historical promotion kept', () => {
  const unk = resolveOpenAiCompatContent('some-brand-new-model', {
    content: '',
    reasoning_content: 'maybe the answer',
  });
  assert.equal(unk.content, 'maybe the answer');
  assert.equal(unk.promotedFromReasoning, true);
  assert.deepEqual(unk.contentBlockTypes, ['reasoning']);
});

// ---------------------------------------------------------------------------
// Non-empty content always wins — for every family
// ---------------------------------------------------------------------------

test('non-empty content wins for every family: no promotion, text-only blocks', () => {
  for (const model of ['glm-5.3-flash', 'glm-4.7', 'deepseek-v4-flash', 'some-brand-new-model']) {
    const res = resolveOpenAiCompatContent(model, {
      content: '  the real answer  ',
      reasoning_content: 'thinking that must not override content',
    });
    assert.equal(res.content, 'the real answer', model);
    assert.equal(res.promotedFromReasoning, false, model);
    assert.deepEqual(res.contentBlockTypes, ['text'], model);
  }
});

// ---------------------------------------------------------------------------
// Edge shapes: whitespace, empty messages, missing model
// ---------------------------------------------------------------------------

test('edge shapes: whitespace-only content counts as empty; absent fields stay safe', () => {
  // Whitespace-only content trims to empty -> deepseek promotes.
  const ws = resolveOpenAiCompatContent('deepseek-v4-flash', {
    content: '   \n  ',
    reasoning_content: 'rescued answer',
  });
  assert.equal(ws.content, 'rescued answer');
  assert.equal(ws.promotedFromReasoning, true);

  // Whitespace-only content on glm -> reasoning-only signal, still no promotion.
  const wsGlm = resolveOpenAiCompatContent('glm-5.3-flash', {
    content: ' \t ',
    reasoning_content: 'hidden thought',
  });
  assert.equal(wsGlm.content, '');
  assert.deepEqual(wsGlm.contentBlockTypes, ['reasoning']);

  // Nothing usable at all.
  const bare = resolveOpenAiCompatContent('deepseek-v4-flash', {});
  assert.equal(bare.content, '');
  assert.equal(bare.promotedFromReasoning, false);
  assert.deepEqual(bare.contentBlockTypes, []);

  // Missing message object entirely (choices[0].message absent).
  const missing = resolveOpenAiCompatContent('glm-5.3-flash', undefined);
  assert.equal(missing.content, '');
  assert.deepEqual(missing.contentBlockTypes, []);

  // Missing model id resolves as unknown family -> promotion kept.
  const noModel = resolveOpenAiCompatContent(null, { content: '', reasoning_content: 'answer' });
  assert.equal(noModel.content, 'answer');
  assert.equal(noModel.promotedFromReasoning, true);
});
