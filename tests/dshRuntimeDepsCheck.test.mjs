import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { checkDshRuntimeDeps } = require('../scripts/check-dsh-runtime-deps.cjs');

// Builds a consistent lockfile from the declared deps: the top-level block
// mirrors package.json and every exact pin resolves to itself. Individual
// tests then corrupt exactly one aspect.
function writeLock(runtimeDir, deps, { lockTopOverrides = {}, resolvedOverrides = {} } = {}) {
  const lockTop = { ...deps, ...lockTopOverrides };
  for (const name of Object.keys(lockTopOverrides)) {
    if (lockTopOverrides[name] === null) delete lockTop[name];
  }
  const packages = { '': { dependencies: lockTop } };
  for (const [name, spec] of Object.entries(deps)) {
    packages[`node_modules/${name}`] = { version: resolvedOverrides[name] ?? spec };
  }
  fs.writeFileSync(
    path.join(runtimeDir, 'package-lock.json'),
    JSON.stringify({ name: 'idbots-dsh-runtime', lockfileVersion: 3, packages }),
  );
}

function makeFixture({ deps, installed, lock } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-deps-check-'));
  const runtimeDir = path.join(root, 'dsh-runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(
    path.join(runtimeDir, 'package.json'),
    JSON.stringify({ name: 'idbots-dsh-runtime', dependencies: deps }),
  );
  writeLock(runtimeDir, deps, lock);
  if (installed) {
    for (const [name, version] of Object.entries(installed)) {
      const pkgDir = path.join(runtimeDir, 'node_modules', name);
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, version }));
    }
  }
  return root;
}

test('ok when every declared dependency is installed at the pinned version', () => {
  const root = makeFixture({
    deps: { '@deepseek-ai/dsh-agent': '0.1.1-rc.2' },
    installed: { '@deepseek-ai/dsh-agent': '0.1.1-rc.2' },
  });
  const result = checkDshRuntimeDeps(root);
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.lockProblems, []);
});

test('fails when node_modules is missing entirely (fresh checkout)', () => {
  const root = makeFixture({ deps: { '@deepseek-ai/dsh-agent': '0.1.1-rc.2' }, installed: null });
  const result = checkDshRuntimeDeps(root);
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /node_modules does not exist/);
});

test('fails when a declared dependency is not installed', () => {
  const root = makeFixture({
    deps: { '@deepseek-ai/dsh-agent': '0.1.1-rc.2', '@deepseek-ai/dsh-attachment-local': '0.1.1-rc.2' },
    installed: { '@deepseek-ai/dsh-agent': '0.1.1-rc.2' },
  });
  const result = checkDshRuntimeDeps(root);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes('@deepseek-ai/dsh-attachment-local') && p.includes('not installed')));
});

test('fails when an installed version is stale after a kernel bump', () => {
  const root = makeFixture({
    deps: { '@deepseek-ai/dsh-agent': '0.1.1-rc.2' },
    installed: { '@deepseek-ai/dsh-agent': '0.1.0-rc.8' },
  });
  const result = checkDshRuntimeDeps(root);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes('installed 0.1.0-rc.8') && p.includes('required 0.1.1-rc.2')));
});

test('extra installed packages not in package.json do not fail the check', () => {
  const root = makeFixture({
    deps: { '@deepseek-ai/dsh-agent': '0.1.1-rc.2' },
    installed: { '@deepseek-ai/dsh-agent': '0.1.1-rc.2', 'left-over-pkg': '9.9.9' },
  });
  assert.equal(checkDshRuntimeDeps(root).ok, true);
});

test('ranged specs only require presence, not an exact version', () => {
  const root = makeFixture({
    deps: { 'node-addon-require-builtin': '^0.1.4' },
    installed: { 'node-addon-require-builtin': '0.1.5' },
  });
  assert.equal(checkDshRuntimeDeps(root).ok, true);
});

test('fails when the lockfile top-level block still pins the previous version (2026-09-06 incident shape)', () => {
  const root = makeFixture({
    deps: { '@deepseek-ai/dsh-agent': '0.1.2-rc.1' },
    installed: { '@deepseek-ai/dsh-agent': '0.1.2-rc.1' },
    lock: { lockTopOverrides: { '@deepseek-ai/dsh-agent': '0.1.3-alpha.1' } },
  });
  const result = checkDshRuntimeDeps(root);
  assert.equal(result.ok, false);
  assert.ok(
    result.lockProblems.some((p) =>
      p.includes('package.json pins 0.1.2-rc.1') && p.includes('top-level block says 0.1.3-alpha.1')),
  );
});

test('fails when a declared dependency is absent from the lockfile top-level block', () => {
  const root = makeFixture({
    deps: { '@deepseek-ai/dsh-agent': '0.1.2-rc.1' },
    installed: { '@deepseek-ai/dsh-agent': '0.1.2-rc.1' },
    lock: { lockTopOverrides: { '@deepseek-ai/dsh-agent': null } },
  });
  const result = checkDshRuntimeDeps(root);
  assert.equal(result.ok, false);
  assert.ok(result.lockProblems.some((p) => p.includes('absent from the lockfile top-level block')));
});

test('fails when the lockfile resolves a version other than the exact pin', () => {
  const root = makeFixture({
    deps: { '@deepseek-ai/dsh-agent': '0.1.2-rc.1' },
    installed: { '@deepseek-ai/dsh-agent': '0.1.2-rc.1' },
    lock: { resolvedOverrides: { '@deepseek-ai/dsh-agent': '0.1.3-alpha.1' } },
  });
  const result = checkDshRuntimeDeps(root);
  assert.equal(result.ok, false);
  assert.ok(result.lockProblems.some((p) => p.includes('pinned 0.1.2-rc.1') && p.includes('resolves 0.1.3-alpha.1')));
});

test('fails when the lockfile is missing entirely', () => {
  const root = makeFixture({ deps: { '@deepseek-ai/dsh-agent': '0.1.2-rc.1' }, installed: null });
  fs.rmSync(path.join(root, 'dsh-runtime', 'package-lock.json'));
  const result = checkDshRuntimeDeps(root);
  assert.equal(result.ok, false);
  assert.ok(result.lockProblems.some((p) => p.includes('package-lock.json is missing')));
});

test('the real repository checkout currently passes the gate', () => {
  const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const result = checkDshRuntimeDeps(projectRoot);
  assert.equal(result.ok, true, [...result.lockProblems, ...result.problems].join('\n'));
});
