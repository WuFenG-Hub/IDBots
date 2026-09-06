// Regression tests for macOS hdiutil mount-point parsing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getPath: () => '/tmp',
        relaunch: () => {},
        quit: () => {},
      },
      session: {
        defaultSession: {
          fetch: async () => {
            throw new Error('fetch not stubbed');
          },
        },
      },
    };
  }
  return originalLoad.apply(this, arguments);
};
const installer = require('../dist-electron/main/libs/appUpdateInstaller.js');
Module._load = originalLoad;

test('finds a mounted volume before trailing device rows', () => {
  const output = [
    '/dev/disk10\tEF57347C-0000-11AA-AA11-0030654',
    '/dev/disk10s1   Apple_APFS   /Volumes/IDBots 0.6.2-arm64',
    '/dev/disk9\tGUID_partition_scheme',
    '/dev/disk9s1\tApple_APFS',
  ].join('\n');

  assert.equal(
    installer.parseHdiutilMountPoint(output),
    '/Volumes/IDBots 0.6.2-arm64',
  );
});

test('returns null when hdiutil output has no mounted volume', () => {
  assert.equal(
    installer.parseHdiutilMountPoint('/dev/disk9\tGUID_partition_scheme\n'),
    null,
  );
});
