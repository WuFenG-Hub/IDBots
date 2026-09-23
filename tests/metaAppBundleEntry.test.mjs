// Bundled MetaApp entry discipline.
//
// listMetaApps() reads `entry` ONLY from APP.md frontmatter (never from
// metaapps.config.json defaults) and silently skips any app whose entry is
// missing or does not resolve inside its own directory — a bundled app
// without the frontmatter ships invisible. metatask-viz and
// simplelog-timeline both landed that way (release audit 2026-09-19); this
// suite keeps every future bundled app from repeating it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const metaAppsRoot = path.join(repoRoot, 'METAAPPs');

const bundledApps = fs
  .readdirSync(metaAppsRoot)
  .filter((name) => fs.statSync(path.join(metaAppsRoot, name)).isDirectory())
  .filter((name) => fs.existsSync(path.join(metaAppsRoot, name, 'APP.md')));

// Only git-tracked bundled apps ship in the package; locally installed chain
// apps live under METAAPPs/ too but are gitignored. The tracked set today is
// buzz, chat, metatask-viz, qanda, simplelog-timeline.
assert.ok(bundledApps.length >= 5, `expected the tracked bundled METAAPPs set, found ${bundledApps.length}`);
for (const required of ['metatask-viz', 'simplelog-timeline', 'buzz']) {
  assert.ok(bundledApps.includes(required), `expected ${required} to be a tracked bundled MetaApp`);
}

for (const name of bundledApps) {
  test(`bundled MetaApp ${name} declares a resolvable entry`, () => {
    const raw = fs.readFileSync(path.join(metaAppsRoot, name, 'APP.md'), 'utf8').replace(/^\uFEFF/, '');
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(match, `${name}/APP.md has no frontmatter block — listMetaApps() cannot see an entry, so the app ships invisible`);
    const entryLine = match[1]
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^entry:\s*\/\S/.test(line));
    assert.ok(entryLine, `${name}/APP.md is missing an \`entry: /${name}/…\` frontmatter line — the app ships invisible`);
    const entry = entryLine.replace(/^entry:\s*/, '').trim().replace(/^['"]|['"]$/g, '');
    assert.ok(
      entry.startsWith(`/${name}/`),
      `${name} entry must start with /${name}/ (entry resolution rejects paths outside the app directory): ${entry}`,
    );
    const entryFile = path.join(metaAppsRoot, `.${entry}`);
    assert.ok(fs.existsSync(entryFile), `${name} entry file does not exist in the package: ${entry}`);
  });
}
