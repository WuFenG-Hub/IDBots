#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Preflight gate: verify dsh-runtime/node_modules matches dsh-runtime/package.json.
 *
 * The DSH runtime is a nested npm package spawned as a standalone Node process by
 * the Electron main process. Its node_modules is NOT tracked in git, so after
 * pulling or merging a commit that bumps dsh-runtime dependencies, the on-disk
 * install is silently stale until someone reruns `npm install --prefix dsh-runtime`
 * (only wired into the root postinstall, which does not run on git pull/merge).
 * A stale install crashes the runtime at plugin-load time with cryptic
 * ERR_MODULE_NOT_FOUND errors. This script fails fast with a clear remediation.
 */
const fs = require('fs');
const path = require('path');

const REMEDIATION =
  'Run: npm install --prefix dsh-runtime   (or: npm ci --prefix dsh-runtime for a clean reinstall)';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * @param {string} projectRoot repository root containing dsh-runtime/
 * @returns {{ ok: boolean, problems: string[] }}
 */
function checkDshRuntimeDeps(projectRoot) {
  const runtimeDir = path.join(projectRoot, 'dsh-runtime');
  const problems = [];

  const pkgPath = path.join(runtimeDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return { ok: false, problems: [`missing ${pkgPath}`] };
  }
  const declared = readJson(pkgPath).dependencies || {};

  const nodeModulesDir = path.join(runtimeDir, 'node_modules');
  if (!fs.existsSync(nodeModulesDir)) {
    return {
      ok: false,
      problems: ['dsh-runtime/node_modules does not exist (fresh checkout?)'],
    };
  }

  for (const [name, spec] of Object.entries(declared)) {
    const installedPkgPath = path.join(nodeModulesDir, name, 'package.json');
    if (!fs.existsSync(installedPkgPath)) {
      problems.push(`${name}@${spec} is not installed`);
      continue;
    }
    // Exact pins (the @deepseek-ai/* kernel packages) must match exactly — a stale
    // installed version is precisely the failure this gate exists to catch.
    // Ranged specs (^/~) only require presence; npm already resolves them.
    if (/^\d+\.\d+\.\d+(\S*)$/.test(spec)) {
      const installedVersion = readJson(installedPkgPath).version;
      if (installedVersion !== spec) {
        problems.push(`${name}: installed ${installedVersion}, required ${spec}`);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const { ok, problems } = checkDshRuntimeDeps(projectRoot);
  if (ok) {
    console.log('[PASS] dsh-runtime dependencies match package.json');
    return;
  }
  console.error('[FAIL] dsh-runtime/node_modules is stale or incomplete:');
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  console.error(REMEDIATION);
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = { checkDshRuntimeDeps };
