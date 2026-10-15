import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Regression guard for "the cerebellum free-quota line showed the CHAT pool
// number": the relay backend reports two weekly pools over one endpoint
// (quota* = chat, jevQuota* = cerebellum/JEV), and the cerebellum settings
// area used to bind quotaRemaining — so cerebellum usage never moved the
// displayed number and an exhausted JEV pool still showed 5,000,000 tokens.
// These assertions pin the corrected binding in Settings.tsx: prefer the JEV
// pool when the backend reports it, fall back to the shared chat number only
// for legacy single-pool backends (jevQuotaTotal = 0).

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('the cerebellum quota line binds the JEV pool with a legacy fallback', () => {
  const source = read('src/renderer/components/Settings.tsx');
  const loaderStart = source.indexOf('const loadCerebellumFreeQuota');
  assert.ok(loaderStart > 0, 'loadCerebellumFreeQuota should exist');
  const loaderEnd = source.indexOf('}, []);', loaderStart);
  const loader = source.slice(loaderStart, loaderEnd);
  assert.match(
    loader,
    /quota\.jevQuotaTotal > 0 \? quota\.jevQuotaRemaining : quota\.quotaRemaining/,
    'the cerebellum line must display jevQuotaRemaining when the backend reports a JEV pool',
  );
});

test('the chat free-quota card keeps binding the chat pool number', () => {
  const source = read('src/renderer/components/FreeQuotaCard.tsx');
  assert.match(source, /quotaRemaining/);
  assert.doesNotMatch(source, /jevQuota/, 'the chat card must not consume the JEV pool fields');
});
