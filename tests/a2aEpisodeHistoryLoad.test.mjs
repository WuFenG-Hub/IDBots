import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Regression guard for "history invisible right after an A2A episode
// rollover" (2026-09-17 real-device acceptance of feat/a2a-episode-rollover):
// a fresh successor session loads with messageHistory
// { hasMoreBefore: true, beforeSequence: null } — earlier episodes exist, but
// the current episode's window fits entirely. The component-level
// loadEarlierMessages used to hard-return on `history.beforeSequence == null`,
// so the scroll-to-top trigger never reached the service's cross-episode
// paging and the thread's earlier generations were unreachable from the UI.
// The in-session page path also finalized hasMoreBefore to false at the
// session boundary without probing for earlier episodes, which would have
// dead-ended longer successor sessions later.

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('A2A load-earlier does not dead-end on a null in-session cursor', () => {
  const source = read('src/renderer/components/cowork/CoworkSessionDetail.tsx');

  // The bug: the guard rejected exactly the post-rollover state.
  assert.doesNotMatch(
    source,
    /\|\|\s*history\.beforeSequence == null/,
    'loadEarlierMessages must not reject a null beforeSequence: that is the episode-rollover state where cross-episode paging begins',
  );
  // The remaining guards (a2a-only, hasMoreBefore, container, in-flight) stay.
  assert.match(source, /currentSession\?\.sessionType !== 'a2a'/);
  assert.match(source, /!history\?\.hasMoreBefore/);
});

test('in-session paging chains into cross-episode paging at the session boundary', () => {
  const source = read('src/renderer/services/cowork.ts');

  // The service must probe previous episodes when the in-session window ends.
  assert.match(
    source,
    /!result\.page\.hasMoreBefore && currentSession\?\.sessionType === 'a2a'/,
    'the final in-session page must check for earlier episodes of an A2A thread',
  );
  assert.match(
    source,
    /beforeCursor: \{ episodeIndex: null, beforeSequence: null \}/,
    'the probe uses the first-page-below-anchor cursor',
  );
  // Earlier-episode messages prepend before the session page (chronological order).
  const chained = source.match(
    /messages: \[\s*\.\.\.below\.page\.messages\.map\(\(entry\) => entry\.message\),\s*\.\.\.result\.page\.messages,\s*\]/,
  );
  assert.ok(chained, 'cross-episode messages must prepend before the in-session page messages');
});
