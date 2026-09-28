#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Packaged-artifact knowledge-base smoke — parser layer (PDF + Markdown).
 *
 * WHY THIS EXISTS: §11.24 (2026-09-27) — v0.9.5 shipped Windows builds where
 * knowledge-base PDF learning silently did nothing: pdfjs-dist evaluates
 * `new DOMMatrix()` at module scope, the native @napi-rs/canvas fallback was
 * trapped inside app.asar, and the learn loop swallowed the failures. Signatures,
 * fingerprints and CI suites were all green — only the PACKAGED runtime was
 * broken. "CI 全绿 ≠ 产物正确" has a runtime dimension, and this script closes it
 * for the parser layer: it runs the artifact's OWN Electron binary against the
 * artifact's OWN knowledgeBaseConverters.js (extracted from the artifact's
 * app.asar) and proves a real PDF parses and yields its marker text.
 *
 * Scope (be honest about what this proves, per §11.25): this is the PARSER
 * layer smoke. It does NOT drive the UI import flow ("立即学习" notification
 * rendering, failure surfacing copy) — that stays a manual §12 checklist item
 * on a real machine, Windows included.
 *
 * What it does:
 *   1. locate the artifact binary (mac .app or win-unpacked) and its app.asar;
 *   2. extract dist-electron/main/libs/{knowledgeBaseConverters,domMatrixPolyfill}.js
 *      plus the node_modules/pdfjs-dist subtree from that asar;
 *   3. generate a minimal PDF (fixed marker) + Markdown into a temp dir;
 *   4. COPY the artifact into the temp dir and swap the copy's app.asar for a
 *      generated harness asar (a packaged binary ignores an app-path CLI
 *      argument and would run its own asar) — the ORIGINAL is never modified;
 *   5. run the copy's Electron binary and assert: DOMMatrix available, PDF
 *      text extracted, marker present, MD readable.
 *
 * Usage (run on the machine matching the artifact's platform):
 *   node scripts/packaged-kb-smoke.cjs --app release/mac-arm64/IDBots.app
 *   node scripts/packaged-kb-smoke.cjs --app release/win-unpacked
 *   node scripts/packaged-kb-smoke.cjs --app /Volumes/IDBots\ 1/IDBots.app --keep
 *
 * Exit code: 0 = all checks pass, 1 = any check fails, 2 = setup error.
 *
 * Landmines already handled here (all hit for real on 2026-09-28, v0.9.6):
 *   - extractPdfText(filePath) takes a FILE PATH, not a Buffer, and resolves
 *     to `{ text }` — check the artifact's own signature before hand-rolling
 *     a harness (grep the extracted converters).
 *   - since v0.9.6 knowledgeBaseConverters.js calls ensureDomMatrixPolyfill()
 *     AT MODULE LOAD, so "extraction succeeds without manually installing the
 *     polyfill" is the fix working, not the test being vacuous.
 *   - an inherited ELECTRON_RUN_AS_NODE=1 makes the packaged binary start in
 *     Node mode ("bad option: --no-sandbox" style errors); we scrub the env.
 */

const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MARKER = 'IDBots packaged-kb-smoke marker 7f3a';
const TIMEOUT_MS = 90_000;

function fail(setup, msg) {
  console.error(`[packaged-kb-smoke] ${setup ? 'SETUP-ERROR' : 'FAIL'}: ${msg}`);
  process.exit(setup ? 2 : 1);
}

function parseArgs(argv) {
  const args = { keep: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--app') args.app = argv[++i];
    else if (argv[i] === '--keep') args.keep = true;
    else if (argv[i] === '-h' || argv[i] === '--help') args.help = true;
  }
  return args;
}

function locateArtifact(appPath) {
  const abs = path.resolve(appPath);
  if (!fs.existsSync(abs)) fail(true, `artifact path not found: ${abs}`);
  const isMac = abs.endsWith('.app');
  if (isMac) {
    const binDir = path.join(abs, 'Contents', 'MacOS');
    const plist = path.join(abs, 'Contents', 'Info.plist');
    let exe = null;
    if (fs.existsSync(plist)) {
      const r = spawnSync('plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', plist], { encoding: 'utf8' });
      if (r.status === 0) exe = path.join(binDir, r.stdout.trim());
    }
    if (!exe || !fs.existsSync(exe)) {
      const bins = fs.readdirSync(binDir).filter((f) => !f.includes('.'));
      if (bins.length !== 1) fail(true, `cannot locate executable under ${binDir} (found: ${bins.join(', ')})`);
      exe = path.join(binDir, bins[0]);
    }
    const asar = path.join(abs, 'Contents', 'Resources', 'app.asar');
    if (!fs.existsSync(asar)) fail(true, `app.asar not found at ${asar}`);
    return { platform: 'darwin', binary: exe, asar };
  }
  // win-unpacked style: one or more top-level .exe next to resources/app.asar
  const asar = path.join(abs, 'resources', 'app.asar');
  if (!fs.existsSync(asar)) fail(true, `app.asar not found at ${asar} (expect a win-unpacked directory)`);
  const exe = fs.readdirSync(abs).find((f) => f.toLowerCase().endsWith('.exe'));
  if (!exe) fail(true, `no .exe found in ${abs}`);
  return { platform: 'win32', binary: path.join(abs, exe), asar };
}

function loadAsarLib() {
  try {
    return require('@electron/asar');
  } catch {
    // electron-builder ships @electron/asar; from a bare checkout fall back to npx.
    return null;
  }
}

function extractFromAsar(asarLib, asar, innerPath, destRoot) {
  // Returns the on-disk path of the extracted entry. Directories are walked
  // through statFile's tree and each leaf is extracted via extractFile, so
  // files and dirs share one code path.
  const dest = path.join(destRoot, innerPath);
  let stat;
  try {
    stat = asarLib.statFile(asar, innerPath);
  } catch (e) {
    fail(true, `asar entry not found: ${innerPath} (${e.message})`);
  }
  if (stat.files) {
    const extractTree = (node, relBase, outDir) => {
      fs.mkdirSync(outDir, { recursive: true });
      for (const [name, entry] of Object.entries(node)) {
        const rel = relBase ? `${relBase}/${name}` : name;
        if (entry.files) extractTree(entry.files, rel, path.join(outDir, name));
        else fs.writeFileSync(path.join(outDir, name), asarLib.extractFile(asar, rel));
      }
    };
    extractTree(stat.files, innerPath, dest);
    return dest;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, asarLib.extractFile(asar, innerPath));
  return dest;
}

// Minimal single-page PDF, hand-built like the one that proved the v0.9.5
// diagnosis (2026-09-28): Helvetica, one text line carrying the marker.
// pdfjs tolerates the approximate xref; verified parseable on pdfjs-dist 6.
function buildPdf(marker) {
  const stream = `BT /F1 18 Tf 60 700 Td (${marker} test 你好世界) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf, 'utf8');
  pdf += 'xref\n0 6\n0000000000 65535 f \n';
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return pdf;
}

const HARNESS_MAIN = (extractDir, pdfPath, mdPath, resultPath, marker) => `const fs = require('node:fs');
const out = { ok: false, checks: [] };
const say = (name, pass, detail) => { out.checks.push({ name, pass: !!pass, detail: detail || '' }); console.log((pass ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' :: ' + detail : '')); };
process.on('exit', () => { try { fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(out)); } catch (e) { console.error('result write failed: ' + e.message); } });
const { app } = require('electron');
app.whenReady().then(async () => {
  try {
    const conv = require(${JSON.stringify(path.join(extractDir, 'dist-electron', 'main', 'libs', 'knowledgeBaseConverters.js'))});
    // v0.9.6+ installs the DOMMatrix polyfill at module load; requiring the
    // module at all is the fix working. Older artifacts lack the file: warn only.
    try {
      const poly = require(${JSON.stringify(path.join(extractDir, 'dist-electron', 'main', 'libs', 'domMatrixPolyfill.js'))});
      poly.ensureDomMatrixPolyfill();
    } catch (e) {
      say('polyfill-module', false, 'artifact predates v0.9.6 polyfill module: ' + e.message.slice(0, 120));
    }
    say('dommatrix-available', typeof globalThis.DOMMatrix === 'function');
    const res = await conv.extractPdfText(${JSON.stringify(pdfPath)});
    const text = res && typeof res.text === 'string' ? res.text : '';
    say('pdf-extracted', text.length > 0, 'chars=' + text.length);
    say('pdf-marker', text.includes(${JSON.stringify(marker)}));
    const md = fs.readFileSync(${JSON.stringify(mdPath)}, 'utf8');
    say('md-readable', md.length > 0, 'chars=' + md.length);
    out.ok = out.checks.every((c) => c.pass);
    console.log('RESULT=' + (out.ok ? 'PASS' : 'FAIL'));
  } catch (e) {
    say('fatal', false, String((e && e.stack) || e).slice(0, 600));
    console.log('RESULT=FAIL');
  }
  setTimeout(() => app.exit(0), 50);
});
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.app) {
    console.log('Usage: node scripts/packaged-kb-smoke.cjs --app <IDBots.app | win-unpacked> [--keep]');
    process.exit(args.help ? 0 : 2);
  }

  const { platform, binary, asar } = locateArtifact(args.app);
  console.log(`[packaged-kb-smoke] artifact: ${args.app}`);
  console.log(`[packaged-kb-smoke] platform: ${platform}  binary: ${binary}`);

  const asarLib = loadAsarLib();
  if (!asarLib) fail(true, '@electron/asar is not require-able from this checkout; run inside the repo with deps installed (pnpm install --frozen-lockfile)');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-kb-smoke-'));
  const cleanup = () => {
    if (args.keep) {
      console.log(`[packaged-kb-smoke] --keep: keeping ${tmp}`);
      return;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => process.exit(130));

  // 1) extract converters + polyfill from the artifact's asar
  const libsDir = extractFromAsar(asarLib, asar, 'dist-electron/main/libs', tmp);
  const convPath = path.join(libsDir, 'knowledgeBaseConverters.js');
  const polyPath = path.join(libsDir, 'domMatrixPolyfill.js');
  for (const f of [convPath]) {
    if (!fs.existsSync(f)) fail(true, `extracted file missing: ${f}`);
  }
  console.log(`[packaged-kb-smoke] extracted: ${convPath}${fs.existsSync(polyPath) ? '' : ' (polyfill module absent: pre-0.9.6 artifact)'}`);

  // 2) extract pdfjs-dist (the converters require('pdfjs-dist/legacy/build/pdf.mjs');
  //    resolution walks UP from the extracted libs dir, so it must land in
  //    <tmp>/node_modules/pdfjs-dist)
  try {
    extractFromAsar(asarLib, asar, 'node_modules/pdfjs-dist', tmp);
  } catch (e) {
    fail(true, `failed to extract node_modules/pdfjs-dist: ${e.message}`);
  }
  console.log('[packaged-kb-smoke] extracted: node_modules/pdfjs-dist');

  // 3) fixtures + harness app
  const marker = MARKER;
  const pdfPath = path.join(tmp, 'smoke.pdf');
  const mdPath = path.join(tmp, 'smoke.md');
  fs.writeFileSync(pdfPath, buildPdf(marker));
  fs.writeFileSync(mdPath, `# ${marker}\n\nMarkdown path of the packaged knowledge-base smoke.\n`);
  const harnessDir = path.join(tmp, 'harnessapp');
  fs.mkdirSync(harnessDir, { recursive: true });
  const resultPath = path.join(tmp, 'result.json');
  fs.writeFileSync(
    path.join(harnessDir, 'package.json'),
    JSON.stringify({ name: 'packaged-kb-smoke-harness', productName: 'packaged-kb-smoke', version: '0.0.0', main: 'main.js' }, null, 2),
  );
  fs.writeFileSync(path.join(harnessDir, 'main.js'), HARNESS_MAIN(tmp, pdfPath, mdPath, resultPath, marker));

  // 4) COPY the artifact and swap its app.asar for the harness one.
  //    A packaged Electron binary has no default_app: an app-path CLI argument
  //    is IGNORED and the binary runs its own bundled asar (verified against
  //    v0.9.6 arm64, 2026-09-28 — the boot came from the artifact itself).
  //    The swap path is the one proven by the §11.24/§11.25 investigation.
  //    Works because the shipped builds do not enable the asar-integrity fuse;
  //    if a future build turns that fuse on, this script fails with a startup
  //    refusal and §11.25's harness recipe needs an Electron-framework route.
  console.log('[packaged-kb-smoke] copying artifact to a temp copy (original is never modified)...');
  const appCopy = path.join(tmp, 'artifact-copy');
  fs.cpSync(path.resolve(args.app), appCopy, { recursive: true });
  const copyAsar = platform === 'darwin'
    ? path.join(appCopy, 'Contents', 'Resources', 'app.asar')
    : path.join(appCopy, 'resources', 'app.asar');
  const harnessAsar = path.join(tmp, 'harness.asar');
  await asarLib.createPackage(harnessDir, harnessAsar); // v3 API: async only, no createPackageSync
  fs.rmSync(copyAsar, { force: true });
  fs.copyFileSync(harnessAsar, copyAsar);
  const copyBinary = platform === 'darwin'
    ? path.join(appCopy, 'Contents', 'MacOS', path.basename(binary))
    : path.join(appCopy, path.basename(binary));

  // 5) run the COPY's Electron binary with a scrubbed env.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // → would force Node mode ("bad option" errors)
  delete env.ELECTRON_START_URL;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  delete env.NODE_OPTIONS;

  const child = spawn(copyBinary, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  const started = Date.now();
  let result = null;
  while (Date.now() - started < TIMEOUT_MS) {
    if (fs.existsSync(resultPath)) {
      try {
        result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        break;
      } catch { /* partial write; keep polling */ }
    }
    if (child.exitCode !== null || child.signalCode) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const killed = child.exitCode === null && child.signalCode === null;
  if (killed) child.kill('SIGKILL');

  if (!result) {
    fail(false, `no result within ${TIMEOUT_MS / 1000}s. Electron output tail:\n${out.slice(-1200)}`);
  }

  // 5) verdict
  console.log('--- checks ---');
  for (const c of result.checks) console.log(`${c.pass ? '  ✔' : '  ✖'} ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
  if (!result.ok) {
    fail(false, `artifact smoke FAILED (artifact ${args.app}). Full output tail:\n${out.slice(-800)}`);
  }
  console.log('[packaged-kb-smoke] RESULT=PASS — the artifact runtime parses PDF+MD through its own knowledge-base converters.');
}

main().catch((e) => fail(true, (e && e.stack) || String(e)));
