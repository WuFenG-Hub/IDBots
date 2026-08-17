import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Improvement #1 (single-card acceptance) static guard: the acceptance card is
 * the ONE place the owner reads the verdict and acts. These source-level
 * invariants keep the "single card" contract from regressing:
 *   1. the card leads with the stored conclusion headline (+ fallback);
 *   2. the Accept & Close / Rework buttons live INSIDE the card;
 *   3. goal/criteria render as capped previews (scroll-successful, P12-safe);
 *   4. deliverable URIs stay openable (openGroupTaskUri), not copy-only;
 *   5. the detail view hands the decision actions to the card and keeps the
 *      header buttons only as the no-summary fallback.
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) =>
  fs.readFileSync(path.join(projectRoot, 'src', 'renderer', 'components', 'groupTasks', relative), 'utf8');

test('card: conclusion headline with deterministic fallback, buttons inside, previewed goal/criteria', () => {
  const source = read('AcceptanceSummaryCard.tsx');

  // 1 — the stored conclusion is the headline; a deterministic deliverable-count
  //     line (same record, no second prose voice) stands in when absent.
  assert.ok(source.includes('summary.conclusion'), 'renders the stored conclusion');
  assert.ok(
    source.includes('groupTasksAcceptanceConclusionFallback'),
    'falls back to the deterministic deliverable-count headline',
  );

  // 2 — the decision buttons live in the card, driven by the actions prop.
  assert.ok(
    source.includes('export interface AcceptanceSummaryCardActions'),
    'card declares its actions contract',
  );
  assert.ok(source.includes("actions.onAccept"));
  assert.ok(source.includes("actions.onRework"));
  assert.ok(
    source.includes("i18nService.t('groupTasksAcceptClose')"),
    'Accept & Close rendered inside the card',
  );
  assert.ok(
    source.includes("i18nService.t('groupTasksBackToWork')"),
    'Rework rendered inside the card',
  );

  // 3 — goal/criteria previews keep the card scannable (full text behind expand).
  assert.ok(source.includes('PreviewableField'), 'preview fields used');
  assert.ok(source.includes('FIELD_PREVIEW_MAX_CHARS'), 'preview cap defined');
  assert.ok(
    source.includes('max-h-64 overflow-y-auto'),
    'expanded body stays internally scrollable (P12: group history stays visible)',
  );

  // 4 — deliverable URIs open in the right surface, not copy-only.
  assert.ok(
    source.includes('openGroupTaskUri(deliverable.uri)'),
    'metaweb/http URIs are openable from the card',
  );
});

test('detail view: card carries the decision; header buttons are the no-summary fallback only', () => {
  const source = read('GroupTaskDetailView.tsx');

  // The card receives the actions while the task is in review.
  assert.ok(
    source.includes("detail.status === 'review'")
      && source.includes('onAccept: () => setConfirmAction(\'done\')')
      && source.includes('onRework: () => void handleReopen()'),
    'decision actions are handed to the acceptance card',
  );

  // Header keeps Accept/Rework ONLY when review was reached without a summary
  // record (defensive fallback so the owner always has a decision path).
  const headerAccept = source.match(
    /canAcceptGroupTask\(detail\.status\)[\s\S]{0,120}?onClick=\{\(\) => setConfirmAction\('done'\)\}/,
  );
  assert.ok(headerAccept, 'header accept button still exists (fallback)');
  assert.match(
    source,
    /canAcceptGroupTask\(detail\.status\) && !detail\.acceptanceSummary/,
    'header accept button is gated on the missing-summary fallback',
  );
  assert.match(
    source,
    /canReopenGroupTask\(detail\.status\) && !detail\.acceptanceSummary/,
    'header rework button is gated on the missing-summary fallback',
  );
});
