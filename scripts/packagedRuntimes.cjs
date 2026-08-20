'use strict';

const path = require('path');
const { existsSync, statSync } = require('fs');
const { PLATFORM_ASSETS } = require('./setup-ffmpeg.js');

/**
 * Nested extraResource runtimes that ship their own node_modules.
 * Add an entry here when packaging another gitignored runtime directory.
 * beforePack verifies the source tree; afterPack verifies the copied app Resources.
 */
const PACKAGED_RUNTIMES = [
  {
    id: 'dsh-runtime',
    dir: 'dsh-runtime',
    extraResourceFrom: 'dsh-runtime',
    extraResourceTo: 'dsh-runtime',
    markers: [
      'bin.mjs',
      path.join('node_modules', '@deepseek-ai', 'dsh-sdk-client', 'lib', 'index.js'),
      path.join('node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json'),
    ],
  },
];

/** electron-builder Arch enum: ia32=0, x64=1, armv7l=2, arm64=3, universal=4 */
const ELECTRON_BUILDER_ARCH = {
  0: 'ia32',
  1: 'x64',
  2: 'armv7l',
  3: 'arm64',
  4: 'universal',
};

const MIN_FFMPEG_BYTES = 1024 * 1024;

function projectRootFrom(scriptDir = __dirname) {
  return path.resolve(scriptDir, '..');
}

function isPackedBinaryPresent(filePath) {
  try {
    const stat = statSync(filePath);
    return stat.isFile() && stat.size > MIN_FFMPEG_BYTES;
  } catch {
    return false;
  }
}

function resolveArchName(context) {
  const arch = context?.arch;
  if (typeof arch === 'string' && arch) return arch;
  if (Object.prototype.hasOwnProperty.call(ELECTRON_BUILDER_ARCH, arch)) {
    return ELECTRON_BUILDER_ARCH[arch];
  }
  return process.arch;
}

function resolveFfmpegPlatformKey(context) {
  const platform = context?.electronPlatformName;
  const archName = resolveArchName(context);
  if (platform === 'darwin' && (archName === 'arm64' || archName === 'x64')) {
    return `darwin-${archName}`;
  }
  if (platform === 'win32') return 'win32-x64';
  return null;
}

function missingMarkers(runtimeRoot, markers) {
  return markers.filter((rel) => !existsSync(path.join(runtimeRoot, rel)));
}

function verifySourceRuntimes(root = projectRootFrom()) {
  const missing = [];
  for (const runtime of PACKAGED_RUNTIMES) {
    const runtimeRoot = path.join(root, runtime.dir);
    for (const rel of missingMarkers(runtimeRoot, runtime.markers)) {
      missing.push(path.join(runtime.dir, rel).replace(/\\/g, '/'));
    }
  }
  if (missing.length > 0) {
    throw new Error(
      'Release packaging requires nested runtime dependencies before pack: '
      + `${missing.join(', ')}. Run npm ci in each runtime directory listed in scripts/packagedRuntimes.cjs.`,
    );
  }
}

function resolvePackagedResourcesDir(context) {
  const appOutDir = context.appOutDir;
  if (context.electronPlatformName === 'darwin') {
    const appName = context.packager.appInfo.productFilename;
    const bundled = path.join(appOutDir, `${appName}.app`, 'Contents', 'Resources');
    if (existsSync(bundled)) return bundled;
    const direct = path.join(appOutDir, 'Contents', 'Resources');
    if (existsSync(direct)) return direct;
    return bundled;
  }
  return path.join(appOutDir, 'resources');
}

function verifyPackagedRuntimes(context) {
  const resourcesDir = resolvePackagedResourcesDir(context);
  const missing = [];
  for (const runtime of PACKAGED_RUNTIMES) {
    const runtimeRoot = path.join(resourcesDir, runtime.extraResourceTo);
    for (const rel of missingMarkers(runtimeRoot, runtime.markers)) {
      missing.push(path.join(runtime.extraResourceTo, rel).replace(/\\/g, '/'));
    }
  }
  if (missing.length > 0) {
    throw new Error(
      'Packaged app is missing nested runtime files under Resources: '
      + `${missing.join(', ')}. extraResources must copy node_modules for each packaged runtime.`,
    );
  }
}

function extraResourceFilterExcludesNodeModules(filter) {
  if (!Array.isArray(filter)) return false;
  return filter.some((pattern) => {
    if (typeof pattern !== 'string' || !pattern.startsWith('!')) return false;
    return pattern.includes('node_modules');
  });
}

function ffmpegSourcePath(platformKey, root = projectRootFrom()) {
  const asset = PLATFORM_ASSETS[platformKey];
  if (!asset) return null;
  return path.join(root, 'resources', 'ffmpeg', asset);
}

function ffmpegPackagedRel(platformKey) {
  const asset = PLATFORM_ASSETS[platformKey];
  if (!asset) return null;
  return path.join('ffmpeg', asset);
}

function verifySourceFfmpeg(context, root = projectRootFrom()) {
  const platformKey = resolveFfmpegPlatformKey(context);
  if (!platformKey) return;
  const sourcePath = ffmpegSourcePath(platformKey, root);
  if (!sourcePath || !isPackedBinaryPresent(sourcePath)) {
    throw new Error(
      `Release packaging requires bundled ffmpeg for ${platformKey} `
      + `(${sourcePath || 'unknown path'} is missing or smaller than 1MB). `
      + 'Run node scripts/setup-ffmpeg.js --required before packaging.',
    );
  }
}

function verifyPackagedFfmpeg(context) {
  const platformKey = resolveFfmpegPlatformKey(context);
  if (!platformKey) return;
  const rel = ffmpegPackagedRel(platformKey);
  const packagedPath = path.join(resolvePackagedResourcesDir(context), rel);
  if (!isPackedBinaryPresent(packagedPath)) {
    throw new Error(
      `Packaged app is missing bundled ffmpeg under Resources/${rel.replace(/\\/g, '/')}. `
      + 'CI must run scripts/setup-ffmpeg.js before electron-builder; extraResources skips missing files with only a warning.',
    );
  }
}

module.exports = {
  PACKAGED_RUNTIMES,
  missingMarkers,
  verifySourceRuntimes,
  verifyPackagedRuntimes,
  verifySourceFfmpeg,
  verifyPackagedFfmpeg,
  resolvePackagedResourcesDir,
  resolveFfmpegPlatformKey,
  extraResourceFilterExcludesNodeModules,
};
