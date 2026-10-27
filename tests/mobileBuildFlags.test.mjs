import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildFlagsUrl = new URL('../src/mobile/buildFlags.ts', import.meta.url).href;

function readMockFlag(nodeEnv, mockEnv) {
  const env = { ...process.env, NODE_ENV: nodeEnv };
  if (mockEnv === undefined) delete env.VITE_MOBILE_MOCK;
  else env.VITE_MOBILE_MOCK = mockEnv;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '-e', `import { MOCK_LOGIN_API } from ${JSON.stringify(buildFlagsUrl)}; console.log(MOCK_LOGIN_API);`],
    { cwd: repoRoot, env, encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('mock login is enabled only by an explicit non-production flag', () => {
  assert.equal(readMockFlag('test', '1'), 'true');
  assert.equal(readMockFlag('development', undefined), 'false');
  assert.equal(readMockFlag('production', '1'), 'false');
});
