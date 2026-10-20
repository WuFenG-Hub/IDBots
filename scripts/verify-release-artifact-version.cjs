'use strict';

/**
 * verify-release-artifact-version.cjs
 *
 * Guard for the 2026-10-19 update-loop incident: the v1.0.1 release shipped an
 * app bundle whose internal version (CFBundleShortVersionString) was still
 * 1.0.0, while the tag, the file name and the update manifest all said 1.0.1.
 * Clients compare their own bundle version against the manifest, so every
 * installation kept seeing "an update is available" and re-downloaded the same
 * package in a loop. The pipeline verified the git tag against package.json,
 * but nothing verified the version inside the artifact it published.
 *
 * This script reads the version a packaged artifact reports about itself and
 * asserts it equals the version the release is published under (package.json,
 * which also drives the DMG/zip file names and the update manifest).
 *
 * Usage:
 *   node scripts/verify-release-artifact-version.cjs [artifactPath|dir]...
 *   APP_VERSION=1.0.2 node scripts/verify-release-artifact-version.cjs release/mac-arm64/IDBots.app
 *
 * With no arguments, `.app` bundles are discovered under RELEASE_DIR
 * (default `release`). Exits non-zero on mismatch, or when a version cannot be
 * read (an unreadable artifact must not silently pass the guard).
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readPackageVersion } = require('./release-artifact-paths.cjs');

const PRODUCT_NAME = process.env.PRODUCT_NAME || 'IDBots';

/** Read the version a macOS app bundle reports about itself. */
function readMacAppVersion(appPath) {
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  if (!fs.existsSync(plistPath)) {
    throw new Error(`Info.plist not found at ${plistPath}`);
  }

  // plutil handles binary and XML plists; it is present on macOS runners and
  // developer machines. The XML fallback keeps the guard usable elsewhere.
  try {
    const extracted = execFileSync(
      'plutil',
      ['-extract', 'CFBundleShortVersionString', 'raw', plistPath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (extracted) return extracted;
  } catch {
    // fall through to the XML reader
  }

  const xml = fs.readFileSync(plistPath, 'utf8');
  const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(xml);
  if (match) return match[1].trim();

  throw new Error(`cannot read CFBundleShortVersionString from ${plistPath}`);
}

/** Collect `.app` bundles directly under a directory (one packaging level deep). */
function findMacAppBundles(root) {
  const levels = [root];
  const found = [];
  for (const level of levels) {
    for (const entry of fs.readdirSync(level, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.endsWith('.app')) {
        found.push(path.join(level, entry.name));
      } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
        levels.push(path.join(level, entry.name));
      }
    }
  }
  return found;
}

function resolveTargets(argv) {
  const explicit = argv.filter((arg) => !arg.startsWith('-'));
  if (explicit.length > 0) return explicit;

  const releaseDir = process.env.RELEASE_DIR || 'release';
  if (!fs.existsSync(releaseDir)) {
    throw new Error(`no artifact path given and ${releaseDir} does not exist`);
  }
  const discovered = findMacAppBundles(releaseDir);
  if (discovered.length === 0) {
    throw new Error(`no .app bundle found under ${releaseDir}; pass the artifact path explicitly`);
  }
  return discovered;
}

function main() {
  const expected = (process.env.APP_VERSION || '').trim() || readPackageVersion();
  const targets = resolveTargets(process.argv.slice(2));
  let failures = 0;

  for (const target of targets) {
    const appPath = target.endsWith('.app') ? target : path.join(target, `${PRODUCT_NAME}.app`);
    try {
      const actual = readMacAppVersion(appPath);
      if (actual === expected) {
        console.log(`[artifact-version] OK   ${appPath} reports ${actual}`);
      } else {
        failures += 1;
        console.error(
          `[artifact-version] FAIL ${appPath} reports ${actual} but this release publishes ${expected}`,
        );
        console.error(
          '[artifact-version] The published artifact must report the release version: ' +
            'clients compare their own bundle version against the update manifest, and a ' +
            'mismatch makes them re-download the same package forever.',
        );
      }
    } catch (error) {
      failures += 1;
      console.error(`[artifact-version] FAIL ${appPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures > 0) {
    process.exitCode = 1;
    return;
  }
  console.log(`[artifact-version] verified ${targets.length} artifact(s) at ${expected}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[artifact-version] ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

module.exports = {
  findMacAppBundles,
  readMacAppVersion,
};
