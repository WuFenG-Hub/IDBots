#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * One-command DSH runtime version bump.
 *
 * Usage: pnpm run upgrade:dsh -- <version>
 *   e.g. pnpm run upgrade:dsh -- 0.1.2-rc.2
 *
 * Rewrites every @deepseek-ai/* pin in dsh-runtime/package.json AND the
 * matching override lines in dsh-runtime/pnpm-workspace.yaml to the target
 * version, regenerates dsh-runtime/pnpm-lock.yaml via pnpm install, and
 * re-runs the deps gate. This exists so a version bump is ONE command instead
 * of hand-edited multi-step file surgery: the 2026-09-06 incident (package.json
 * pinned to 0.1.2-rc.1 while the lockfile kept 0.1.3-alpha.1, breaking the
 * frozen-lockfile reinstall) and the earlier ERESOLVE lock staleness both came
 * from manual partial edits.
 *
 * After it succeeds, commit ALL THREE files together in one commit:
 *   dsh-runtime/package.json + dsh-runtime/pnpm-workspace.yaml + dsh-runtime/pnpm-lock.yaml
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const DSH_SCOPE = '@deepseek-ai/';
const PNPM_BIN = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function fail(message) {
  console.error(`[upgrade:dsh] ${message}`);
  process.exit(1);
}

function main() {
  // pnpm 11 forwards the documented `pnpm run upgrade:dsh -- <version>`
  // separator literally — skip a leading `--` so both invocation forms work.
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const target = args[0];
  if (!target || !VERSION_RE.test(target)) {
    fail('usage: pnpm run upgrade:dsh -- <version>   (e.g. pnpm run upgrade:dsh -- 0.1.2-rc.2)');
  }
  const runtimeDir = path.join(__dirname, '..', 'dsh-runtime');
  const pkgPath = path.join(runtimeDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const deps = pkg.dependencies || {};
  const names = Object.keys(deps).filter((name) => name.startsWith(DSH_SCOPE));
  if (names.length === 0) {
    fail(`no ${DSH_SCOPE}* dependencies found in ${pkgPath}`);
  }

  let changed = 0;
  for (const name of names) {
    if (deps[name] !== target) {
      deps[name] = target;
      changed += 1;
    }
  }
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`[upgrade:dsh] pinned ${names.length} dependencies ${DSH_SCOPE}* to ${target} (${changed} spec(s) changed)`);

  // Overrides must move in the same pass: pnpm 11 reads them from
  // dsh-runtime/pnpm-workspace.yaml (NOT from package.json), and a stale
  // transitive-only override would silently hold that package at the old
  // version while everything else upgrades. Only existing override entries
  // are bumped — a NEW transitive @deepseek-ai/* package needs its override
  // line added by hand once, after which this script maintains it.
  const yamlPath = path.join(runtimeDir, 'pnpm-workspace.yaml');
  let yamlText = fs.readFileSync(yamlPath, 'utf8');
  let yamlChanged = 0;
  // Scope the rewrite to the `overrides:` block only: a file-wide replace
  // also rewrites lookalike keys elsewhere (the 0.1.7-rc.1 bump clobbered
  // `allowBuilds.'@deepseek-ai/dsh-subprocess-local': true` into a version
  // pin, which pnpm rejected with ERR_PNPM_IGNORED_BUILDS).
  const lines = yamlText.split('\n');
  let inOverrides = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) inOverrides = line.trim() === 'overrides:';
    if (!inOverrides) continue;
    const match = line.match(/^(\s*'(@deepseek-ai\/[a-z0-9.-]+)':\s*)(\S+)\s*$/);
    if (match && match[3] !== target) {
      lines[i] = `${match[1]}${target}`;
      yamlChanged += 1;
    }
  }
  yamlText = lines.join('\n');
  fs.writeFileSync(yamlPath, yamlText);
  console.log(`[upgrade:dsh] bumped ${yamlChanged} override line(s) in dsh-runtime/pnpm-workspace.yaml to ${target}`);

  console.log('[upgrade:dsh] regenerating dsh-runtime/pnpm-lock.yaml via pnpm install ...');
  // Regenerate from a clean slate: the existing node_modules/lockfile pin the
  // OLD kernel line, and the resolver would try to reconcile it —
  // dsh-sdk-client pulls the full `dsh` app bundle, whose old pinned transitive
  // packages peer-conflict with the new root pins. Exact root pins make a
  // fresh resolve deterministic, so dropping the stale state is safe.
  fs.rmSync(path.join(runtimeDir, 'pnpm-lock.yaml'), { force: true });
  // maxRetries rides out exFAT/spotlight lag on the external-SSD worktrees:
  // a plain recursive rm raced directory-entry teardown there and died with
  // ENOTEMPTY (0.1.7-rc.1 bump).
  fs.rmSync(path.join(runtimeDir, 'node_modules'), { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  const install = spawnSync(PNPM_BIN, ['--dir', runtimeDir, 'install'], { stdio: 'inherit' });
  if (install.status !== 0) {
    fail(
      'pnpm install failed (ETARGET usually means the target version is not published ' +
      'for some package). Restore with: git checkout -- dsh-runtime/package.json dsh-runtime/pnpm-workspace.yaml dsh-runtime/pnpm-lock.yaml',
    );
  }

  console.log('[upgrade:dsh] re-applying kernel patches ...');
  const patches = spawnSync(process.execPath, [path.join(__dirname, 'apply-dsh-kernel-patches.cjs')], { stdio: 'inherit' });
  if (patches.status !== 0) {
    fail(
      'kernel patch re-apply failed — the upgrade changed files a patch targets. ' +
      'Rebase or drop the affected patch under scripts/dsh-kernel-patches/ (see its README.md), ' +
      'then rerun this script.',
    );
  }

  console.log('[upgrade:dsh] running the deps gate ...');
  const gate = spawnSync(process.execPath, [path.join(__dirname, 'check-dsh-runtime-deps.cjs')], { stdio: 'inherit' });
  if (gate.status !== 0) {
    fail('check:dsh-deps failed after the upgrade — resolve before committing.');
  }

  console.log('[upgrade:dsh] done. Commit ALL THREE files together in one commit:');
  console.log('  dsh-runtime/package.json');
  console.log('  dsh-runtime/pnpm-workspace.yaml');
  console.log('  dsh-runtime/pnpm-lock.yaml');
}

main();
