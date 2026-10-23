import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { compareSemver, parseSemver, semverGte, semverLt } from '../src/semver.js';

describe('semver helpers', () => {
  test('parse takes major.minor.patch and ignores pre-release/build', () => {
    assert.deepEqual(parseSemver('1.2.3'), [1, 2, 3]);
    assert.deepEqual(parseSemver(' 1.2.3-rc.1 '), [1, 2, 3]);
    assert.deepEqual(parseSemver('1.2.3+build7'), [1, 2, 3]);
    assert.equal(parseSemver(''), null);
    assert.equal(parseSemver('1.2'), null);
    assert.equal(parseSemver('v1.2.3'), null);
    assert.equal(parseSemver(null), null);
  });

  test('compare orders versions', () => {
    assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
    assert.equal(compareSemver('1.0.0', '1.1.0'), -1);
    assert.equal(compareSemver('1.1.0', '1.0.0'), 1);
    assert.equal(compareSemver('1.0.10', '1.0.9'), 1);
    assert.equal(compareSemver('2.0.0', '10.0.0'), -1, 'numeric, not lexicographic');
    assert.equal(compareSemver('1.0.0-rc.1', '1.0.0'), 0, 'pre-release ignored');
  });

  test('lt / gte', () => {
    assert.equal(semverLt('1.0.0', '1.1.0'), true);
    assert.equal(semverLt('1.1.0', '1.0.0'), false);
    assert.equal(semverLt('1.0.0', '1.0.0'), false);
    assert.equal(semverGte('1.1.0', '1.0.0'), true);
    assert.equal(semverGte('1.0.0', '1.0.0'), true);
    assert.equal(semverGte('1.0.0', '1.1.0'), false);
    assert.equal(semverGte('garbage', 'garbage'), true, 'unparseable treated as equal');
  });
});
