#!/usr/bin/env node
/**
 * Production-bundle gate for the embedded Twemoji pipeline (mobile).
 *
 * Artwork delivery contract (post desktop-1.0.9-asar incident; unified with the
 * desktop gate scripts/verify-twemoji-bundle.mjs): every Twemoji artwork must
 * reach users as an EMBEDDED `data:image/svg+xml,...` string literal carried
 * inside src/renderer/components/chat/twemoji.ts itself (85 literals, Vite
 * svgToDataURL encoding) and inside the built chunks — never as a
 * bundler-emitted asset file (asar / tenant-image dir copies are exactly where
 * emitted files get lost, after which <img> fails and Chromium shows the alt
 * codepoint: "dev fine, packaged fallback").
 *
 * Checks against dist-mobile/ (the app bundle; the login bundle has no chat
 * faces and legitimately tree-shakes the pipeline out):
 *   1. twemoji.ts parses to exactly 85 `"char": "data:image/svg+xml,…"`
 *      literal entries; `new URL(` is FORBIDDEN in the manifest (regression to
 *      packager-dependent delivery).
 *   2. Each literal equals `data:image/svg+xml,` + the Vite-svgToDataURL
 *      encoding of the vendored SVG bytes (module ↔ asset-dir mirror — the
 *      same expectation the desktop gate reconstructs).
 *   3. Every one of the 85 expected literals appears verbatim in a built
 *      chunk, the chunks contain >= 85 `data:image/svg+xml` occurrences, and
 *      every emoji key (raw UTF-8 or \uXXXX escapes) appears in the chunks.
 *      Emitted asset FILES do not count — embedded strings only.
 *   4. No runtime CDN reference: no http(s) URL containing "twemoji" may
 *      appear in any built chunk (assets are embedded locally only).
 *
 * Exit codes: 0 pass, 1 fail (each failing group listed individually).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_SOURCE = path.join(REPO_ROOT, 'src/renderer/components/chat/twemoji.ts');
const ASSETS_DIR = path.join(REPO_ROOT, 'src/renderer/components/chat/assets/twemoji');
const DIST_DIR = path.join(REPO_ROOT, 'dist-mobile');
const EXPECTED_COUNT = 85;

function fail(message) {
  console.error(`[check-mobile-twemoji-bundle] FAIL — ${message}`);
  process.exit(1);
}

/** Mirrors Vite's svgToDataURL non-text branch — the encoding the twemoji.ts literals use. */
function svgToDataUri(content) {
  if (content.includes('<text') || content.includes('<foreignObject')) {
    fail('svg carries <text>/<foreignObject> — encoding branch not covered by this gate');
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
}

/** Upstream asset stem for an emoji char: hex codepoints minus fe0f (✌️ -> 270c). */
const twemojiStem = (ch) =>
  [...ch]
    .map((c) => c.codePointAt(0).toString(16))
    .filter((h) => h !== 'fe0f')
    .join('-');

/** Strip block and line comments so doc mentions of the old URL form don't false-trip the regression check. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// --- 1. Manifest source of truth --------------------------------------------

const manifestSource = readFileSync(MANIFEST_SOURCE, 'utf8');
if (stripComments(manifestSource).includes('new URL(')) {
  fail('twemoji.ts regressed to packager-dependent `new URL(...)` asset delivery — embedded data URI literals are the contract (run scripts/generate-twemoji-manifest.mjs)');
}
const literalRe = /"((?:[^"\\]|\\.)+)"\s*:\s*"(data:image\/svg\+xml,([^"\\]*))"/g;
const entries = [...manifestSource.matchAll(literalRe)].map((m) => ({
  key: JSON.parse(`"${m[1]}"`),
  uri: m[2],
}));
if (entries.length !== EXPECTED_COUNT) {
  fail(`manifest in twemoji.ts parsed to ${entries.length} embedded data URI literals, expected ${EXPECTED_COUNT}`);
}
const keys = entries.map((entry) => entry.key);
if (new Set(keys).size !== EXPECTED_COUNT) fail('manifest emoji keys are not unique');
const stems = entries.map((entry) => twemojiStem(entry.key));
if (new Set(stems).size !== EXPECTED_COUNT) fail('manifest asset stems are not unique');

const bundledStems = new Set(
  readdirSync(ASSETS_DIR)
    .filter((name) => name.endsWith('.svg'))
    .map((name) => name.slice(0, -'.svg'.length)),
);
const missingOnDisk = stems.filter((stem) => !bundledStems.has(stem));
if (missingOnDisk.length > 0) {
  fail(`catalog stems missing from assets/twemoji/: ${missingOnDisk.join(', ')}`);
}
const strayStems = [...bundledStems].filter((stem) => !stems.includes(stem));
if (strayStems.length > 0) {
  fail(`assets dir carries files outside the manifest: ${strayStems.map((s) => `${s}.svg`).join(', ')}`);
}

// --- 2. Literals are in sync with the vendored SVGs ---------------------------

const expectedByStem = new Map(
  stems.map((stem) => [
    stem,
    svgToDataUri(readFileSync(path.join(ASSETS_DIR, `${stem}.svg`), 'utf8')),
  ]),
);
const drifted = entries.filter((entry, i) => entry.uri !== expectedByStem.get(stems[i]));
if (drifted.length > 0) {
  fail(`twemoji.ts literals drift from assets/twemoji/ bytes for ${drifted.length} chars (e.g. ${drifted.slice(0, 5).map((e) => e.key).join(', ')}) — regenerate via scripts/generate-twemoji-manifest.mjs`);
}

// --- 3. Built bundle scan ----------------------------------------------------

if (!statSync(DIST_DIR, { throwIfNoEntry: false })) {
  fail('dist-mobile/ does not exist — run the mobile production build (MOBILE_BUNDLE=app) first.');
}

const files = [];
(function listFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full);
    else if (['.js', '.html', '.css'].some((ext) => entry.name.endsWith(ext))) files.push(full);
  }
})(DIST_DIR);

const jsFiles = files.filter((file) => file.endsWith('.js'));
if (jsFiles.length === 0) fail('dist-mobile/ contains no .js chunks');
const chunkBlob = jsFiles.map((file) => readFileSync(file, 'utf8')).join('\n');

const missingArtwork = stems.filter((stem) => !chunkBlob.includes(expectedByStem.get(stem)));
if (missingArtwork.length > 0) {
  fail(`${missingArtwork.length}/${EXPECTED_COUNT} embedded artworks are missing from the built chunks (e.g. ${missingArtwork.slice(0, 5).join(', ')})`);
}
const dataUriHits = chunkBlob.split('data:image/svg+xml').length - 1;
if (dataUriHits < EXPECTED_COUNT) {
  fail(`only ${dataUriHits} 'data:image/svg+xml' occurrences in built chunks, expected >= ${EXPECTED_COUNT}`);
}

const escapeForm = (key) =>
  [...key].map((ch) => {
    const code = ch.codePointAt(0);
    return code > 0x7e ? `\\u${code.toString(16).padStart(4, '0')}` : ch;
  }).join('');
const keysMissingFromChunks = keys.filter(
  (key) => !chunkBlob.includes(key) && !chunkBlob.includes(escapeForm(key)),
);
if (keysMissingFromChunks.length > 0) {
  fail(`${keysMissingFromChunks.length}/${EXPECTED_COUNT} manifest emoji keys are missing from built chunks (e.g. ${keysMissingFromChunks.slice(0, 5).map((k) => JSON.stringify(k)).join(', ')})`);
}

// --- 4. No runtime CDN --------------------------------------------------------

const cdnOffenders = jsFiles.filter((file) => /https?:\/\/[^\s"'`]*twemoji/i.test(readFileSync(file, 'utf8')));
if (cdnOffenders.length > 0) {
  fail(`runtime twemoji CDN reference leaked into: ${cdnOffenders.map((file) => path.relative(REPO_ROOT, file)).join(', ')} (artwork must stay embedded)`);
}

console.log(
  `[check-mobile-twemoji-bundle] PASS — ${EXPECTED_COUNT}/${EXPECTED_COUNT} emoji keys and ${EXPECTED_COUNT}/${EXPECTED_COUNT} embedded data-URI artworks found in dist-mobile chunks (${dataUriHits} 'data:image/svg+xml' occurrences), manifest is new-URL-free, no runtime CDN.`,
);
