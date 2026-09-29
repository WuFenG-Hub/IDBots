import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Regression guard for the "menu flickers while a conversation is running" bug.
//
// The session row menu (sidebar local chats), the session detail header menu,
// and the group task row menu all dismiss themselves on outside click, Escape,
// resize — and on scroll, via `window.addEventListener('scroll', ..., true)`.
// A capture-phase window scroll listener hears EVERY scroll in the app, and a
// running conversation auto-pins its transcript to the bottom on each streamed
// chunk. Each of those auto-scrolls used to dismiss any open menu a fraction of
// a second after it opened (visible only while a conversation was running).
//
// The fix routes every scroll dismissal through `scrollEventMovesAnchor`, which
// only treats a scroll as anchor-moving when the scrolling element contains the
// anchor (its own list container, or the document itself). These tests pin that
// contract so the capture listeners cannot regress to unconditional closeMenu().

const repoRoot = path.resolve(import.meta.dirname, '..');

const read = (relativePath) => readFileSync(path.join(repoRoot, relativePath), 'utf8');

const helperSource = read('src/renderer/utils/anchoredPopover.ts');
const sessionItemSource = read('src/renderer/components/cowork/CoworkSessionItem.tsx');
const sessionDetailSource = read('src/renderer/components/cowork/CoworkSessionDetail.tsx');
const groupTaskMenuSource = read('src/renderer/components/groupTasks/GroupTaskItemMenu.tsx');

test('scrollEventMovesAnchor only honors scrolls that contain the anchor', () => {
  assert.match(helperSource, /export function scrollEventMovesAnchor\(event: Event, anchor: HTMLElement \| null\): boolean/);
  // The scrolling element (event.target) must contain the anchor for the
  // scroll to count as anchor-moving; document scrolls qualify because
  // document.contains(anchor) is true for any connected anchor.
  assert.match(helperSource, /return target\.contains\(anchor\);/);
});

const menuSources = [
  ['CoworkSessionItem (local chats row menu)', sessionItemSource],
  ['CoworkSessionDetail (session header menu)', sessionDetailSource],
  ['GroupTaskItemMenu (group task row menu)', groupTaskMenuSource],
];

for (const [label, source] of menuSources) {
  test(`${label} gates scroll dismissal on the anchor actually moving`, () => {
    // Still a capture-phase window listener (the sidebar list scroll must keep
    // closing the menu)…
    assert.match(source, /window\.addEventListener\('scroll', handleScroll, true\)/);
    // …but the handler now consults the shared anchor-movement check instead of
    // closing unconditionally.
    assert.match(source, /const handleScroll = \(event: Event\) => \{\s*if \(scrollEventMovesAnchor\(event, actionButtonRef\.current\)\) closeMenu\(\);\s*\}/);
    assert.doesNotMatch(source, /const handleScroll = \(\) => closeMenu\(\);/);
  });
}
