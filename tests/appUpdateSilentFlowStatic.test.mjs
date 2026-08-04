import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('Main process exposes silent macOS apply and pending relaunch helpers', () => {
  const source = read('src/main/libs/appUpdateInstaller.ts');

  assert.match(source, /export async function applyMacUpdateSilently\(dmgPath: string\): Promise<void>/);
  assert.match(source, /export async function relaunchPendingMacUpdate\(\): Promise<boolean>/);
  // Silent apply must swap via mv (never leaves target missing) and must not relaunch on its own
  assert.match(source, /idbots-new-/);
  assert.match(source, /idbots-old-/);
  assert.match(source, /pendingMacRelaunch\s*=\s*\{/);
  assert.match(source, /err\.code === 'EACCES'|\.code = 'EACCES'/);
});

test('Main process registers applySilent and relaunchNow IPC handlers', () => {
  const source = read('src/main/main.ts');

  assert.match(source, /import\s*\{[^}]*applyMacUpdateSilently[^}]*relaunchPendingMacUpdate[^}]*\}\s*from\s*'\.\/libs\/appUpdateInstaller'/);
  assert.match(source, /ipcMain\.handle\('appUpdate:applySilent'/);
  assert.match(source, /ipcMain\.handle\('appUpdate:relaunchNow'/);
  assert.match(source, /permissionDenied:\s*err\.code === 'EACCES'/);
});

test('Preload and renderer typings expose the new appUpdate APIs', () => {
  const preload = read('src/main/preload.ts');
  const typings = read('src/renderer/types/electron.d.ts');

  assert.match(preload, /applySilent:\s*\(filePath: string\)\s*=>\s*ipcRenderer\.invoke\('appUpdate:applySilent', filePath\)/);
  assert.match(preload, /relaunchNow:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('appUpdate:relaunchNow'\)/);

  assert.match(typings, /applySilent:\s*\(filePath: string\)\s*=>\s*Promise<\{\s*success: boolean; permissionDenied\?: boolean; error\?: string \}>/);
  assert.match(typings, /relaunchNow:\s*\(\)\s*=>\s*Promise<\{\s*success: boolean \}>/);
});

test('Renderer runs silent download flow gated by update phase', () => {
  const source = read('src/renderer/App.tsx');

  assert.match(source, /type UpdatePhase = 'idle' \| 'downloading' \| 'ready' \| 'applying' \| 'restartReady';/);
  assert.match(source, /const startSilentDownload = useCallback\(async \(info: AppUpdateInfo\)/);
  assert.match(source, /await window\.electron\.appUpdate\.applySilent\(downloadResult\.filePath\)/);
  assert.match(source, /changeUpdatePhase\('restartReady'\)/);
  // New versions trigger a silent download instead of immediately showing the badge
  assert.match(source, /void startSilentDownload\(nextUpdate\)/);
  // Badge stays visible with non-intrusive progress during silent download; hidden only while applying
  assert.match(source, /updatePhase !== 'applying'/);
  assert.match(source, /progress=\{updatePhase === 'downloading' \? downloadProgress : null\}/);
  // Silent download subscribes to progress and passes version + optional sha256
  assert.match(source, /window\.electron\.appUpdate\.onDownloadProgress/);
  assert.match(source, /appUpdate\.download\(info\.url, info\.latestVersion, info\.sha256\)/);
  // Silent download failure (except user cancel) surfaces a visible badge notice
  assert.match(source, /setSilentDownloadFailed\(true\)/);
  assert.match(source, /downloadResult\.error !== 'Download cancelled'/);
  assert.match(source, /silentDownloadFailed[\s\S]*?i18nService\.t\('updateDownloadFailedPill'\)/);
  assert.match(source, /tone=\{silentDownloadFailed \? 'error' : undefined\}/);
  // Restart confirmation relaunches into the silently applied update
  assert.match(source, /await window\.electron\.appUpdate\.relaunchNow\(\)/);
  // Downloaded installer is reused for the local install path
  assert.match(source, /downloadedUpdateFileRef\.current\?\.version === updateInfo\.latestVersion/);
});

test('Main process downloader supports resumable downloads (Range/If-Range, meta, cleanup)', () => {
  const source = read('src/main/libs/appUpdateInstaller.ts');

  // Stable per-target temp identity and metadata sidecar
  assert.match(source, /export function computeStableDownloadId/);
  assert.match(source, /\.meta\.json/);
  assert.match(source, /interface DownloadMeta/);
  assert.match(source, /etag\?: string;/);
  assert.match(source, /totalSize\?: number;/);
  assert.match(source, /downloadedSize: number;/);
  assert.match(source, /export async function cleanupStaleDownloads/);
  // Resume protocol handling
  assert.match(source, /headers\['Range'\] = `bytes=\$\{offset\}-`/);
  assert.match(source, /headers\['If-Range'\]/);
  assert.match(source, /response\.status === 206/);
  assert.match(source, /content-range/);
  assert.match(source, /response\.status === 416/);
  assert.match(source, /response\.status === 200/);
  assert.match(source, /flags: resumed \? 'a' : 'w'/);
  // Integrity verification before the atomic rename
  assert.match(source, /expectedSha256/);
  assert.match(source, /expectedSha512/);
  assert.match(source, /checksum mismatch/);
  assert.match(source, /fs\.promises\.rename\(downloadPath, finalPath\)/);
  // Error contract preserved for the renderer
  assert.match(source, /'Download cancelled'/);
  assert.match(source, /'Download timed out: no data received for 60 seconds'/);
  assert.match(source, /'A download is already in progress'/);
});

test('Main process passes version and sha256 through the download IPC and sweeps at startup', () => {
  const source = read('src/main/main.ts');

  assert.match(source, /appUpdate:download', async \(event, payload: \{ url: string; version\?: string; sha256\?: string \}\)/);
  assert.match(source, /expectedSha256: payload\.sha256/);
  assert.match(source, /cleanupStaleDownloads/);
});

test('Preload and renderer typings accept version, optional sha256 and resumed progress', () => {
  const preload = read('src/main/preload.ts');
  const typings = read('src/renderer/types/electron.d.ts');

  assert.match(preload, /download: \(url: string, version: string, sha256\?: string\)/);
  assert.match(typings, /download: \(url: string, version: string, sha256\?: string\)/);
  assert.match(typings, /resumed\?: boolean;/);
});

test('Renderer service reads optional sha256 from the update manifest', () => {
  const source = read('src/renderer/services/appUpdate.ts');

  assert.match(source, /sha256\?: string;/);
  assert.match(source, /sha256: download\.sha256/);
  // No-update behavior unchanged: invalid payloads still resolve to null
  assert.match(source, /if \(payload\.code !== 0\) \{[\s\S]*?return null;/);
});

test('Update badge shows non-intrusive download progress with resume label', () => {
  const badge = read('src/renderer/components/update/AppUpdateBadge.tsx');
  const modal = read('src/renderer/components/update/AppUpdateModal.tsx');

  assert.match(badge, /progress\?: AppUpdateDownloadProgress \| null;/);
  assert.match(badge, /updateResumingPill/);
  assert.match(badge, /updateDownloadingPill/);
  assert.match(badge, /formatBytes/);
  assert.match(badge, /Math\.round\(progress\.percent \* 100\)/);
  // Error tone for a failed silent download (visible, non-intrusive notice)
  assert.match(badge, /tone\?: 'default' \| 'error';/);
  assert.match(badge, /updateDownloadFailedPill/);
  assert.match(badge, /updateDownloadFailedTitle/);
  assert.match(badge, /border-red-500\/30/);
  // Shared format helpers extracted for badge + modal
  assert.match(modal, /from '\.\/format'/);
});

test('Update modal supports restart state and ready-to-install copy', () => {
  const source = read('src/renderer/components/update/AppUpdateModal.tsx');

  assert.match(source, /export type UpdateModalState = 'info' \| 'downloading' \| 'installing' \| 'error' \| 'restart';/);
  assert.match(source, /readyToInstall\?: boolean;/);
  assert.match(source, /modalState === 'restart' &&/);
  assert.match(source, /i18nService\.t\('updateRestartNow'\)/);
  assert.match(source, /i18nService\.t\('updateDownloadedTitle'\)/);
  assert.match(source, /i18nService\.t\('updateInstallNow'\)/);
});

test('Update badge supports a phase-aware label', () => {
  const source = read('src/renderer/components/update/AppUpdateBadge.tsx');

  assert.match(source, /label\?: string;/);
  assert.match(source, /label \?\? i18nService\.t\('updateAvailablePill'\)/);
});

test('i18n contains silent-update copy in zh and en', () => {
  const source = read('src/renderer/services/i18n.ts');

  for (const key of ['updateReadyPill', 'updateDownloadedTitle', 'updateInstallNow', 'updateRestartTitle', 'updateRestartMessage', 'updateRestartNow', 'updateLater', 'updateDownloadingPill', 'updateResumingPill', 'updateDownloadFailedPill', 'updateDownloadFailedTitle']) {
    const occurrences = source.split(`${key}:`).length - 1;
    assert.ok(occurrences >= 2, `i18n key ${key} should exist in both zh and en dictionaries`);
  }
});
