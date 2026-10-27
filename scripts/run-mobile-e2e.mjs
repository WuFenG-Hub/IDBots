#!/usr/bin/env node
/**
 * REQ-E-26 mock-suite runner: starts the mobile dev server on the mock
 * bridge (VITE_MOBILE_MOCK=1, port 5196), waits until it answers, runs the
 * Playwright suite (both device projects), and always tears the server down.
 *
 * Usage: node scripts/run-mobile-e2e.mjs [extra playwright test args]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMobileE2eArgs } from './mobile-e2e-args.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.E2E_PORT || '5196';
const BASE_URL = `http://localhost:${PORT}`;

const viteBin = path.join(repoRoot, 'node_modules', '.bin', 'vite');
const playwrightCli = path.join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js');

function waitForServer(url, timeoutMs = 45_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(`${url}/login`, { cache: 'no-store' });
        if (res.ok) {
          resolve();
          return;
        }
      } catch {
        // not up yet
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`timed out waiting for ${url}/login`));
        return;
      }
      setTimeout(tick, 300);
    };
    tick();
  });
}

const children = [];
function cleanup() {
  for (const child of children.splice(0)) {
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
}
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});

async function main() {
  const vite = spawn(viteBin, ['--config', 'vite.mobile.config.ts', '--port', PORT, '--strictPort'], {
    cwd: repoRoot,
    env: { ...process.env, VITE_MOBILE_MOCK: '1', MOBILE_FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(vite);
  vite.stdout.on('data', () => {});
  vite.stderr.on('data', (chunk) => process.stderr.write(`[vite] ${chunk}`));

  let exitCode = 1;
  try {
    await waitForServer(BASE_URL);
    console.log(`[mobile-e2e] dev server up at ${BASE_URL} (mock bridge)`);

    const playwrightArgs = ['test', '--grep-invert', '@gateway', ...getMobileE2eArgs()];
    const run = spawn(process.execPath, [playwrightCli, ...playwrightArgs], {
      cwd: repoRoot,
      env: { ...process.env, E2E_BASE_URL: BASE_URL },
      stdio: 'inherit',
    });
    children.push(run);
    exitCode = await new Promise((resolve) => {
      run.on('exit', (code) => resolve(code ?? 1));
      run.on('error', () => resolve(1));
    });
  } finally {
    cleanup();
  }
  process.exit(exitCode);
}

main().catch((error) => {
  console.error('[mobile-e2e]', error);
  cleanup();
  process.exit(1);
});
