import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { checkDshRuntimeDeps } = require('../scripts/check-dsh-runtime-deps.cjs');

function makeFixture({ deps, installed }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-deps-check-'));
  const runtimeDir = path.join(root, 'dsh-runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(
    path.join(runtimeDir, 'package.json'),
    JSON.stringify({ name: 'idbots-dsh-runtime', dependencies: deps }),
  );
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

test('the real repository checkout currently passes the gate', () => {
  const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const result = checkDshRuntimeDeps(projectRoot);
  assert.equal(result.ok, true, result.problems.join('\n'));
});
