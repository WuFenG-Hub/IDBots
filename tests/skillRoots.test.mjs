import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadSkillRoots() {
  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath() {
            return '/repo/IDBots';
          },
          getPath(name) {
            if (name === 'userData') return '/Users/me/Library/Application Support/IDBots';
            return '/tmp';
          },
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve('../dist-electron/main/libs/skillRoots.js')];
    return require('../dist-electron/main/libs/skillRoots.js');
  } finally {
    Module._load = originalLoad;
  }
}

test('writable skills root is userData/SKILLs even when unpackaged', () => {
  const { resolveWritableSkillsRoot } = loadSkillRoots();
  assert.equal(
    resolveWritableSkillsRoot({
      env: {},
      userDataPath: '/Users/me/Library/Application Support/IDBots',
    }),
    path.resolve('/Users/me/Library/Application Support/IDBots', 'SKILLs'),
  );
});

test('writable skills root does not resolve to the source SKILLs directory', () => {
  const { resolveWritableSkillsRoot } = loadSkillRoots();
  const writable = resolveWritableSkillsRoot({
    env: {},
    userDataPath: '/Users/me/Library/Application Support/IDBots',
  });
  assert.notEqual(writable, path.resolve('/repo/IDBots', 'SKILLs'));
  assert.equal(
    writable,
    path.join('/Users/me/Library/Application Support/IDBots', 'SKILLs'),
  );
});

test('IDBOTS_SKILLS_ROOT overrides userData', () => {
  const { resolveWritableSkillsRoot } = loadSkillRoots();
  assert.equal(
    resolveWritableSkillsRoot({
      env: { IDBOTS_SKILLS_ROOT: '/tmp/custom-skills' },
      userDataPath: '/Users/me/Library/Application Support/IDBots',
    }),
    path.resolve('/tmp/custom-skills'),
  );
});

test('bundled skills root is project SKILLs when unpackaged', () => {
  const { resolveBundledSkillsRoot } = loadSkillRoots();
  assert.equal(
    resolveBundledSkillsRoot({
      isPackaged: false,
      appPath: '/repo/IDBots',
      resourcesPath: '/nope',
    }),
    path.resolve('/repo/IDBots', 'SKILLs'),
  );
});

test('bundled skills root prefers Resources/SKILLs when packaged', () => {
  const { resolveBundledSkillsRoot } = loadSkillRoots();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-bundled-skills-'));
  const resourcesSkills = path.join(tmp, 'SKILLs');
  fs.mkdirSync(resourcesSkills);
  try {
    assert.equal(
      resolveBundledSkillsRoot({
        isPackaged: true,
        resourcesPath: tmp,
        appPath: '/Applications/IDBots.app/Contents/Resources/app.asar',
      }),
      path.resolve(resourcesSkills),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
