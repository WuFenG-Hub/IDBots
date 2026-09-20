#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Preflight gate: verify dsh-runtime/node_modules AND dsh-runtime/pnpm-lock.yaml
 * match dsh-runtime/package.json.
 *
 * The DSH runtime is a nested pnpm package spawned as a standalone Node process by
 * the Electron main process. Its node_modules is NOT tracked in git, so after
 * pulling or merging a commit that bumps dsh-runtime dependencies, the on-disk
 * install is silently stale until someone reruns `pnpm --dir dsh-runtime install`
 * (only wired into the root postinstall, which does not run on git pull/merge).
 * A stale install crashes the runtime at plugin-load time with cryptic
 * ERR_MODULE_NOT_FOUND errors. This script fails fast with a clear remediation.
 *
 * The lockfile half (2026-09-06 incident): a version bump edited
 * dsh-runtime/package.json but landed without regenerating pnpm-lock.yaml,
 * leaving the lock's importer block at the old version. That state passes
 * review silently but makes `pnpm --dir dsh-runtime install --frozen-lockfile`
 * fail with ERR_PNPM_OUTDATED_LOCKFILE. The lockfile IS tracked in git, so its
 * sync with package.json is checked here too — before anyone wastes a cycle on
 * the broken clean reinstall path.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REMEDIATION =
  'Run: pnpm --dir dsh-runtime install   (or: pnpm --dir dsh-runtime install --frozen-lockfile for a clean reinstall)';
const REMEDIATION_LOCK =
  'Regenerate with: pnpm --dir dsh-runtime install   ' +
  '(never hand-edit the lockfile; commit dsh-runtime/package.json and pnpm-lock.yaml in the SAME commit)';
const REMEDIATION_PATCH =
  'Run: node scripts/apply-dsh-kernel-patches.cjs   ' +
  '(applies scripts/dsh-kernel-patches/*.patch to the installed kernel packages; ' +
  'also runs automatically in the root postinstall)';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readYaml(filePath) {
  let yaml;
  try {
    yaml = require('js-yaml');
  } catch (err) {
    throw new Error(`cannot load js-yaml (install root dependencies first): ${err.message}`);
  }
  return yaml.load(fs.readFileSync(filePath, 'utf8'));
}

const EXACT_SPEC = /^\d+\.\d+\.\d+(\S*)$/;

// pnpm records peer-suffix annotations on resolved versions
// (e.g. `0.1.5-rc.2(zod@4.3.6)`); the plain semver is what gets installed.
function stripPeerSuffix(version) {
  return String(version).replace(/\(.*\)$/, '');
}

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

  const lockPath = path.join(runtimeDir, 'pnpm-lock.yaml');
  if (!fs.existsSync(lockPath)) {
    lockProblems.push('dsh-runtime/pnpm-lock.yaml is missing (tracked file — restore it from git)');
  } else {
    // The importer block is the pnpm equivalent of the npm lock's top-level
    // `packages[""]` block: one entry per direct dependency carrying both the
    // declared specifier and the resolved version.
    const lock = readYaml(lockPath);
    const lockTop = lock?.importers?.['.']?.dependencies || {};
    for (const [name, spec] of Object.entries(declared)) {
      const lockSpec = lockTop[name]?.specifier;
      if (lockSpec === undefined) {
        lockProblems.push(`${name}@${spec}: declared in package.json but absent from the lockfile importer block`);
      } else if (lockSpec !== spec) {
        lockProblems.push(`${name}: package.json pins ${spec} but the lockfile importer block says ${lockSpec}`);
      }
    }
    for (const name of Object.keys(lockTop)) {
      if (!(name in declared)) {
        lockProblems.push(`${name}: in the lockfile importer block but not declared in package.json`);
      }
    }
    // Exact pins must also be what the lock actually resolved and would install.
    for (const [name, spec] of Object.entries(declared)) {
      if (!EXACT_SPEC.test(spec)) continue;
      const resolved = lockTop[name]?.version;
      if (resolved !== undefined && stripPeerSuffix(resolved) !== spec) {
        lockProblems.push(`${name}: pinned ${spec} but the lockfile resolves ${stripPeerSuffix(resolved)}`);
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
    // Ranged specs (^/~) only require presence; pnpm already resolves them.
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
  if (!ok) {
    if (lockProblems.length > 0) {
      console.error('[FAIL] dsh-runtime/pnpm-lock.yaml is out of sync with package.json:');
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
  console.log('[PASS] dsh-runtime dependencies match package.json');

  // Kernel patches are part of the install state: a node_modules refresh that
  // skips them would ship the upstream defects the patches exist to fix.
  const patches = spawnSync(process.execPath, [path.join(__dirname, 'apply-dsh-kernel-patches.cjs'), '--check'], {
    stdio: 'inherit',
  });
  if (patches.status !== 0) {
    console.error('[FAIL] dsh-runtime kernel patches are not applied:');
    console.error(REMEDIATION_PATCH);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { checkDshRuntimeDeps };
