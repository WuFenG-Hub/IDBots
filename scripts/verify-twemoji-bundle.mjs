#!/usr/bin/env node
/**
 * Build-time invariant for the embedded Twemoji emoji pipeline (desktop renderer).
 *
 * Guards against the "dev renders Twemoji, the packaged build silently falls
 * back to system font glyphs" class of regression. The artwork is delivered as
 * SOURCE-EMBEDDED data URI literals in src/renderer/components/chat/twemoji.ts
 * (decoupled from bundler asset emission — the shipped 1.0.9 package carried
 * the pipeline code but none of the artwork). After `vite build`, the built JS
 * under dist/ must carry the FULL set:
 *
 *   1. ≥85 occurrences of `data:image/svg+xml` in the built JS, and every one
 *      of the 85 manifest literals byte-identical to the on-disk asset's
 *      expected encoding (module ↔ asset-dir mirror), and
 *   2. every one of the 85 catalog manifest keys (the emoji chars) present
 *      literally in the built JS, and
 *   3. NO emitted twemoji svg asset files under dist/ — a reappearance of
 *      `new URL(…, import.meta.url)`-style emission is itself a regression
 *      (emitted assets are exactly what vanished from the 1.0.9 package).
 *
 * Wired as the tail of `pnpm run build` (`tsc && vite build && node …`), so a
 * regression turns the BUILD red — before packaging, CI, or a user ever sees a
 * fallback glyph. Standalone: `pnpm run check:twemoji-bundle` (requires a prior
 * build; it inspects dist/ only, never the dev server).
 *
 * Exit codes: 0 = invariant holds, 1 = invariant violated (diagnostics printed).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(repoRoot, 'src/renderer/components/chat/twemoji.ts');
const ASSETS_DIR = path.join(repoRoot, 'src/renderer/components/chat/assets/twemoji');
const DIST_DIR = path.join(repoRoot, 'dist');

const die = (message) => {
  console.error(`✗ twemoji-bundle: ${message}`);
  process.exit(1);
};

// Mirrors Vite's svgToDataURL non-text branch — the exact encoding the source
// literals were generated with (scripts/generate-twemoji-manifest.mjs).
const svgToDataUri = (content) => {
  if (content.includes('<text') || content.includes('<foreignObject')) {
    die('svg carries <text>/<foreignObject> — encoding branch not covered by this gate');
  }
  return (
    'data:image/svg+xml,' +
    content
      .replace(/"/g, "'")
      .replace(/%/g, '%25')
      .replace(/#/g, '%23')
      .replace(/</g, '%3c')
      .replace(/>/g, '%3e')
      .replace(/\?/g, '%3f')
      .replace(/\[/g, '%5b')
      .replace(/\]/g, '%5d')
      .replace(/\\/g, '%5c')
      .replace(/\{/g, '%7b')
      .replace(/\}/g, '%7d')
      .replace(/\|/g, '%7c')
      .replace(/\^/g, '%5e')
      .replace(/`/g, '%60')
      .replace(/\s/g, '%20')
  );
};

// --- 1) Manifest ground truth: 85 `"char": "data:image/svg+xml,…"` literals,
// each byte-identical to the on-disk asset's expected encoding (module ↔ dir mirror).
const manifestSrc = fs.readFileSync(MANIFEST, 'utf-8');
const literalRe = /"((?:[^"\\]|\\.)+)"\s*:\s*"(data:image\/svg\+xml,([^"]*))"/g;
const legacyRe = /"((?:[^"\\]|\\.)+)"\s*:\s*new URL\('\.\/assets\/twemoji\//g;
if (legacyRe.test(manifestSrc)) {
  die('manifest uses the legacy new URL(…, import.meta.url) form — bundler-dependent delivery is banned; run scripts/generate-twemoji-manifest.mjs');
}
const entries = [...manifestSrc.matchAll(literalRe)].map((m) => ({ char: m[1], uri: m[2], payload: m[3] }));
if (entries.length !== 85) die(`manifest parse found ${entries.length} data URI entries, expected 85`);
const chars = entries.map((e) => e.char);
if (new Set(chars).size !== entries.length) die('manifest carries duplicate emoji chars');
const onDisk = fs.readdirSync(ASSETS_DIR).filter((f) => f.endsWith('.svg'));
const expectedByChar = new Map();
// Map each manifest char to its upstream asset file name (hex codepoints minus fe0f).
const twemojiFileName = (ch) =>
  [...ch].map((cp) => cp.codePointAt(0).toString(16)).filter((h) => h !== 'fe0f').join('-') + '.svg';
for (const e of entries) {
  const file = twemojiFileName(e.char);
  if (!onDisk.includes(file)) die(`manifest char ${e.char} has no on-disk asset: ${file}`);
  const expected = svgToDataUri(fs.readFileSync(path.join(ASSETS_DIR, file), 'utf-8'));
  if (expected !== e.uri) {
    die(`module literal for ${e.char} differs from the on-disk asset encoding (${file}) — regenerate via scripts/generate-twemoji-manifest.mjs`);
  }
  expectedByChar.set(e.char, expected);
}
const stray = onDisk.filter((f) => !entries.some((e) => twemojiFileName(e.char) === f));
if (stray.length) die(`assets dir carries files outside the manifest: ${stray.join(', ')}`);

// --- 2) Collect the built JS (all chunks — the manifest may land in any of them).
if (!fs.existsSync(DIST_DIR)) die('dist/ not found — run the vite build first');
const jsFiles = [];
const walk = (dir) => {
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, dirent.name);
    if (dirent.isDirectory()) walk(p);
    else if (dirent.isFile() && dirent.name.endsWith('.js')) jsFiles.push(p);
  }
};
walk(DIST_DIR);
if (!jsFiles.length) die('no .js files under dist/ — the build produced nothing scannable');
const combined = jsFiles.map((p) => fs.readFileSync(p, 'utf-8')).join('\n');

// --- 3) Built-output assertions.
const uriCount = (combined.match(/data:image\/svg\+xml/g) ?? []).length;
const missingUris = [...expectedByChar.entries()]
  .filter(([, uri]) => !combined.includes(uri))
  .map(([ch]) => ch);
const missingKeys = chars.filter((ch) => !combined.includes(ch));

// --- 4) Negative check: emitted twemoji svg assets must not reappear under dist/.
const stems = new Set(entries.map((e) => twemojiFileName(e.char).replace(/\.svg$/, '')));
const emitted = [];
const walkFiles = (dir) => {
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, dirent.name);
    if (dirent.isDirectory()) walkFiles(p);
    else if (dirent.isFile()) {
      const m = dirent.name.match(/^([0-9a-z-]+)(?:-[A-Za-z0-9_-]+)?\.svg$/);
      if (m && stems.has(m[1])) emitted.push(path.relative(DIST_DIR, p));
    }
  }
};
walkFiles(DIST_DIR);

// --- Verdict.
if (uriCount < 85 || missingUris.length > 0 || missingKeys.length > 0 || emitted.length > 0) {
  console.error('✗ twemoji-bundle invariant FAILED');
  if (uriCount < 85) console.error(`  only ${uriCount} 'data:image/svg+xml' occurrences in built JS, need ≥85`);
  if (missingUris.length) console.error(`  manifest literals absent from dist JS (${missingUris.length}/85): ${missingUris.join(' ')}`);
  if (missingKeys.length) console.error(`  manifest keys absent from dist JS (${missingKeys.length}/85): ${missingKeys.join(' ')}`);
  if (emitted.length) console.error(`  bundler-emitted twemoji svg assets reappeared under dist (banned): ${emitted.join(', ')}`);
  console.error(`  scanned ${jsFiles.length} built JS files`);
  process.exit(1);
}
console.log(`✓ twemoji-bundle invariant PASSED: ${uriCount} 'data:image/svg+xml' occurrences; 85/85 manifest literals byte-identical to the on-disk assets; 85/85 manifest keys present; 0 emitted twemoji svg assets across ${jsFiles.length} built JS files.`);
