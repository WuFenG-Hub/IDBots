// Motion Video Arena — static/structural checks (gate G3).
//
// Covers the parts that are structural rather than behavioral:
//   - the package is actually git-tracked under the .gitignore exception
//     (local directory presence is not delivery evidence)
//   - APP.md frontmatter follows the bundled-app registration contract
//   - every local asset reference is relative (no site-root paths)
//   - blindness: the pre-vote UI renders no publisher/model/score data
//   - text-safe rendering, no storage persistence, unload warning
//   - write posture: Browser bridge only, no REST/wallet fallback
//   - keyboard focus visibility and narrow-screen stacked layout exist

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(repoRoot, 'METAAPPs', 'motion-video-arena');

function read(relativePath) {
  return fs.readFileSync(path.join(appDir, relativePath), 'utf8');
}

function functionBody(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `app.js must define ${name}()`);
  const next = source.indexOf('\n  function ', start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

test('arena source is tracked by git under the .gitignore whitelist', () => {
  const tracked = execFileSync('git', ['ls-files', 'METAAPPs/motion-video-arena'], { cwd: repoRoot })
    .toString()
    .split('\n')
    .filter(Boolean)
    .sort();
  assert.deepEqual(tracked, [
    'METAAPPs/motion-video-arena/APP.md',
    'METAAPPs/motion-video-arena/app.js',
    'METAAPPs/motion-video-arena/index.html',
    'METAAPPs/motion-video-arena/styles.css',
  ]);
  const gitignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
  assert.match(gitignore, /!METAAPPs\/motion-video-arena\/\n/);
  assert.match(gitignore, /!METAAPPs\/motion-video-arena\/\*\*\n/);
});

test('APP.md frontmatter follows the bundled registration contract', () => {
  const manifest = read('APP.md');
  assert.match(manifest, /^---\n[\s\S]*?name: motion-video-arena/);
  assert.match(manifest, /entry: \/motion-video-arena\/index\.html/);
  assert.match(manifest, /source-type: bundled-idbots/);
  assert.match(manifest, /creator-metaid: idbots/);
  assert.match(manifest, /version: \d+\.\d+\.\d+/);
  // Documentation required by arena-metaapp-requirements §2.
  assert.match(manifest, /browser\.actor\.current/);
  assert.match(manifest, /metaid\.pin\.write/);
  assert.match(manifest, /file\.metaid\.io\/metafile-indexer\/api\/v1\/files\/accelerate\/content\//);
  assert.match(manifest, /\/protocols\/preference\/feedback/);
  assert.match(manifest, /comparison-batch/);
});

test('every local asset reference in the package is relative', () => {
  const html = read('index.html');
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const value = match[1];
    assert.ok(
      value.startsWith('./') || value.startsWith('#'),
      `index.html local reference must be relative: ${value}`,
    );
  }
  for (const source of [read('app.js'), read('styles.css')]) {
    assert.doesNotMatch(source, /(src|href)\s*[:=]\s*["']\/(?!\/)/, 'no site-root absolute asset paths');
    assert.doesNotMatch(source, /url\(\s*["']?\//, 'no CSS url() site-root references');
  }
});

test('pre-vote UI stays blind: panes and vote block render no author/model/score data', () => {
  const js = read('app.js');
  for (const name of ['videoPane', 'renderCompare', 'queueItemSummary']) {
    const body = functionBody(js, name);
    for (const leak of ['publisher', 'builderModel', 'learningMode', 'preference', 'modelName']) {
      assert.ok(!body.includes(leak), `${name}() must not render "${leak}" data`);
    }
  }
  // The global "eliminated" concept does not exist in the client at all.
  assert.doesNotMatch(js, /eliminat/i);
});

test('rendering is text-safe by construction (no raw innerHTML with chain data)', () => {
  const js = read('app.js');
  assert.doesNotMatch(js, /innerHTML/);
  assert.doesNotMatch(js, /outerHTML/);
  assert.doesNotMatch(js, /insertAdjacentHTML/);
  assert.doesNotMatch(js, /document\.write/);
});

test('queue is volatile: no storage persistence, unload warning present', () => {
  const js = read('app.js');
  assert.doesNotMatch(js, /localStorage|sessionStorage|indexedDB/);
  assert.match(js, /beforeunload/);
  // No watch-time/telemetry capture anywhere (no clock reads, no playback
  // event listeners that could feed a payload).
  assert.doesNotMatch(js, /watchTime|timeupdate|playedFor|performance\.now|Date\.now/);
});

test('write posture: Browser bridge only — no REST write, wallet, or signer fallback', () => {
  const js = read('app.js');
  assert.match(js, /window\.AgentBrowser/);
  assert.match(js, /metaid\.pin\.write/);
  assert.match(js, /browser\.actor\.current/);
  assert.doesNotMatch(js, /method:\s*['"]POST['"]/);
  assert.doesNotMatch(js, /XMLHttpRequest/);
  assert.doesNotMatch(js, /mnemonic|privateKey|signTransaction|sendRawTransaction/);
  // The MetaApp never passes an Actor id into the write call.
  const writeCall = js.slice(js.indexOf("'metaid.pin.write'"), js.indexOf("'metaid.pin.write'") + 700);
  assert.doesNotMatch(writeCall, /actorId|actor:/);
});

test('keyboard accessibility: focus visibility, accessible names, native controls', () => {
  const css = read('styles.css');
  assert.match(css, /:focus-visible/);
  assert.match(css, /outline:\s*3px solid/);
  const js = read('app.js');
  // Every interactive control is a native button/input; removable queue items
  // and both video panes carry accessible names.
  assert.ok((js.match(/'aria-label':/g) || []).length >= 5, 'aria-labels on controls and panes');
  assert.match(js, /role: 'group'/);
  const html = read('index.html');
  for (const id of ['submit-button', 'next-pair-button']) {
    assert.match(html, new RegExp(`<button type="button" id="${id}"`));
  }
});

test('narrow screens stack the two players vertically', () => {
  const css = read('styles.css');
  const narrow = css.slice(css.indexOf('@media (max-width: 860px)'));
  assert.ok(narrow.length > 0, 'narrow breakpoint exists');
  assert.match(narrow, /grid-template-columns:\s*minmax\(0,\s*1fr\)/, 'single-column compare grid when narrow');
  // Each pane keeps its Left/Right heading so votes stay associated.
  const js = read('app.js');
  assert.match(js, /Left video/);
  assert.match(js, /Right video/);
});
