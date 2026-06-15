import test from 'node:test';
import assert from 'node:assert/strict';

const {
  buildCoworkSessionLink,
  copyCoworkSessionLinkToClipboard,
} = await import('../src/renderer/components/cowork/coworkSessionLink.js');

test('buildCoworkSessionLink trims a session id into an IDBots link', () => {
  assert.equal(buildCoworkSessionLink(' session-123 '), 'IDBots://session-123');
});

test('buildCoworkSessionLink returns an empty string for empty or non-string input', () => {
  assert.equal(buildCoworkSessionLink(''), '');
  assert.equal(buildCoworkSessionLink('   '), '');
  assert.equal(buildCoworkSessionLink(null), '');
});

test('copyCoworkSessionLinkToClipboard writes the formatted link and returns true', () => {
  const writes = [];
  const clipboard = {
    writeText(value) {
      writes.push(value);
    },
  };

  assert.equal(copyCoworkSessionLinkToClipboard('session-123', clipboard), true);
  assert.deepEqual(writes, ['IDBots://session-123']);
});

test('copyCoworkSessionLinkToClipboard returns false for a whitespace session id', () => {
  const writes = [];
  const clipboard = {
    writeText(value) {
      writes.push(value);
    },
  };

  assert.equal(copyCoworkSessionLinkToClipboard('   ', clipboard), false);
  assert.deepEqual(writes, []);
});

test('copyCoworkSessionLinkToClipboard returns false without a usable clipboard', () => {
  assert.equal(copyCoworkSessionLinkToClipboard('session-123', null), false);
  assert.equal(copyCoworkSessionLinkToClipboard('session-123', {}), false);
});
