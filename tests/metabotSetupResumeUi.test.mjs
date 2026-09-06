/**
 * Create-fallback resume UX (round 2, after the offline-creation field test).
 *
 * Static source assertions: a setup-pending create must not render fake
 * per-step success checkmarks, and every "re-sync now" entry for a bot whose
 * subsidy never landed must route through the resume flow (subsidy retry
 * first) instead of a plain re-publish that can only fail on the unfunded
 * wallet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('create modal reports success checkmarks only when something was published', () => {
  const source = read('src/renderer/components/metabots/MetabotsManager.tsx');
  // 'success' drives the per-step checkmark block; a chainSetupPending
  // create (nothing on-chain) must keep the modal in a non-success state so
  // the amber fallback block + resume actions render instead.
  assert.match(source, /setSyncStatus\(result\.chainSetupPending \? 'idle' : 'success'\)/);
});

test('re-sync routes subsidy-failed bots through resumeMetabotSetup, not a plain re-publish', () => {
  const source = read('src/renderer/components/metabots/MetabotsManager.tsx');
  const handler = source.slice(
    source.indexOf('async function handleResyncPartial'),
    source.indexOf('async function handleResyncPartial') + 2400,
  );
  assert.match(handler, /metabot\.subsidy_state === 'failed'/);
  assert.match(handler, /performResumeSetup\(metabot, 'subsidized'\)/);
  // The routing must come before the plain edit-sync/full-resync branches.
  const routingIndex = handler.indexOf("metabot.subsidy_state === 'failed'");
  const editSyncIndex = handler.indexOf('syncMetaBotEditChanges');
  assert.ok(routingIndex !== -1 && editSyncIndex !== -1 && routingIndex < editSyncIndex);
});

test('the bot-list card resync button feeds the routed handler', () => {
  const managerSource = read('src/renderer/components/metabots/MetabotsManager.tsx');
  const cardSource = read('src/renderer/components/metabots/MetaBotListCard.tsx');
  assert.match(managerSource, /onSyncToChain=\{\(\) => void handleResyncPartial\(m\)\}/);
  assert.match(cardSource, /onSyncToChain\(\)/);
});
