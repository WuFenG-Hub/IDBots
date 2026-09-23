import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Regression guard for "the surf-report history grows without bound".
//
// SurfReportsPanel renders one card per surf run into the advanced tab, which
// also hosts the wallet / backup / delete actions BELOW it. With no height
// constraint, every additional run made the panel taller and pushed those
// actions further down the page. The fix caps the LIST itself: all run cards
// live inside one height-bounded, internally scrolling container whose max
// height never depends on runs.length, so 1 run and 20 runs occupy the same
// vertical budget. These assertions pin that contract, the untouched load
// behaviour, and the "expand brings the card into view" affordance.

const repoRoot = path.resolve(import.meta.dirname, '..');
const PANEL = 'src/renderer/components/metabots/SurfReportsPanel.tsx';

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

/**
 * Locate the opening tag that carries data-slot="surf-reports-list" and return
 * its source span, so every assertion inspects ONLY that container's tag.
 */
function listContainerTag(source) {
  const slotIndex = source.indexOf('data-slot="surf-reports-list"');
  assert.ok(slotIndex > 0, 'the surf-reports list container must exist');
  const tagEnd = source.indexOf('>', slotIndex);
  assert.ok(tagEnd > slotIndex, 'the list container opening tag must close');
  return { slotIndex, tagEnd, tag: source.slice(slotIndex, tagEnd + 1) };
}

test('run cards live in one height-capped, internally scrolling container', () => {
  const source = read(PANEL);
  const { tag } = listContainerTag(source);

  assert.match(tag, /max-h-\[min\(420px,50vh\)\]/, 'the list needs a bounded max height');
  assert.match(tag, /overflow-y-auto/, 'overflow must scroll inside the container');
  assert.match(tag, /overscroll-contain/, 'scroll chaining to the page is suppressed');
  assert.match(tag, /space-y-3/, 'the card stack keeps its original spacing');

  // The cap is a static class, never templated from data: that is exactly what
  // makes the panel height independent of the number of surf runs.
  assert.ok(!tag.includes('${'), 'the height cap must not be derived from runs.length');
  assert.ok(!/runs\.length/.test(tag), 'the container tag must not read runs.length');
});

test('runs.map(renderRunCard) renders INSIDE that container', () => {
  const source = read(PANEL);
  const { slotIndex, tagEnd } = listContainerTag(source);

  const mapIndex = source.indexOf('{runs.map(renderRunCard)}');
  assert.ok(mapIndex > 0, 'runs.map(renderRunCard) must still drive the list');
  assert.ok(mapIndex > slotIndex, 'the cards must come after the container opens');
  assert.ok(mapIndex > tagEnd, 'the cards must come after the container tag closes');
  // Nothing may close the container between its opening tag and the cards, so
  // the index comparison really does prove containment (not mere ordering).
  assert.ok(
    !source.slice(tagEnd, mapIndex).includes('</div>'),
    'no closing tag may sit between the container opening and the cards',
  );
});

test('the title row shows a count badge fed by runs.length', () => {
  const source = read(PANEL);
  const { slotIndex } = listContainerTag(source);

  const countIndex = source.indexOf('data-slot="surf-reports-count"');
  assert.ok(countIndex > 0, 'the run-count badge must exist');
  assert.ok(countIndex < slotIndex, 'the badge belongs to the header, above the list');

  const bodyStart = source.indexOf('>', countIndex) + 1;
  const bodyEnd = source.indexOf('</span>', bodyStart);
  assert.ok(bodyEnd > bodyStart, 'the badge element must close');
  const body = source.slice(bodyStart, bodyEnd).trim();

  assert.equal(body, '{runs.length}', 'the badge is fed by the live run count');
  // No new i18n key was introduced for it (i18n.ts is deliberately untouched).
  assert.doesNotMatch(body, /i18nService\.t\(/, 'the badge must not need a new i18n key');
});

test('empty state and panel error stay OUTSIDE the capped list', () => {
  const source = read(PANEL);
  const { slotIndex } = listContainerTag(source);

  const emptyIndex = source.indexOf("i18nService.t('surfReportsEmpty')");
  assert.ok(emptyIndex > 0, 'the empty state must still exist');
  assert.ok(emptyIndex < slotIndex, 'the empty state renders before the list container');

  const errorIndex = source.indexOf('{panelError ? (');
  assert.ok(errorIndex > 0, 'the panel error branch must still exist');
  assert.ok(errorIndex < slotIndex, 'the panel error renders before the list container');

  // Wording / markup of both are unchanged.
  assert.match(source, /<p className="text-xs text-red-600 dark:text-red-400">\{panelError\}<\/p>/);
  assert.match(source, /<p className=\{hintClass\}>\{i18nService\.t\('surfReportsEmpty'\)\}<\/p>/);
});

test('expanding a run scrolls its card into view, with an existence guard', () => {
  const source = read(PANEL);

  assert.match(
    source,
    /scrollIntoView\(\{\s*block:\s*'nearest'\s*\}\)/,
    "an expanded card must scroll into view using block: 'nearest'",
  );
  assert.match(
    source,
    /typeof\s+\w+\.scrollIntoView\s*===\s*'function'/,
    'scrollIntoView must be feature-detected so environments without it cannot throw',
  );
});

test('load behaviour and expand semantics are untouched', () => {
  const source = read(PANEL);

  // Fetch cap and IPC signature unchanged: newest first, at most 20 runs.
  assert.match(source, /window\.electron\.surf\.listRuns\(metabotId, 20\)/);
  // Refresh button unchanged.
  assert.match(source, /data-slot="surf-reports-refresh"/);
  assert.match(source, /i18nService\.t\('surfReportsRefresh'\)/);
  // Default collapsed, and at most one run expanded at a time.
  assert.match(source, /const \[expandedRunId, setExpandedRunId\] = useState<string \| null>\(null\)/);
  assert.match(source, /onClick=\{\(\) => setExpandedRunId\(expanded \? null : run\.id\)\}/);
  // Per-run digest fold kept.
  assert.match(source, /surfReportDigestToggle/);
});
