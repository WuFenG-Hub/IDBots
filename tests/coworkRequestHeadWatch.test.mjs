import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  compareRequestHead,
  fingerprintRequestHead,
  fingerprintText,
  isMainLoopRequestHead,
} = require('../dist-electron/main/libs/coworkRequestHeadWatch.js');

test('fingerprintText is deterministic and byte-sensitive', () => {
  assert.equal(fingerprintText('abc'), fingerprintText('abc'));
  assert.notEqual(fingerprintText('abc'), fingerprintText('abd'));
});

test('fingerprintRequestHead covers system and tools independently', () => {
  const headA = fingerprintRequestHead('system-a', [{ type: 'function', function: { name: 't1' } }]);
  const headSame = fingerprintRequestHead('system-a', [{ type: 'function', function: { name: 't1' } }]);
  const headSystemChanged = fingerprintRequestHead('system-b', [{ type: 'function', function: { name: 't1' } }]);
  const headToolsChanged = fingerprintRequestHead('system-a', [{ type: 'function', function: { name: 't2' } }]);
  assert.deepEqual(headA, headSame);
  assert.notEqual(headA.systemHash, headSystemChanged.systemHash);
  assert.equal(headA.toolsHash, headSystemChanged.toolsHash);
  assert.notEqual(headA.toolsHash, headToolsChanged.toolsHash);
});

test('fingerprintRequestHead treats missing tools as a stable empty value', () => {
  assert.equal(fingerprintRequestHead('system-a', undefined).toolsHash, fingerprintRequestHead('system-a', undefined).toolsHash);
});

test('isMainLoopRequestHead matches only the IDBots-assembled system signature', () => {
  assert.equal(isMainLoopRequestHead('## Workspace Safety Policy (Highest Priority)\n...'), true);
  assert.equal(isMainLoopRequestHead('You are a subagent...'), false);
  assert.equal(isMainLoopRequestHead(''), false);
});

test('compareRequestHead returns null without a baseline or without change', () => {
  const head = fingerprintRequestHead('system-a', []);
  assert.equal(compareRequestHead(undefined, head), null);
  assert.equal(compareRequestHead(head, fingerprintRequestHead('system-a', [])), null);
});

test('compareRequestHead classifies drift kind by changed part', () => {
  const baseline = fingerprintRequestHead('system-a', [{ type: 'function', function: { name: 't1' } }]);
  const systemOnly = compareRequestHead(baseline, fingerprintRequestHead('system-b', [{ type: 'function', function: { name: 't1' } }]));
  const toolsOnly = compareRequestHead(baseline, fingerprintRequestHead('system-a', [{ type: 'function', function: { name: 't2' } }]));
  const both = compareRequestHead(baseline, fingerprintRequestHead('system-b', [{ type: 'function', function: { name: 't2' } }]));
  assert.equal(systemOnly?.kind, 'system');
  assert.equal(toolsOnly?.kind, 'tools');
  assert.equal(both?.kind, 'both');
  assert.equal(both?.previous.systemHash, baseline.systemHash);
  assert.equal(both?.next.toolsHash, fingerprintRequestHead('system-b', [{ type: 'function', function: { name: 't2' } }]).toolsHash);
});
