// Static guard for the accent-fill legibility rule: NO element may render
// white text/icons on the yellow accent fill (bg-claude-accent). White on
// #FFDC51 is nearly illegible; content on the accent fill must use the
// deep-orange accentInk token (#9A3412, matching .btn-idchat-primary-filled —
// the old near-black #303133 was retired as too harsh on the eyes).
// Semantic error fills (red/green) keep their white text and are out of scope.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const rendererRoot = join(here, '../src/renderer');

const collectSourceFiles = (dir) => {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (/\.(tsx|ts)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
};

test('no white text shares a className line with the yellow accent fill', () => {
  const offenders = [];
  for (const file of collectSourceFiles(rendererRoot)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (line.includes('bg-claude-accent') && /\btext-white\b/.test(line)) {
        offenders.push(`${file.replace(rendererRoot + '/', '')}:${index + 1}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    'yellow-fill lines must use text-claude-accentInk, not text-white (white on #FFDC51 is illegible)',
  );
});

test('accentInk token is defined and is the shared deep-orange on yellow', () => {
  const tailwind = readFileSync(join(here, '../tailwind.config.js'), 'utf8');
  assert.match(tailwind, /accentInk: '#9A3412'/);
  // The shared filled-button class keeps the same ink color.
  const css = readFileSync(join(here, '../src/renderer/index.css'), 'utf8');
  const filled = css.slice(css.indexOf('.btn-idchat-primary-filled'));
  assert.match(filled.slice(0, 220), /color: #9A3412/);
});
