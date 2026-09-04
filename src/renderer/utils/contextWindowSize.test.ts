import test from 'node:test';
import assert from 'node:assert/strict';

import { formatContextWindowSize, parseContextWindowSizeInput } from './contextWindowSize';

test('parseContextWindowSizeInput accepts raw token counts', () => {
  assert.equal(parseContextWindowSizeInput('128000'), 128000);
  assert.equal(parseContextWindowSizeInput(' 1024000 '), 1024000);
});

test('parseContextWindowSizeInput accepts K / M shorthand', () => {
  assert.equal(parseContextWindowSizeInput('128K'), 128000);
  assert.equal(parseContextWindowSizeInput('128k'), 128000);
  assert.equal(parseContextWindowSizeInput('1024K'), 1024000);
  assert.equal(parseContextWindowSizeInput('1M'), 1000000);
  assert.equal(parseContextWindowSizeInput('2 m'), 2000000);
});

test('parseContextWindowSizeInput treats empty input as unset', () => {
  assert.equal(parseContextWindowSizeInput(''), undefined);
  assert.equal(parseContextWindowSizeInput('   '), undefined);
});

test('parseContextWindowSizeInput rejects malformed or out-of-range values', () => {
  assert.equal(parseContextWindowSizeInput('abc'), null);
  assert.equal(parseContextWindowSizeInput('-128K'), null);
  assert.equal(parseContextWindowSizeInput('0'), null);
  assert.equal(parseContextWindowSizeInput('128 K'), 128000);
  assert.equal(parseContextWindowSizeInput('1e6'), null);
  assert.equal(parseContextWindowSizeInput('999999999999'), null);
});

test('formatContextWindowSize renders compact forms', () => {
  assert.equal(formatContextWindowSize(128000), '128K');
  assert.equal(formatContextWindowSize(1000000), '1M');
  assert.equal(formatContextWindowSize(1_234_567), '1234567');
  assert.equal(formatContextWindowSize(0), '');
  assert.equal(formatContextWindowSize(-5), '');
});
