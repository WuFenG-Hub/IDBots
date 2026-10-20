// Regression tests for the mislabeled-update guard: an installer whose bundle
// reports a version different from the version recorded by the download
// sidecar must be refused before the silent swap touches the installed app.
//
// v1.0.1 shipped a bundle whose Info.plist still said 1.0.0, so the client kept
// judging itself outdated and re-downloaded the same 413 MB installer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import Module from 'node:module';

const repoRoot = path.resolve(import.meta.dirname, '..');

// --- compiled-module behavior tests (electron stubbed, like appUpdateMountPoint) ---
const require = createRequire(import.meta.url);
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getPath: () => '/tmp',
        relaunch: () => {},
        quit: () => {},
      },
      session: {
        defaultSession: {
          fetch: async () => {
            throw new Error('fetch not stubbed');
          },
        },
      },
    };
  }
  return originalLoad.apply(this, arguments);
};
const installer = require('../dist-electron/main/libs/appUpdateInstaller.js');
Module._load = originalLoad;

test('resolveDownloadMetaPath maps dmg/exe/extension-less installers to their sidecar', () => {
  assert.equal(
    installer.resolveDownloadMetaPath('/var/folders/xy/T/idbots-update-abc123.dmg'),
    '/var/folders/xy/T/idbots-update-abc123.meta.json',
  );

  assert.equal(
    installer.resolveDownloadMetaPath('C:\\Users\\bot\\AppData\\Local\\Temp\\idbots-update-abc123.exe'),
    'C:\\Users\\bot\\AppData\\Local\\Temp\\idbots-update-abc123.meta.json',
  );

  assert.equal(
    installer.resolveDownloadMetaPath('/tmp/idbots-update-abc123'),
    '/tmp/idbots-update-abc123.meta.json',
  );

  // Dots in parent directories are not the file extension
  assert.equal(
    installer.resolveDownloadMetaPath('/tmp/v1.2.3/idbots-update-abc123.dmg'),
    '/tmp/v1.2.3/idbots-update-abc123.meta.json',
  );
});

test('resolveDownloadMetaPath agrees with the downloader sidecar naming', () => {
  const stableId = installer.computeStableDownloadId('https://example.com/IDBots-1.0.2-arm64.dmg', '1.0.2');
  const finalPath = `/tmp/idbots-update-${stableId}.dmg`;
  assert.equal(
    installer.resolveDownloadMetaPath(finalPath),
    `/tmp/idbots-update-${stableId}.meta.json`,
  );
});

// --- source-level assertions (plutil is not executed in tests) ---
const source = fs.readFileSync(path.join(repoRoot, 'src/main/libs/appUpdateInstaller.ts'), 'utf8');

function extractFunctionBody(sourceText, startMarker, endMarker) {
  const start = sourceText.indexOf(startMarker);
  assert.ok(start !== -1, `missing function start: ${startMarker}`);
  const end = sourceText.indexOf(endMarker, start + startMarker.length);
  assert.ok(end !== -1, `missing end marker: ${endMarker}`);
  return sourceText.slice(start, end);
}

test('readMacBundleVersion reads the bundle self-reported version via plutil', () => {
  assert.match(source, /export async function readMacBundleVersion\(appPath: string\): Promise<string>/);
  assert.match(source, /path\.join\(appPath, 'Contents', 'Info\.plist'\)/);
  assert.match(source, /plutil -extract CFBundleShortVersionString raw/);
  assert.match(source, /reports no CFBundleShortVersionString/);
});

test('applyMacUpdateSilently refuses a bundle whose version disagrees with the manifest', () => {
  const body = extractFunctionBody(
    source,
    'export async function applyMacUpdateSilently',
    'async function installWindowsNsis',
  );

  assert.match(body, /const declaredVersion = await readDeclaredInstallerVersion\(dmgPath\)/);
  assert.match(body, /const incomingVersion = await readMacBundleVersion\(sourceApp\)/);
  assert.match(body, /if \(incomingVersion !== declaredVersion\) \{/);
  assert.match(
    body,
    /Refusing to install a mislabeled update: the bundle reports \$\{incomingVersion\} but the update manifest declares \$\{declaredVersion\}/,
  );

  // The gate must run after the DMG is mounted and before the swap touches the
  // installed app; the swap still copies the very sourceApp that was checked.
  const mountIdx = body.indexOf('hdiutil attach');
  const checkIdx = body.indexOf('readDeclaredInstallerVersion(dmgPath)');
  const swapIdx = body.indexOf('idbots-new-');
  assert.ok(mountIdx !== -1, 'DMG mount step missing');
  assert.ok(checkIdx > mountIdx, 'version check must run after mounting the DMG');
  assert.ok(swapIdx !== -1, 'silent swap step missing');
  assert.ok(checkIdx < swapIdx, 'version check must run before the swap starts');
  assert.match(body, /cp -R \$\{shellEscape\(sourceApp\)\}/);
});

test('missing sidecar metadata skips the check instead of failing hard', () => {
  const body = extractFunctionBody(
    source,
    'export async function applyMacUpdateSilently',
    'async function installWindowsNsis',
  );

  assert.match(body, /if \(declaredVersion\) \{/);
  const elseIdx = body.indexOf('} else {');
  assert.ok(elseIdx !== -1, 'else branch for an absent sidecar is missing');
  const gateEnd = body.indexOf('const currentAppPath');
  assert.ok(gateEnd > elseIdx, 'gate must end before the swap section');
  const skipBranch = body.slice(elseIdx, gateEnd);
  assert.match(skipBranch, /skipping bundle version check/);
  assert.doesNotMatch(skipBranch, /throw /);
});

test('installMacDmg (interactive fallback) is untouched by the guard', () => {
  const body = extractFunctionBody(
    source,
    'async function installMacDmg',
    'export async function relaunchPendingMacUpdate',
  );

  assert.doesNotMatch(
    body,
    /readDeclaredInstallerVersion|readMacBundleVersion|Refusing to install a mislabeled update/,
  );
  // Original behavior preserved: copy sourceApp into the target app path.
  assert.match(body, /cp -R \$\{shellEscape\(sourceApp\)\}/);
});
