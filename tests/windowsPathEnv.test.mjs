// Windows DSH bash lookup: packaged mingit must win over Start-menu Path.
// Requires: npm run compile:electron

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  pathValueOf,
  assignPathValue,
  collapseWindowsPathKeys,
  mergeDshRuntimeProcessEnv,
} = require(path.join(here, '..', 'dist-electron', 'main', 'libs', 'windowsPathEnv.js'));

test('pathValueOf prefers PATH over Path', () => {
  assert.equal(pathValueOf({ PATH: 'a' }), 'a');
  assert.equal(pathValueOf({ Path: 'b' }), 'b');
  assert.equal(pathValueOf({ PATH: 'a', Path: 'b' }), 'a');
});

test('assignPathValue drops Path and writes PATH', () => {
  const env = { Path: 'old', FOO: '1' };
  assignPathValue(env, 'new');
  assert.equal(env.Path, undefined);
  assert.equal(env.PATH, 'new');
  assert.equal(env.FOO, '1');
});

test('collapseWindowsPathKeys prefers later injected PATH over inherited Path', () => {
  const env = {
    Path: 'C:\\Windows\\system32',
    ComSpec: 'cmd.exe',
    PATH: 'C:\\mingit\\usr\\bin;C:\\Windows\\system32',
  };
  collapseWindowsPathKeys(env, 'win32');
  assert.equal(env.Path, undefined);
  assert.equal(env.PATH, 'C:\\mingit\\usr\\bin;C:\\Windows\\system32');
  assert.equal(env.ComSpec, 'cmd.exe');
});

test('collapseWindowsPathKeys is a no-op off Windows', () => {
  const env = { Path: 'keep-me', PATH: 'other' };
  collapseWindowsPathKeys(env, 'darwin');
  assert.equal(env.Path, 'keep-me');
  assert.equal(env.PATH, 'other');
});

test('mergeDshRuntimeProcessEnv lets injected mingit PATH win on Windows', () => {
  const merged = mergeDshRuntimeProcessEnv({
    parentEnv: { Path: 'C:\\Windows\\system32', USERNAME: 'bob' },
    configEnv: {
      PATH: 'C:\\IDBots\\resources\\mingit\\usr\\bin;C:\\Windows\\system32',
      SKILLS_ROOT: 'C:\\skills',
    },
    platform: 'win32',
  });
  assert.equal(merged.Path, undefined);
  assert.match(String(merged.PATH), /mingit/);
  assert.equal(merged.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(merged.SKILLS_ROOT, 'C:\\skills');
  assert.equal(merged.USERNAME, 'bob');
});
