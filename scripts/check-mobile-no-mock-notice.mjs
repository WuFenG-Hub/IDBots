#!/usr/bin/env node
/**
 * Production-bundle gate for the mobile login demo notice.
 *
 * The notice copy ("演示环境：登录接口为 mock。" / "Demo build: the login API
 * is mocked.") may exist ONLY in VITE_MOBILE_MOCK dev sessions. This gate
 * runs at the tail of `pnpm build:mobile` and fails the production build if
 * either string survives minification into dist-mobile/ or
 * dist-mobile-login/, so the notice cannot quietly ship again.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIRS = ['dist-mobile', 'dist-mobile-login'];
const TEXT_EXTENSIONS = ['.js', '.html', '.css', '.webmanifest', '.json'];
const FORBIDDEN = [
  '演示环境：登录接口为 mock',
  'the login API is mocked',
];

function listFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(full));
    } else if (TEXT_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

const offenders = [];
const missingDirs = [];

for (const distDir of DIST_DIRS) {
  const absolute = path.join(REPO_ROOT, distDir);
  if (!statSync(absolute, { throwIfNoEntry: false })) {
    missingDirs.push(distDir);
    continue;
  }
  for (const file of listFiles(absolute)) {
    const source = readFileSync(file, 'utf8');
    for (const needle of FORBIDDEN) {
      if (source.includes(needle)) {
        offenders.push(`${path.relative(REPO_ROOT, file)}: contains "${needle}"`);
      }
    }
  }
}

if (missingDirs.length === DIST_DIRS.length) {
  console.error(
    `[check-mobile-no-mock-notice] Neither ${DIST_DIRS.join(' nor ')} exists — run the mobile production build first.`,
  );
  process.exit(1);
}

if (offenders.length > 0) {
  console.error('[check-mobile-no-mock-notice] FAIL — demo notice leaked into a production bundle:');
  for (const line of offenders) {
    console.error(`  ${line}`);
  }
  process.exit(1);
}

console.log(
  `[check-mobile-no-mock-notice] PASS — no demo/mock login notice in ${DIST_DIRS.filter((dir) => !missingDirs.includes(dir)).join(' / ')}.`,
);
