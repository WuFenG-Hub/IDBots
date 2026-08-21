#!/usr/bin/env node
/**
 * Prepare bundled ffmpeg binaries under resources/ffmpeg for packaging/runtime.
 *
 * The vision relay's describe_video tool transcodes any user video down to a
 * small H.264/mp4 clip before upload, so recognition payloads stay far below
 * the upstream 10MB base64 cap. Binaries come from the ffmpeg-static GitHub
 * releases (plain uncompressed binaries, one per platform).
 *
 * Features (mirrors setup-mingit):
 * - Cross-platform execution (macOS can prepare assets for Windows packaging)
 * - Per-platform selective download: --platform=darwin-arm64,darwin-x64,win32-x64
 *   (default: current platform when natively buildable, all three under --required)
 * - Offline archive support via IDBOTS_FFMPEG_ARCHIVE (single binary file)
 * - Mirror URL override via IDBOTS_FFMPEG_URL ({{platform}} placeholder)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const FFMPEG_VERSION = 'b6.1.1';
const DEFAULT_FFMPEG_BASE_URL =
  `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_VERSION}`;

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'resources', 'ffmpeg');

/** Asset name -> local file name inside resources/ffmpeg. */
const PLATFORM_ASSETS = {
  'darwin-arm64': 'ffmpeg-darwin-arm64',
  'darwin-x64': 'ffmpeg-darwin-x64',
  'win32-x64': 'ffmpeg-win32-x64.exe',
};

/**
 * Remote asset name per platform. ffmpeg-static releases ship the Windows
 * binary as an extension-less file (ffmpeg-win32-x64), while the local target
 * and electron-builder extraResources expect ffmpeg-win32-x64.exe.
 */
const REMOTE_ASSETS = {
  'darwin-arm64': 'ffmpeg-darwin-arm64',
  'darwin-x64': 'ffmpeg-darwin-x64',
  'win32-x64': 'ffmpeg-win32-x64',
};

function parseArgs(argv) {
  const platformFlag = argv.find((a) => a.startsWith('--platform='));
  const platforms = platformFlag
    ? platformFlag.slice('--platform='.length).split(',').map((p) => p.trim()).filter(Boolean)
    : null;
  return {
    required: argv.includes('--required'),
    platforms,
  };
}

function currentPlatformKey() {
  if (process.platform === 'win32') return 'win32-x64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  return null; // linux builds are not distributed today
}

function isNonEmptyFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 1024 * 1024; // real ffmpeg binaries are tens of MB
  } catch {
    return false;
  }
}

async function downloadBinaryOnce(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status} ${response.statusText}) for ${url}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const tmpFile = `${destination}.download`;
  try {
    const stream = fs.createWriteStream(tmpFile);
    await pipeline(Readable.fromWeb(response.body), stream);
    if (!isNonEmptyFile(tmpFile)) {
      throw new Error('Downloaded ffmpeg binary is suspiciously small.');
    }
    fs.renameSync(tmpFile, destination);
  } catch (error) {
    try {
      fs.rmSync(tmpFile, { force: true });
    } catch {
      // ignore cleanup errors
    }
    throw error;
  }
}

async function downloadBinary(url, destination) {
  const attempts = 5;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      console.log(`[setup-ffmpeg] download attempt ${attempt} for ${url}`);
    }
    try {
      await downloadBinaryOnce(url, destination);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        const delayMs = 3000 * attempt;
        console.log(
          `[setup-ffmpeg] download attempt ${attempt} failed: `
          + `${error instanceof Error ? error.message : String(error)}; retrying in ${delayMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

function resolvePlatforms(options) {
  if (options.platforms) return options.platforms;
  const native = currentPlatformKey();
  if (options.required) return Object.keys(PLATFORM_ASSETS);
  if (native) return [native];
  return [];
}

async function ensureFfmpeg(options = {}) {
  const required = Boolean(options.required);
  const platforms = resolvePlatforms({ platforms: options.platforms, required });
  if (platforms.length === 0) {
    console.log('[setup-ffmpeg] Nothing to prepare for this host (pass --platform= or --required).');
    return { ok: true, skipped: true };
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const missing = [];
  for (const platform of platforms) {
    const asset = PLATFORM_ASSETS[platform];
    if (!asset) {
      throw new Error(`Unknown ffmpeg platform: ${platform}`);
    }
    const target = path.join(OUTPUT_DIR, asset);
    if (isNonEmptyFile(target)) {
      console.log(`[setup-ffmpeg] ${platform} already prepared: ${target}`);
      continue;
    }
    const envArchive = process.env.IDBOTS_FFMPEG_ARCHIVE;
    if (envArchive && fs.existsSync(envArchive)) {
      console.log(`[setup-ffmpeg] ${platform}: copying from IDBOTS_FFMPEG_ARCHIVE`);
      fs.copyFileSync(envArchive, target);
    } else {
      const urlFromEnv = typeof process.env.IDBOTS_FFMPEG_URL === 'string'
        ? process.env.IDBOTS_FFMPEG_URL.trim()
        : '';
      const url = urlFromEnv
        ? urlFromEnv.replace('{{platform}}', platform)
        : `${DEFAULT_FFMPEG_BASE_URL}/${REMOTE_ASSETS[platform] || asset}`;
      try {
        console.log(`[setup-ffmpeg] ${platform}: downloading from ${url}`);
        await downloadBinary(url, target);
      } catch (error) {
        if (!required) {
          console.warn(
            `[setup-ffmpeg] ${platform}: download failed and --required is not set; skipping. `
            + `Reason: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
        throw error;
      }
    }
    if (process.platform !== 'win32') {
      fs.chmodSync(target, 0o755);
    }
    const sizeMB = (fs.statSync(target).size / 1024 / 1024).toFixed(1);
    console.log(`[setup-ffmpeg] ${platform} ready (~${sizeMB} MB): ${target}`);
    if (!isNonEmptyFile(target)) missing.push(platform);
  }
  if (missing.length) {
    throw new Error(`ffmpeg binaries failed verification: ${missing.join(', ')}`);
  }
  return { ok: true, skipped: false };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await ensureFfmpeg({ required: args.required, platforms: args.platforms });
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[setup-ffmpeg] ERROR:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

module.exports = { ensureFfmpeg, PLATFORM_ASSETS, REMOTE_ASSETS };
