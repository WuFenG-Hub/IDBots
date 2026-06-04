import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { resolveMetaFileUploadSharedModulePath } from '../src/main/services/metaFileUploadSharedResolver';

test('resolveMetaFileUploadSharedModulePath finds tsc service output from a Vite main-process bundle', () => {
  const appPath = path.resolve('/repo/IDBots');
  const moduleDir = path.join(appPath, 'dist-electron');
  const expected = path.join(appPath, 'dist-electron', 'main', 'services', 'metaFileUploadShared.js');
  const existing = new Set<string>([expected]);

  const resolved = resolveMetaFileUploadSharedModulePath({
    moduleDir,
    appPath,
    exists: (candidate) => existing.has(candidate),
  });

  assert.equal(resolved, expected);
});
