import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * P7 (v1.1) regression guard: the acceptance panel once rendered the raw key
 * `groupTasksAcceptanceSummaryTitle` because the key existed in one dictionary
 * only (fixed in b427b616). i18nService falls back to the raw key when a
 * translation is missing, so a gap is invisible until a user sees it.
 *
 * This static test enforces two invariants over the groupTasks UI surface:
 * 1. zh/en parity — every groupTasks* key defined in one dictionary exists in
 *    the other;
 * 2. every groupTasks* key referenced by the groupTasks components (directly
 *    in i18nService.t() calls or as indirect key literals handed to t())
 *    resolves in BOTH dictionaries.
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const i18nSource = fs.readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'services', 'i18n.ts'),
  'utf8',
);

function extractBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `i18n.ts must contain ${startMarker.trim()}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `i18n.ts must contain ${endMarker.trim()} after ${startMarker.trim()}`);
  return source.slice(start, end);
}

const zhBlock = extractBlock(i18nSource, '  zh: {', '  en: {');
const enBlock = extractBlock(i18nSource, '  en: {', '};');

function keysIn(block) {
  const keys = new Set();
  for (const match of block.matchAll(/^\s{4}(groupTasks[A-Za-z0-9]+):/gm)) {
    keys.add(match[1]);
  }
  return keys;
}

const zhKeys = keysIn(zhBlock);
const enKeys = keysIn(enBlock);

test('groupTasks i18n keys exist in both zh and en dictionaries (parity)', () => {
  assert.ok(zhKeys.size > 50, `expected a real groupTasks dictionary, got ${zhKeys.size} zh keys`);
  const missingInEn = [...zhKeys].filter((key) => !enKeys.has(key));
  const missingInZh = [...enKeys].filter((key) => !zhKeys.has(key));
  assert.deepEqual(
    missingInEn,
    [],
    `groupTasks keys defined in zh but missing in en (renderer would show the raw key): ${missingInEn.join(', ')}`,
  );
  assert.deepEqual(
    missingInZh,
    [],
    `groupTasks keys defined in en but missing in zh (renderer would show the raw key): ${missingInZh.join(', ')}`,
  );
});

test('every groupTasks key referenced by the groupTasks components resolves in zh and en', () => {
  const componentsDir = path.join(projectRoot, 'src', 'renderer', 'components', 'groupTasks');
  const files = fs.readdirSync(componentsDir).filter((name) => /\.(tsx?|js)$/.test(name));
  assert.ok(files.length > 0, 'groupTasks components directory must not be empty');

  const referenced = new Set();
  for (const file of files) {
    const source = fs.readFileSync(path.join(componentsDir, file), 'utf8');
    for (const match of source.matchAll(/'(groupTasks[A-Za-z0-9]+)'/g)) {
      referenced.add(match[1]);
    }
  }
  assert.ok(referenced.size > 20, `expected many referenced keys, got ${referenced.size}`);

  const unresolved = [...referenced].filter((key) => !zhKeys.has(key) || !enKeys.has(key));
  assert.deepEqual(
    unresolved.sort(),
    [],
    `groupTasks components reference keys missing from a dictionary (P7 raw-key regression): ${unresolved.join(', ')}`,
  );
});
