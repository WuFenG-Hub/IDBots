import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  composePromptSections,
  interpolatePromptVariables,
  PROMPT_SECTION_ORDER,
} = require('../dist-electron/main/libs/promptComposer.js');

test('composes sections in order and joins non-empty ones with blank lines', () => {
  const prompt = composePromptSections([
    { name: 'idbots:base', order: PROMPT_SECTION_ORDER.BASE, text: 'BASE' },
    { name: 'persona:metabot', order: PROMPT_SECTION_ORDER.PERSONA, text: 'PERSONA' },
    { name: 'safety:workspace', order: PROMPT_SECTION_ORDER.SAFETY, text: 'SAFETY' },
  ]);
  assert.equal(prompt, 'PERSONA\n\nSAFETY\n\nBASE');
});

test('drops null, undefined, empty, and whitespace-only sections', () => {
  const prompt = composePromptSections([
    { name: 'a', order: 0, text: 'KEEP' },
    { name: 'b', order: 1, text: null },
    { name: 'c', order: 2, text: undefined },
    { name: 'd', order: 3, text: '' },
    { name: 'e', order: 4, text: '   \n  ' },
  ]);
  assert.equal(prompt, 'KEEP');
});

test('a later section with the same name shadows the earlier one (replace, never stack)', () => {
  const prompt = composePromptSections([
    { name: 'persona:metabot', order: PROMPT_SECTION_ORDER.PERSONA, text: 'BASE PERSONA' },
    { name: 'persona:metabot', order: PROMPT_SECTION_ORDER.PERSONA, text: 'CHANNEL PERSONA' },
  ]);
  assert.equal(prompt, 'CHANNEL PERSONA');
});

test('shadowing keeps the slot position of the first registration', () => {
  const prompt = composePromptSections([
    { name: 'first', order: 10, text: 'ONE' },
    { name: 'persona:metabot', order: PROMPT_SECTION_ORDER.PERSONA, text: 'BASE' },
    { name: 'persona:metabot', order: PROMPT_SECTION_ORDER.PERSONA, text: 'SHADOW' },
    { name: 'last', order: 20, text: 'TWO' },
  ]);
  assert.equal(prompt, 'SHADOW\n\nONE\n\nTWO');
});

test('equal orders keep registration order (stable sort)', () => {
  const prompt = composePromptSections([
    { name: 'a', order: 5, text: 'FIRST' },
    { name: 'b', order: 5, text: 'SECOND' },
  ]);
  assert.equal(prompt, 'FIRST\n\nSECOND');
});

test('section text is preserved verbatim (no trimming of kept sections)', () => {
  const prompt = composePromptSections([
    { name: 'a', order: 0, text: '  padded text  ' },
  ]);
  assert.equal(prompt, '  padded text  ');
});

test('throws on a section without a name', () => {
  assert.throws(
    () => composePromptSections([{ name: '', order: 0, text: 'X' }]),
    /non-empty name/,
  );
});

test('throws on a non-finite order', () => {
  assert.throws(
    () => composePromptSections([{ name: 'a', order: Number.NaN, text: 'X' }]),
    /order must be a finite number/,
  );
});

test('order grid keeps the stable spine: identity < persona < channel < safety < base < tail', () => {
  assert.ok(PROMPT_SECTION_ORDER.IDENTITY < PROMPT_SECTION_ORDER.PERSONA);
  assert.ok(PROMPT_SECTION_ORDER.PERSONA < PROMPT_SECTION_ORDER.CHANNEL_ROLE);
  assert.ok(PROMPT_SECTION_ORDER.CHANNEL_ROLE < PROMPT_SECTION_ORDER.CHANNEL_ROSTER);
  assert.ok(PROMPT_SECTION_ORDER.CHANNEL_ROSTER < PROMPT_SECTION_ORDER.SAFETY);
  assert.ok(PROMPT_SECTION_ORDER.SAFETY < PROMPT_SECTION_ORDER.PROJECTS);
  assert.ok(PROMPT_SECTION_ORDER.PROJECTS < PROMPT_SECTION_ORDER.MEMORY_STRATEGY);
  assert.ok(PROMPT_SECTION_ORDER.MEMORY_STRATEGY < PROMPT_SECTION_ORDER.BASE);
  assert.ok(PROMPT_SECTION_ORDER.BASE < PROMPT_SECTION_ORDER.TAIL_GUARD);
});

test('interpolate substitutes known variables and does not rescan values', () => {
  const out = interpolatePromptVariables(
    'You are {{name}} (#{{id}}).',
    { name: 'MVC', id: '7' },
    'persona:metabot',
  );
  assert.equal(out, 'You are MVC (#7).');
});

test('interpolate throws on an unknown variable, naming the section', () => {
  assert.throws(
    () => interpolatePromptVariables('{{missing}}', { known: 'x' }, 'persona:metabot'),
    /unknown prompt variable "\{\{missing\}\}" in section "persona:metabot"/,
  );
});

test('interpolate throws on a registered-but-undefined variable', () => {
  assert.throws(
    () => interpolatePromptVariables('{{name}}', { name: undefined }, 'persona:metabot'),
    /has no value for this assembly/,
  );
});

test('interpolate throws on a malformed reference when a later closing brace exists', () => {
  assert.throws(
    () => interpolatePromptVariables('{{Bad Name}}', {}, 'persona:metabot'),
    /malformed prompt variable reference/,
  );
  assert.throws(
    () => interpolatePromptVariables('{{1abc}}', {}, 'persona:metabot'),
    /malformed prompt variable reference/,
  );
});

test('interpolate treats a lone {{ without any closing brace as literal prose', () => {
  const out = interpolatePromptVariables('a {{ literal brace', {}, 'persona:metabot');
  assert.equal(out, 'a {{ literal brace');
});
