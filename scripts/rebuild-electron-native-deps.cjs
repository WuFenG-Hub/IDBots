#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Wrap `electron-builder install-app-deps` for the pnpm era.
 *
 * electron-builder 24 detects the project package manager and rebuilds native
 * modules (bufferutil, utf-8-validate) via `pnpm rebuild ...`. When it runs
 * from a pnpm lifecycle script, pnpm sets npm_execpath to the corepack cache
 * entry (…/corepack/v1/pnpm/<ver>/bin/pnpm.cjs), which is NOT executable —
 * fork/exec fails with EACCES and the install dies. Drop npm_execpath so
 * electron-builder resolves `pnpm` from PATH (an executable shim) instead.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const env = { ...process.env };
delete env.npm_execpath;

const cli = path.join(__dirname, '..', 'node_modules', 'electron-builder', 'cli.js');
const result = spawnSync(process.execPath, [cli, 'install-app-deps', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});
process.exit(result.status === null ? 1 : result.status);
