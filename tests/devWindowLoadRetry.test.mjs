import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('dev window load timeout tolerates vite cold-start pre-bundling', () => {
  const source = read('src/main/main.ts');

  // 30s was short enough that the timeout reload aborted a healthy in-flight
  // cold-start load (dep pre-bundling of ~2000 deps takes >30s).
  assert.match(source, /const LOAD_TIMEOUT_MS = isDev \? 90000 : 30000;/);
  assert.match(source, /\}, LOAD_TIMEOUT_MS\);/);
});

test('tryLoadURL does not consume failure budget on self-inflicted ERR_ABORTED', () => {
  const source = read('src/main/main.ts');

  // The aborted branch must exist and early-return via setTimeout BEFORE
  // retryCount++ so aborted loads cannot burn the 3-retry budget.
  const abortedBranch = /const aborted =\s*\n\s*\(err as \{ code\?: unknown \} \| null \| undefined\)\?\.code === 'ERR_ABORTED' \|\|\s*\n\s*\(err as \{ errno\?: unknown \} \| null \| undefined\)\?\.errno === -3;/;
  assert.match(source, abortedBranch);
  assert.match(source, /if \(aborted && abortedRetryCount < maxAbortedRetries\) \{\s*\n\s*abortedRetryCount \+= 1;[\s\S]*?setTimeout\(tryLoadURL, 3000\);\s*\n\s*return;/);

  const abortedAt = source.search(/if \(aborted && abortedRetryCount < maxAbortedRetries\)/);
  const retryIncAt = source.search(/retryCount\+\+/);
  assert.ok(abortedAt !== -1, 'aborted guard branch exists');
  assert.ok(retryIncAt !== -1, 'failure budget counter exists');
  assert.ok(abortedAt < retryIncAt, 'aborted guard must early-return before retryCount++');
});

test('error fallback page receives the dev server URL for its Retry button', () => {
  const source = read('src/main/main.ts');

  assert.match(
    source,
    /win\.loadFile\(path\.join\(__dirname, '\.\.\/resources\/error\.html'\), \{\s*\n\s*query: \{ devServerUrl: DEV_SERVER_URL \},\s*\n\s*\}\);/
  );
});

test('did-fail-load ignores ERR_ABORTED and subframe failures', () => {
  const source = read('src/main/main.ts');

  const guardAt = source.search(/if \(errorCode === -3 \|\| !isMainFrame\) \{/);
  const reloadAt = source.search(/scheduleReload\('did-fail-load', win\.webContents\)/);
  assert.ok(guardAt !== -1, 'ERR_ABORTED/main-frame guard exists');
  assert.ok(reloadAt !== -1, 'did-fail-load reload path exists');
  assert.ok(guardAt < reloadAt, 'guard must run before scheduling a reload');
});

test('error.html Retry navigates back to the dev server when available', () => {
  const html = read('resources/error.html');

  assert.match(html, /function retryConnection\(\)/);
  assert.match(html, /new URLSearchParams\(window\.location\.search\)\.get\('devServerUrl'\)/);
  assert.match(html, /window\.location\.href = target \|\| window\.location\.href;/);
  // The old button reloaded the static error page itself, which could never
  // reach the dev server again.
  assert.doesNotMatch(html, /onclick="window\.location\.reload\(\)"/);
});
