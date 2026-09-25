#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Verify every committed DSH kernel patch is present where it must be.
 *
 * WHY THIS EXISTS: `scripts/apply-dsh-kernel-patches.cjs` proves the patches
 * are applied to the CURRENT checkout's node_modules. That says nothing about
 * the PACKAGED app: the v0.9.3 incident (2026-09-16) shipped Windows builds
 * without the win32 console-flash patch because a later install step wiped
 * node_modules and nothing re-checked the artifact — build and tests stayed
 * green while the installer silently regressed. The two hand-written
 * artifact fingerprints that followed covered exactly two patches; every
 * patch added since (spill self-heal, the two ENOTSUP hard-link fallbacks)
 * had NO packaged-artifact verification at all.
 *
 * This script makes that class of gap impossible:
 *   - scripts/dsh-kernel-patches/manifest.json pairs every .patch file with
 *     the marker its applied form leaves in the installed file(s);
 *   - a patch file WITHOUT a manifest entry fails the gate (so a new patch
 *     cannot ship unverified);
 *   - the same checker runs against a local install (default) and against a
 *     PACKAGED app's resources root (--root), which is what CI does per OS.
 *
 * Usage:
 *   node scripts/verify-dsh-kernel-patches.cjs
 *     default root = this checkout's dsh-runtime/node_modules
 *   node scripts/verify-dsh-kernel-patches.cjs --root release/win-unpacked/resources
 *   node scripts/verify-dsh-kernel-patches.cjs --root "release/mac-arm64/IDBots.app/Contents/Resources"
 *   node scripts/verify-dsh-kernel-patches.cjs --platform win32   # override the host platform
 *   node scripts/verify-dsh-kernel-patches.cjs --list             # print the manifest
 *
 * Wired into: check:dsh-deps (local gate; every packaging pre-hook runs it)
 * and the Build/Release workflow (packaged-artifact check, all three jobs).
 */
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PATCHES_DIR = path.join(__dirname, 'dsh-kernel-patches');
const MANIFEST_PATH = path.join(PATCHES_DIR, 'manifest.json');

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

/**
 * Resolve one manifest target against a root directory. The manifest paths are
 * written relative to the package root (`dsh-runtime/node_modules/...`) so the
 * same entry works for a repository checkout, an unpacked app bundle's
 * `resources/` directory, and the app bundle's `Contents/Resources/`.
 */
const resolveTarget = (root, file) => path.join(root, file);

const main = () => {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`[verify-dsh-kernel-patches] missing manifest: ${MANIFEST_PATH}`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const entries = Array.isArray(manifest.patches) ? manifest.patches : [];

  if (argv.includes('--list')) {
    for (const entry of entries) {
      console.log(`${entry.patch}${entry.platforms ? ` [${entry.platforms.join(', ')}]` : ''}`);
      for (const target of entry.targets ?? []) {
        console.log(`  ${target.file}  "${target.match}" x${target.count ?? '>=1'}`);
      }
    }
    return;
  }

  const rootFlag = flagValue('--root');
  // Default: this checkout's runtime install. dsh-runtime/node_modules is the
  // first path segment in every manifest entry, so the default root is the
  // repository root.
  const root = rootFlag === undefined ? PROJECT_ROOT : path.resolve(rootFlag);
  const platform = flagValue('--platform') ?? process.platform;

  // Completeness: a patch file without a fingerprint must never ship unverified.
  // ExFAT volumes (the external-SSD worktrees) grow `._name.patch` AppleDouble
  // sidecars next to every real file; the apply script skips them, so this
  // check must too or every worktree run reports phantom patches.
  const patchFiles = fs.readdirSync(PATCHES_DIR)
    .filter((name) => name.endsWith('.patch') && !name.startsWith('._'))
    .sort();
  const listed = new Set(entries.map((entry) => entry.patch));
  const unlisted = patchFiles.filter((name) => !listed.has(name));
  const missingFiles = entries.map((entry) => entry.patch).filter((name) => !patchFiles.includes(name));
  if (unlisted.length > 0 || missingFiles.length > 0) {
    for (const name of unlisted) {
      console.error(`[verify-dsh-kernel-patches] ${name} has NO manifest.json fingerprint — add an entry (patch + target marker) before shipping.`);
    }
    for (const name of missingFiles) {
      console.error(`[verify-dsh-kernel-patches] manifest lists ${name}, but that patch file is gone.`);
    }
    process.exit(1);
  }

  let checked = 0;
  let skipped = 0;
  const failures = [];
  for (const entry of entries) {
    if (Array.isArray(entry.platforms) && entry.platforms.length > 0 && !entry.platforms.includes(platform)) {
      skipped += 1;
      continue;
    }
    for (const target of entry.targets ?? []) {
      const file = resolveTarget(root, target.file);
      if (!fs.existsSync(file)) {
        failures.push(`${entry.patch}: target file missing at ${file}`);
        continue;
      }
      const text = fs.readFileSync(file, 'utf8');
      const found = text.split(target.match).length - 1;
      const expected = target.count ?? 1;
      checked += 1;
      if (found !== expected) {
        failures.push(
          `${entry.patch}: expected ${expected}x "${target.match}" in ${target.file}, found ${found}`
          + (entry.why === undefined ? '' : ` (${entry.why})`),
        );
      }
    }
  }

  if (failures.length > 0) {
    console.error(`[verify-dsh-kernel-patches] FAILED against ${root} (platform ${platform}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error('  The kernels here are NOT the patched ones — do not ship.');
    process.exit(1);
  }
  console.log(
    `[verify-dsh-kernel-patches] OK: ${checked} fingerprint(s) verified against ${root}`
    + (skipped === 0 ? '' : ` (${skipped} platform-scoped patch(es) skipped on ${platform})`),
  );
};

main();
