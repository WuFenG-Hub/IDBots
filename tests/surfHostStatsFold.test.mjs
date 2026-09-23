// Source-anchor regression test for the surf success-path stats fold.
//
// Release audit 2026-09-19 (P2): the empty-session guard judges a run by the
// model's SELF-report (reportJson/reportMarkdown + parseSurfRunReport stats).
// A turn truncated during final-report composition — after tools already ran,
// the most likely truncation point — produced an empty self-report, so an
// ENGAGED run was recorded failed with all-zero stats and its deep-read/KB
// receipts unbanked (chain writes self-heal via reconcileSeenLedger; deep
// reads and KB saves do not). The fix folds surfSessionPartialStats(writeState)
// into report.stats on the SUCCESS path, mirroring the failure path's
// surfPartialStats attachment. This anchor pins the wiring in main.ts, which
// has no unit-test harness (the session factory is a closure inside the
// main-process bootstrap).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');

test('the surf success path folds host ground-truth stats into the report', () => {
  assert.match(
    source,
    /report\.stats = \{ \.\.\.report\.stats, \.\.\.surfSessionPartialStats\(writeState\) \};/,
    'the success report must carry the host-vouched counts (receipts, deep reads, KB adds, scheduled tasks) — without the fold, a turn truncated at report-composition time fails the empty-session guard with all-zero stats and unbanked receipts',
  );
});

test('the fold lands after the seen-actions receipt fold and before the return', () => {
  const seenFold = source.indexOf('report.seenActions = foldSurfReceiptsIntoSeenActions(');
  const statsFold = source.indexOf('...surfSessionPartialStats(writeState)');
  const failureAttach = source.indexOf('(error as { surfPartialStats?: unknown }).surfPartialStats = partial;');
  assert.ok(seenFold !== -1 && statsFold !== -1 && failureAttach !== -1);
  assert.ok(seenFold < statsFold, 'stats fold follows the seen-actions receipt fold');
  assert.ok(statsFold < failureAttach, 'success fold sits before the failure-path attachment in the same closure');
});
