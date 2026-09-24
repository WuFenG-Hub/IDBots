#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Guarantee the mvc-scrypt -> mvc-lib patch actually landed.
 *
 * `mvc-scrypt` ships a patch tree (`patches/mvc-lib/**`, `patches/json-bigint/**`)
 * that its own `postinstall` copies over the installed packages. Under pnpm that
 * postinstall can end up a silent no-op: it resolves its file list with a
 * relative glob and prints "The patches has been successfully applied." even
 * when the glob matched nothing, so the install stays green while the tree is
 * unpatched.
 *
 * When it no-ops, `node_modules/mvc-lib` keeps the published 1.0.5 layout, whose
 * `lib/encoding/bufferwriter.js` still requires the `../script/write-*.js`
 * modules that only the patched tree provides. Requiring `meta-contract` then
 * dies with "Cannot find module '../script/write-u8-le'" - observed as a Windows
 * CI failure on the first pnpm-era release, and it would ship the same broken
 * tree inside the packaged app.
 *
 * So apply it explicitly here, from the repo root postinstall after every
 * dependency link step, with an absolute cwd, and fail loudly if the patched
 * files are still missing afterwards (same contract as the DSH kernel patches:
 * a silently unpatched tree must never ride a build).
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const mvcScryptDir = path.join(root, 'node_modules', 'mvc-scrypt');
const applyScript = path.join(mvcScryptDir, 'patches', 'applyPatch.js');
// Only the patched tree has this module; it is what bufferwriter.js requires.
const sentinel = path.join(root, 'node_modules', 'mvc-lib', 'lib', 'script', 'write-u8-le.js');

if (!fs.existsSync(applyScript)) {
  console.error(`[mvc-scrypt-patch] ${applyScript} not found - is mvc-scrypt installed?`);
  process.exit(1);
}

if (fs.existsSync(sentinel)) {
  console.log('[mvc-scrypt-patch] mvc-lib patch already applied.');
  process.exit(0);
}

console.log('[mvc-scrypt-patch] mvc-lib is unpatched; applying mvc-scrypt patches/applyPatch.js.');
try {
  execFileSync(process.execPath, [applyScript], {
    cwd: mvcScryptDir,
    stdio: 'inherit',
  });
} catch (error) {
  console.error(`[mvc-scrypt-patch] applying the patch failed: ${error && error.message}`);
  process.exit(1);
}

if (!fs.existsSync(sentinel)) {
  console.error(
    `[mvc-scrypt-patch] ${sentinel} is still missing after applying the patch - refusing to continue.`,
  );
  process.exit(1);
}
console.log('[mvc-scrypt-patch] mvc-lib patch applied and verified.');
