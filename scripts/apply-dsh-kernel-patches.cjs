#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Apply the committed kernel patches under scripts/dsh-kernel-patches/ to the
 * installed dsh-runtime node_modules.
 *
 * Why: some @deepseek-ai kernel packages ship Windows behavior we must fix
 * between releases (e.g. dsh-win32-process creating tool subprocesses via raw
 * CreateProcessW without CREATE_NO_WINDOW, which flashes a console window on
 * every bash tool call). The runtime is a nested npm package, so root-level
 * patch-package cannot reach it and hand-editing files would be lost on every
 * `npm install --prefix dsh-runtime`. Committed .patch files + this script
 * keep the fixes reproducible across fresh clones, CI builds (electron-builder
 * packages the patched dsh-runtime/node_modules), and kernel upgrades.
 *
 * Patch files follow the patch-package naming convention:
 *   <package-name-with-+> + <exact-version> + .patch
 * The version in the filename must equal the installed package version — an
 * upgrade:dsh that does not rebase its patches fails loudly here instead of
 * silently shipping an unpatched kernel.
 *
 * Usage:
 *   node scripts/apply-dsh-kernel-patches.cjs           # apply (idempotent)
 *   node scripts/apply-dsh-kernel-patches.cjs --check   # verify only, no writes
 *
 * Wired into: root postinstall (after `npm install --prefix dsh-runtime`),
 * check:dsh-deps gate (--check), and upgrade:dsh (re-apply after reinstall).
 * See scripts/dsh-kernel-patches/README.md for how to add or rebase patches.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PATCHES_DIR = path.join(__dirname, 'dsh-kernel-patches');
const RUNTIME_NODE_MODULES = path.join(PROJECT_ROOT, 'dsh-runtime', 'node_modules');

const CHECK_ONLY = process.argv.includes('--check');

function fail(message) {
  console.error(`[dsh-kernel-patches] ${message}`);
  process.exit(1);
}

function patchTargets(patchFile) {
  // "<name>+<version>.patch" — name itself may contain '+' (the patch-package
  // encoding of the '/' in scoped names, e.g. @deepseek-ai+dsh-win32-process),
  // so split at the LAST '+' and decode '+' back to '/'.
  const base = path.basename(patchFile, '.patch');
  const plus = base.lastIndexOf('+');
  if (plus <= 0 || plus === base.length - 1) {
    return null;
  }
  return { name: base.slice(0, plus).replace(/\+/g, '/'), version: base.slice(plus + 1) };
}

function git(args) {
  return spawnSync('git', args, { cwd: PROJECT_ROOT, encoding: 'utf8' });
}

function main() {
  if (!fs.existsSync(PATCHES_DIR)) {
    console.log('[dsh-kernel-patches] no patches directory — nothing to do');
    return;
  }
  const patchFiles = fs
    .readdirSync(PATCHES_DIR)
    .filter((name) => name.endsWith('.patch'))
    .sort();
  if (patchFiles.length === 0) {
    console.log('[dsh-kernel-patches] no kernel patches present — nothing to do');
    return;
  }

  let failures = 0;
  for (const patchFile of patchFiles) {
    const label = path.basename(patchFile);
    const target = patchTargets(patchFile);
    if (!target) {
      console.error(`[dsh-kernel-patches] ${label}: cannot parse "<name>+<version>.patch" — rename it`);
      failures += 1;
      continue;
    }

    const installedManifest = path.join(RUNTIME_NODE_MODULES, target.name, 'package.json');
    if (!fs.existsSync(installedManifest)) {
      console.error(
        `[dsh-kernel-patches] ${label}: ${target.name} is not installed under dsh-runtime/node_modules — ` +
        'run: npm install --prefix dsh-runtime',
      );
      failures += 1;
      continue;
    }
    const installedVersion = JSON.parse(fs.readFileSync(installedManifest, 'utf8')).version;
    if (installedVersion !== target.version) {
      console.error(
        `[dsh-kernel-patches] ${label}: patch targets ${target.name}@${target.version} but ` +
        `${installedVersion} is installed. The kernel was upgraded — rebase the patch ` +
        '(scripts/dsh-kernel-patches/README.md) or drop it if upstream fixed the issue.',
      );
      failures += 1;
      continue;
    }

    const patchPath = path.join(PATCHES_DIR, patchFile);
    const reverseCheck = git(['apply', '--check', '--reverse', patchPath]);
    if (reverseCheck.status === 0) {
      console.log(`[dsh-kernel-patches] ${label}: already applied`);
      continue;
    }
    const forwardCheck = git(['apply', '--check', patchPath]);
    if (forwardCheck.status !== 0) {
      console.error(
        `[dsh-kernel-patches] ${label}: does not apply to the installed ${target.name}@${installedVersion} ` +
        `(expected version matches, but the file drifted). Rebase the patch:\n${forwardCheck.stderr}`,
      );
      failures += 1;
      continue;
    }
    if (CHECK_ONLY) {
      console.error(`[dsh-kernel-patches] ${label}: NOT applied (run: node scripts/apply-dsh-kernel-patches.cjs)`);
      failures += 1;
      continue;
    }
    const applied = git(['apply', patchPath]);
    if (applied.status !== 0) {
      console.error(`[dsh-kernel-patches] ${label}: git apply failed:\n${applied.stderr}`);
      failures += 1;
      continue;
    }
    console.log(`[dsh-kernel-patches] ${label}: applied`);
  }

  if (failures > 0) {
    process.exit(1);
  }
}

main();
