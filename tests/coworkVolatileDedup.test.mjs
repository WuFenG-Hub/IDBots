import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  applyVolatileDedup,
  createVolatileDedupState,
  hashVolatileSection,
} = require('../dist-electron/main/libs/coworkVolatileDedup.js');

const section = (key, text, alwaysInject) => ({ key, text, ...(alwaysInject ? { alwaysInject } : {}) });

test('first injection keeps every non-empty section in order', () => {
  const state = createVolatileDedupState('gen-1');
  const kept = applyVolatileDedup([
    section('browser', 'tabs-a'),
    section('remote-services', 'services-a'),
    section('browser-empty', '   '),
  ], state);
  assert.deepEqual(kept, ['tabs-a', 'services-a']);
});

test('an identical second pass omits every unchanged section', () => {
  const state = createVolatileDedupState('gen-1');
  const sections = [
    section('browser', 'tabs-a'),
    section('remote-services', 'services-a'),
  ];
  applyVolatileDedup(sections, state);
  assert.deepEqual(applyVolatileDedup(sections, state), []);
});

test('a changed section is re-injected while unchanged ones stay omitted', () => {
  const state = createVolatileDedupState('gen-1');
  applyVolatileDedup([
    section('browser', 'tabs-a'),
    section('remote-services', 'services-a'),
  ], state);
  const kept = applyVolatileDedup([
    section('browser', 'tabs-a'),
    section('remote-services', 'services-b'),
  ], state);
  assert.deepEqual(kept, ['services-b']);
});

test('a section that changed away and changed back is re-injected (retained-hash semantics)', () => {
  const state = createVolatileDedupState('gen-1');
  applyVolatileDedup([section('browser', 'tabs-a')], state);
  applyVolatileDedup([section('browser', 'tabs-b')], state);
  assert.deepEqual(applyVolatileDedup([section('browser', 'tabs-a')], state), ['tabs-a']);
});

test('alwaysInject sections are kept even when byte-identical', () => {
  const state = createVolatileDedupState('gen-1');
  const memory = section('memory', 'memory-block-a', true);
  applyVolatileDedup([memory], state);
  assert.deepEqual(applyVolatileDedup([memory], state), ['memory-block-a']);
});

test('hash function is deterministic and byte-sensitive', () => {
  assert.equal(hashVolatileSection('abc'), hashVolatileSection('abc'));
  assert.notEqual(hashVolatileSection('abc'), hashVolatileSection('abd'));
});
