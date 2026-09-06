#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * One-command DSH runtime version bump.
 *
 * Usage: npm run upgrade:dsh -- <version>
 *   e.g. npm run upgrade:dsh -- 0.1.2-rc.2
 *
 * Rewrites every @deepseek-ai/* pin in dsh-runtime/package.json to the target
 * version, regenerates dsh-runtime/package-lock.json via npm install, and
 * re-runs the deps gate. This exists so a version bump is ONE command instead
 * of hand-edited multi-step file surgery: the 2026-09-06 incident (package.json
 * pinned to 0.1.2-rc.1 while the lockfile kept 0.1.3-alpha.1, breaking
 * `npm ci --prefix dsh-runtime` with EUSAGE) and the earlier ERESOLVE lock
 * staleness both came from manual partial edits.
 *
 * After it succeeds, commit BOTH files together in one commit:
 *   dsh-runtime/package.json + dsh-runtime/package-lock.json
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const DSH_SCOPE = '@deepseek-ai/';
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function fail(message) {
  console.error(`[upgrade:dsh] ${message}`);
  process.exit(1);
}

function main() {
  const target = process.argv[2];
  if (!target || !VERSION_RE.test(target)) {
    fail('usage: npm run upgrade:dsh -- <version>   (e.g. npm run upgrade:dsh -- 0.1.2-rc.2)');
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
  console.log(`[upgrade:dsh] pinned ${names.length} ${DSH_SCOPE}* packages to ${target} (${changed} spec(s) changed)`);

  console.log('[upgrade:dsh] regenerating dsh-runtime/package-lock.json via npm install ...');
  const install = spawnSync(NPM_BIN, ['install', '--prefix', runtimeDir], { stdio: 'inherit' });
  if (install.status !== 0) {
    fail(
      'npm install failed (ETARGET usually means the target version is not published ' +
      'for some package). Restore with: git checkout -- dsh-runtime/package.json dsh-runtime/package-lock.json',
    );
  }

  console.log('[upgrade:dsh] running the deps gate ...');
  const gate = spawnSync(process.execPath, [path.join(__dirname, 'check-dsh-runtime-deps.cjs')], { stdio: 'inherit' });
  if (gate.status !== 0) {
    fail('check:dsh-deps failed after the upgrade — resolve before committing.');
  }

  console.log('[upgrade:dsh] done. Commit BOTH files together in one commit:');
  console.log('  dsh-runtime/package.json');
  console.log('  dsh-runtime/package-lock.json');
}

main();
