// Semver precedence for the app updater version comparison.
//
// Regression coverage for the v1.0.0 GA release: the previous parser cut
// "1.0.0-rc.4" into [1,0,0,4] and judged it newer than "1.0.0", so a
// machine that manually installed 1.0.0 was pulled back down to rc.4, and
// once update.json switched to 1.0.0 the rc.4 machines no longer saw the
// update. Loads the dependency-free renderer module directly with Node's
// native TypeScript type stripping.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compareVersions,
  toVersionParts,
} from '../src/renderer/services/versionCompare.ts';

test('a release outranks any prerelease of the same core', () => {
  // current 1.0.0, server offers 1.0.0-rc.4 -> never downgrade
  assert.ok(compareVersions('1.0.0-rc.4', '1.0.0') < 0);
  // current 1.0.0-rc.4, server offers 1.0.0 -> update becomes visible
  assert.ok(compareVersions('1.0.0', '1.0.0-rc.4') > 0);
});

test('prerelease identifiers follow semver §11 precedence', () => {
  assert.ok(compareVersions('1.0.0-rc.3', '1.0.0-rc.4') < 0);
  // numeric identifiers compare numerically, not lexicographically
  assert.ok(compareVersions('1.0.0-rc.4', '1.0.0-rc.10') < 0);
  assert.ok(compareVersions('1.0.0-rc.10', '1.0.0-rc.4') > 0);
  // a shorter identifier list that is a prefix of the other ranks lower
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0-alpha.1') < 0);
  // numeric identifiers always rank below alphanumeric ones
  assert.ok(compareVersions('1.0.0-1', '1.0.0-alpha') < 0);
  // alphanumeric identifiers compare lexically
  assert.ok(compareVersions('1.0.0-rc.1', '1.0.0-alpha.1') > 0);
});

test('core versions keep the legacy numeric comparison', () => {
  assert.ok(compareVersions('1.0.0', '0.9.9') > 0);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.ok(compareVersions('1.0.1', '1.0') > 0);
  // a shorter core pads with zeros
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.ok(compareVersions('10.0.0', '9.9.9') > 0);
  // extra numeric segments keep participating in the core comparison
  assert.ok(compareVersions('1.0.0.1', '1.0.0') > 0);
});

test('build metadata is ignored', () => {
  assert.equal(compareVersions('1.0.0+build.5', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0', '1.0.0+build.5'), 0);
  assert.equal(compareVersions('1.0.0-rc.4+build.7', '1.0.0-rc.4'), 0);
});

test('toVersionParts keeps the legacy core parse', () => {
  assert.deepEqual(toVersionParts('1.0.0'), [1, 0, 0]);
  assert.deepEqual(toVersionParts('1.0.0-rc.4'), [1, 0, 0]);
  assert.deepEqual(toVersionParts('1.0'), [1, 0]);
  assert.deepEqual(toVersionParts('v1.2.3'), [0, 2, 3]);
  // the lenient core keeps every numeric segment (no three-segment cap)
  assert.deepEqual(toVersionParts('1.0.0.1'), [1, 0, 0, 1]);
});

test('malformed and unusual inputs never throw', () => {
  const inputs = [
    '',
    'abc',
    'v1.2.3',
    '1..2',
    ' 1.0.0 ',
    '1.0.0-',
    '1.0.0-rc..4',
    '1.0.0+build',
    'rc.4',
    '-',
    '+',
    '..',
    '1.0.0-alpha.1+build.2',
  ];
  for (const input of inputs) {
    assert.doesNotThrow(() => compareVersions(input, '1.0.0'));
    assert.doesNotThrow(() => compareVersions('1.0.0', input));
    assert.doesNotThrow(() => toVersionParts(input));
  }
});

test('comparison is antisymmetric across the fixture matrix', () => {
  const matrix = [
    '1.0.0',
    '1.0.0-rc.4',
    '1.0.0-rc.10',
    '0.9.9',
    '1.0.0+build.5',
    '2.0.0-alpha',
    '1.0.0-alpha',
    '1.0.0-1',
    '1.0.1',
    '1.0.0.1',
  ];
  for (const a of matrix) {
    for (const b of matrix) {
      // === (not Object.is): -0 is a valid negation of 0
      assert.ok(compareVersions(a, b) === -compareVersions(b, a), `${a} vs ${b}`);
    }
  }
});

test('acceptance vector checklist: all 10 cross-checked cases pass', async (t) => {
  const vectors = [
    { id: 1, label: 'release outranks prerelease', a: '1.0.0-rc.4', b: '1.0.0', want: -1 },
    { id: 2, label: 'prerelease patch ordering', a: '1.0.0-rc.3', b: '1.0.0-rc.4', want: -1 },
    { id: 3, label: 'plain core ordering', a: '1.0.0', b: '0.9.9', want: 1 },
    { id: 4, label: 'identical versions compare equal', a: '1.0.0', b: '1.0.0', want: 0 },
    { id: 5, label: 'numeric prerelease identifiers compare numerically', a: '1.0.0-rc.4', b: '1.0.0-rc.10', want: -1 },
    { id: 6, label: 'build metadata is ignored', a: '1.0.0+build.5', b: '1.0.0', want: 0 },
    {
      id: 7,
      label: 'legal and malformed inputs never throw',
      a: null,
      b: '1.0.0',
      want: 'nothrow',
      samples: ['', 'abc', 'v1.2.3', '1..2', ' 1.0.0 ', '1.0.0-', '1.0.0-rc..4', '1.0.0+build', 'rc.4', '-', '+', '..', '1.0.0-alpha.1+build.2'],
    },
    { id: 8, label: 'future patch release visible from an installed prerelease', a: '1.0.1', b: '1.0.0-rc.4', want: 1 },
    // Semantic note (5F cross-check correction): a four-segment numeric
    // core [1,0,0,1] outranks the prerelease of its three-segment prefix
    // [1,0,0], and the legacy ordering "1.0.0.1 > 1.0.0" is preserved.
    // The old "1.0.0.1 < 1.0.0-rc.4" was an artifact of the buggy parser,
    // not the expected semantics.
    { id: 9, label: 'a four-segment numeric core outranks a prerelease of its prefix', a: '1.0.0.1', b: '1.0.0-rc.4', want: 1 },
    { id: 10, label: 'identity does not trigger an update', a: '1.0.0', b: '1.0.0', want: 0 },
  ];
  for (const vector of vectors) {
    await t.test(`#${vector.id} ${vector.label}`, () => {
      if (vector.want === 'nothrow') {
        for (const sample of vector.samples) {
          assert.doesNotThrow(() => compareVersions(sample, vector.b), `input ${JSON.stringify(sample)}`);
        }
      } else {
        assert.equal(
          Math.sign(compareVersions(vector.a, vector.b)),
          vector.want,
          `${vector.a} vs ${vector.b}`,
        );
      }
    });
  }
});
