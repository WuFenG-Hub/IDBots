import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { resolveMainWorkerPath } from '../src/main/services/workerPathResolver';

test('resolveMainWorkerPath finds tsc worker output from a Vite main-process bundle', () => {
  const appPath = path.resolve('/repo/IDBots');
  const moduleDir = path.join(appPath, 'dist-electron');
  const expected = path.join(appPath, 'dist-electron', 'main', 'libs', 'createPinWorker.js');
  const existing = new Set<string>([expected]);

  const resolved = resolveMainWorkerPath({
    moduleDir,
    appPath,
    workerBasename: 'createPinWorker.js',
    exists: (candidate) => existing.has(candidate),
  });

  assert.equal(resolved, expected);
});

test('resolveMainWorkerPath keeps the tsc service-module fallback first', () => {
  const appPath = path.resolve('/repo/IDBots');
  const moduleDir = path.join(appPath, 'dist-electron', 'main', 'services');
  const expected = path.join(appPath, 'dist-electron', 'main', 'libs', 'transferMvcWorker.js');
  const existing = new Set<string>([expected]);

  const resolved = resolveMainWorkerPath({
    moduleDir,
    appPath,
    workerBasename: 'transferMvcWorker.js',
    exists: (candidate) => existing.has(candidate),
  });

  assert.equal(resolved, expected);
});
