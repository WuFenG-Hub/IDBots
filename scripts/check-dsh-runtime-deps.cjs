#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Preflight gate: verify dsh-runtime/node_modules AND dsh-runtime/package-lock.json
 * match dsh-runtime/package.json.
 *
 * The DSH runtime is a nested npm package spawned as a standalone Node process by
 * the Electron main process. Its node_modules is NOT tracked in git, so after
 * pulling or merging a commit that bumps dsh-runtime dependencies, the on-disk
 * install is silently stale until someone reruns `npm install --prefix dsh-runtime`
 * (only wired into the root postinstall, which does not run on git pull/merge).
 * A stale install crashes the runtime at plugin-load time with cryptic
 * ERR_MODULE_NOT_FOUND errors. This script fails fast with a clear remediation.
 *
 * The lockfile half (2026-09-06 incident): a version bump edited
 * dsh-runtime/package.json but landed without regenerating package-lock.json,
 * leaving the lock's top-level dependencies block at the old version. That
 * state passes review silently but makes `npm ci --prefix dsh-runtime` fail
 * with EUSAGE. The lockfile IS tracked in git, so its sync with package.json
 * is checked here too — before anyone wastes a cycle on the broken clean
 * reinstall path.
 */
const fs = require('fs');
const path = require('path');

const REMEDIATION =
  'Run: npm install --prefix dsh-runtime   (or: npm ci --prefix dsh-runtime for a clean reinstall)';
const REMEDIATION_LOCK =
  'Regenerate with: npm install --prefix dsh-runtime   ' +
  '(never hand-edit the lockfile; commit dsh-runtime/package.json and package-lock.json in the SAME commit)';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const EXACT_SPEC = /^\d+\.\d+\.\d+(\S*)$/;

/**
 * @param {string} projectRoot repository root containing dsh-runtime/
 * @returns {{ ok: boolean, problems: string[], lockProblems: string[] }}
 */
function checkDshRuntimeDeps(projectRoot) {
  const runtimeDir = path.join(projectRoot, 'dsh-runtime');
  const problems = [];
  const lockProblems = [];

  const pkgPath = path.join(runtimeDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return { ok: false, problems: [`missing ${pkgPath}`], lockProblems };
  }
  const declared = readJson(pkgPath).dependencies || {};

  const lockPath = path.join(runtimeDir, 'package-lock.json');
  if (!fs.existsSync(lockPath)) {
    lockProblems.push('dsh-runtime/package-lock.json is missing (tracked file — restore it from git)');
  } else {
    const lockPackages = readJson(lockPath).packages || {};
    const lockTop = (lockPackages[''] || {}).dependencies || {};
    for (const [name, spec] of Object.entries(declared)) {
      const lockSpec = lockTop[name];
      if (lockSpec === undefined) {
        lockProblems.push(`${name}@${spec}: declared in package.json but absent from the lockfile top-level block`);
      } else if (lockSpec !== spec) {
        lockProblems.push(`${name}: package.json pins ${spec} but the lockfile top-level block says ${lockSpec}`);
      }
    }
    for (const name of Object.keys(lockTop)) {
      if (!(name in declared)) {
        lockProblems.push(`${name}: in the lockfile top-level block but not declared in package.json`);
      }
    }
    // Exact pins must also be what the lock actually resolved and would install.
    for (const [name, spec] of Object.entries(declared)) {
      if (!EXACT_SPEC.test(spec)) continue;
      const entry = lockPackages[`node_modules/${name}`];
      if (entry && entry.version !== spec) {
        lockProblems.push(`${name}: pinned ${spec} but the lockfile resolves ${entry.version}`);
      }
    }
  }

  const nodeModulesDir = path.join(runtimeDir, 'node_modules');
  if (!fs.existsSync(nodeModulesDir)) {
    problems.push('dsh-runtime/node_modules does not exist (fresh checkout?)');
    return { ok: false, problems, lockProblems };
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
    if (EXACT_SPEC.test(spec)) {
      const installedVersion = readJson(installedPkgPath).version;
      if (installedVersion !== spec) {
        problems.push(`${name}: installed ${installedVersion}, required ${spec}`);
      }
    }
  }

  return { ok: problems.length === 0 && lockProblems.length === 0, problems, lockProblems };
}

function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const { ok, problems, lockProblems } = checkDshRuntimeDeps(projectRoot);
  if (ok) {
    console.log('[PASS] dsh-runtime dependencies match package.json');
    return;
  }
  if (lockProblems.length > 0) {
    console.error('[FAIL] dsh-runtime/package-lock.json is out of sync with package.json:');
    for (const problem of lockProblems) {
      console.error(`  - ${problem}`);
    }
    console.error(REMEDIATION_LOCK);
  }
  if (problems.length > 0) {
    console.error('[FAIL] dsh-runtime/node_modules is stale or incomplete:');
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    console.error(REMEDIATION);
  }
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = { checkDshRuntimeDeps };
