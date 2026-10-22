#!/usr/bin/env node
/**
 * Mobile bundle gzip budgets (REQ-E-19), checked at the end of
 * `pnpm run build:mobile`:
 *
 *   - dist-mobile-login/  total gzip of every emitted asset  <= 80 KB
 *     (single-entry build; the login page is served before any session)
 *   - dist-mobile/        gzip of the entry JS plus everything it statically
 *     imports (closure from the vite manifest)                 <= 500 KB
 *     (lazy chunks excluded)
 *
 * No new dependencies: gzip via node:zlib, initial-asset closure via the
 * vite manifest (build.manifest: true in vite.mobile.config.ts).
 */

import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const BUDGETS = [
  {
    name: 'login (dist-mobile-login)',
    outDir: 'dist-mobile-login',
    limitBytes: 80 * 1024,
    // Login: every emitted asset counts toward the single initial payload.
    mode: 'all-assets',
    filter: (file) => file.endsWith('.js') || file.endsWith('.css'),
  },
  {
    name: 'app initial JS (dist-mobile)',
    outDir: 'dist-mobile',
    limitBytes: 500 * 1024,
    // App: only the entry's static import closure (lazy chunks excluded).
    mode: 'initial-js',
    filter: (file) => file.endsWith('.js'),
  },
];

function readManifest(outDir) {
  const manifestPath = path.join(outDir, '.vite', 'manifest.json');
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    console.error(`[mobile-budgets] cannot read ${manifestPath}: ${error.message}`);
    console.error('[mobile-budgets] run `pnpm run build:mobile` first (build.manifest is required).');
    process.exit(1);
  }
}

function collectAllAssets(outDir, filter) {
  const assets = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name !== 'manifest.json' && filter(entry.name)) assets.push(full);
    }
  };
  walk(outDir);
  return assets;
}

/** Entry chunk plus everything reachable through static `imports`. */
function collectInitialAssets(outDir, filter) {
  const manifest = readManifest(outDir);
  const files = new Set();
  const visit = (key) => {
    const chunk = manifest[key];
    if (!chunk || !chunk.file) return;
    if (filter(chunk.file)) files.add(path.join(outDir, chunk.file));
    for (const imported of chunk.imports ?? []) visit(imported);
  };
  for (const [key, chunk] of Object.entries(manifest)) {
    if (chunk.isEntry && chunk.file) {
      if (filter(chunk.file)) files.add(path.join(outDir, chunk.file));
      for (const imported of chunk.imports ?? []) visit(imported);
      for (const css of chunk.css ?? []) {
        if (filter(css)) files.add(path.join(outDir, css));
      }
    }
  }
  return [...files];
}

let failed = false;

for (const budget of BUDGETS) {
  let files;
  try {
    files =
      budget.mode === 'all-assets'
        ? collectAllAssets(budget.outDir, budget.filter)
        : collectInitialAssets(budget.outDir, budget.filter);
  } catch (error) {
    console.error(`[mobile-budgets] ${budget.name}: ${error.message}`);
    failed = true;
    continue;
  }
  if (files.length === 0) {
    console.error(`[mobile-budgets] ${budget.name}: no assets found in ${budget.outDir}`);
    failed = true;
    continue;
  }

  let total = 0;
  const rows = files
    .map((file) => {
      const size = statSync(file).size;
      const gz = gzipSync(readFileSync(file)).length;
      total += gz;
      return { file: path.relative(budget.outDir, file), size, gz };
    })
    .sort((a, b) => b.gz - a.gz);

  const ok = total <= budget.limitBytes;
  if (!ok) failed = true;
  console.log(`\n[mobile-budgets] ${budget.name}: ${(total / 1024).toFixed(1)} KB gzip ` +
    `(limit ${(budget.limitBytes / 1024).toFixed(0)} KB) — ${ok ? 'OK' : 'OVER BUDGET'}`);
  for (const row of rows) {
    console.log(
      `  ${(row.gz / 1024).toFixed(1).padStart(7)} KB gzip  ${(row.size / 1024).toFixed(1).padStart(7)} KB raw  ${row.file}`,
    );
  }
}

if (failed) {
  console.error('\n[mobile-budgets] budgets exceeded — see table above.');
  process.exit(1);
}
console.log('\n[mobile-budgets] all budgets within limits.');
