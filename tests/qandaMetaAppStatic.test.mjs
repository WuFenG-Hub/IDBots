import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(repoRoot, 'METAAPPs', 'qanda');

function read(relativePath) {
  return fs.readFileSync(path.join(appDir, relativePath), 'utf8');
}

test('qanda bundled app ships the manifest and entry assets', () => {
  const manifest = read('APP.md');
  assert.match(manifest, /^---\n[\s\S]*?name: qanda-app/);
  assert.match(manifest, /entry: \/qanda\/app\/index\.html/);
  assert.match(manifest, /source-type: bundled-idbots/);
  assert.match(manifest, /creator-metaid: idbots/);
  // Version must be semver so the bundled-sync upgrade comparison works.
  assert.match(manifest, /version: \d+\.\d+\.\d+/);
  for (const file of ['app/index.html', 'app/app.js', 'app/app.css']) {
    assert.ok(fs.existsSync(path.join(appDir, file)), `${file} exists`);
  }
  const html = read('app/index.html');
  assert.match(html, /href="\.\/app\.css"/);
  assert.match(html, /src="\.\/app\.js"/);
});

test('qanda app reads the public QA APIs directly (buzz-app posture) and escapes rendered text', () => {
  const js = read('app/app.js');
  assert.match(js, /so\.metaid\.io/);
  assert.match(js, /\/api\/qa\/questions/);
  assert.match(js, /\/api\/metaweb\/pin\//);
  // Feed modes: latest + unanswered (maxAnswers=0).
  assert.match(js, /maxAnswers=0/);
  // XSS discipline: every interpolated string goes through escapeHtml or textContent.
  assert.ok((js.match(/escapeHtml\(/g) || []).length >= 10, 'escapeHtml is used for interpolations');
  assert.match(js, /textContent/);
  // Read-only viewer: no write calls, no wallet/metafile endpoints.
  assert.doesNotMatch(js, /paylike|post_simple|metafile-uploader|assist-open-api/);
});
