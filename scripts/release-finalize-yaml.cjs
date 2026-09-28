'use strict';

/**
 * release-finalize-yaml.cjs
 *
 * Recompute electron auto-update manifests (latest-mac.yml / latest.yml) from
 * the FINAL signed artifacts, so the GitHub Release never ships stale hashes.
 *
 * Why this exists: build.yml generates latest-mac.yml during electron-builder
 * packaging, BEFORE the DMG is re-signed and notarized. Its size/sha512 never
 * match the final DMG (v0.6.4: off by 11796 bytes). SOP §8 requires
 * regeneration from the final files.
 *
 * Naming contract (three different names, all intentional):
 * - Windows installer on disk / in artifacts: "IDBots Setup X.Y.Z.exe" (spaces)
 * - GitHub Release asset (softprops converts spaces to dots): IDBots.Setup.X.Y.Z.exe
 * - GitHub latest.yml url: IDBots.Setup.X.Y.Z.exe  (must match the GitHub asset)
 * - OSS object / CDN url: IDBots-Setup-X.Y.Z.exe   (no spaces allowed on OSS)
 *
 * Outputs:
 * - release-assets/macos/latest-mac.yml          (final Apple Silicon DMG values)
 * - release-assets/macos/latest-mac-x64.yml      (final Intel x64 DMG values)
 * - release-assets/windows/latest.yml            (dot-name url, for GitHub Release)
 * - release-assets/windows/oss-latest.yml        (hyphen-name url, for OSS; NOT uploaded to GitHub —
 *                                                 "oss-latest.yml" does not match the release glob latest*.yml)
 *
 * macOS ships two DMGs (arm64 + x64) and electron-builder can only emit one
 * latest-mac.yml per platform, so this script owns the manifest split: the
 * historic name keeps the arm64 semantics and the Intel DMG gets its own
 * manifest, so each arch's final signed hashes stay independently verifiable.
 * The in-app updater reads https://idbots.ai/update.json, not these files.
 *
 * Zero runtime dependencies: only node:crypto / node:fs / node:path.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// macOS artifacts, in manifest order. The first entry keeps the long-standing
// latest-mac.yml name so nothing that already consumes it changes behaviour.
const MAC_DMGS = [
  { arch: 'arm64', manifest: 'latest-mac.yml' },
  { arch: 'x64', manifest: 'latest-mac-x64.yml' },
];

function fail(msg) {
  console.error(`[finalize-yaml] ERROR: ${msg}`);
  process.exit(1);
}

function readVersion() {
  const fromArg = process.argv[2];
  if (fromArg) return fromArg.replace(/^v/, '');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  if (!pkg.version) fail('no version argument and package.json has no version');
  return pkg.version;
}

function sha512Base64(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('base64')));
    stream.on('error', reject);
  });
}

function buildYaml({ version, url, sha512, size, releaseDate }) {
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${url}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${url}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    '',
  ].join('\n');
}

async function main() {
  const version = readVersion();
  const macDir = 'release-assets/macos';
  const winDir = 'release-assets/windows';

  const macDmgs = MAC_DMGS.map(({ arch, manifest }) => {
    const name = `IDBots-${version}-${arch}.dmg`;
    const filePath = path.join(macDir, name);
    if (!fs.existsSync(filePath)) fail(`final DMG not found: ${filePath}`);
    return { arch, manifest, name, filePath };
  });

  // GitHub asset names use dots where electron-builder uses spaces.
  const exeDiskName = `IDBots Setup ${version}.exe`;
  const exePath = path.join(winDir, exeDiskName);
  if (!fs.existsSync(exePath)) fail(`signed installer not found: ${exePath}`);

  // Preserve the builder-generated releaseDate (update clients only compare versions).
  let releaseDate = new Date().toISOString();
  const existingMacYml = path.join(macDir, 'latest-mac.yml');
  if (fs.existsSync(existingMacYml)) {
    const m = fs.readFileSync(existingMacYml, 'utf8').match(/releaseDate:\s*'([^']+)'/);
    if (m) releaseDate = m[1];
  }

  const [macShas, exeSha] = await Promise.all([
    Promise.all(macDmgs.map((d) => sha512Base64(d.filePath))),
    sha512Base64(exePath),
  ]);
  const exeSize = fs.statSync(exePath).size;

  // 1) macOS manifests — final signed/notarized DMG values, one manifest per arch.
  macDmgs.forEach((dmg, index) => {
    const size = fs.statSync(dmg.filePath).size;
    const sha = macShas[index];
    const out = dmg.manifest === 'latest-mac.yml' ? existingMacYml : path.join(macDir, dmg.manifest);
    fs.writeFileSync(out, buildYaml({ version, url: dmg.name, sha512: sha, size, releaseDate }));
    console.log(`[finalize-yaml] ${dmg.manifest.padEnd(19)} <- ${dmg.name} (size=${size}, sha512=${sha.slice(0, 12)}...)`);
  });

  // 2) GitHub latest.yml — url must equal the actual GitHub asset name (dots).
  const githubYml = buildYaml({
    version,
    url: `IDBots.Setup.${version}.exe`,
    sha512: exeSha,
    size: exeSize,
    releaseDate,
  });
  fs.writeFileSync(path.join(winDir, 'latest.yml'), githubYml);

  // 3) OSS latest.yml — url must equal the OSS object name (hyphens).
  const ossYml = githubYml.replace(/IDBots\.Setup\./g, 'IDBots-Setup-');
  fs.writeFileSync(path.join(winDir, 'oss-latest.yml'), ossYml);

  console.log(`[finalize-yaml] latest.yml     <- ${exeDiskName} (size=${exeSize}, sha512=${exeSha.slice(0, 12)}...) github dot-name`);
  console.log(`[finalize-yaml] oss-latest.yml <- hyphen-name variant for OSS`);
  console.log('[finalize-yaml] OK');
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)));
