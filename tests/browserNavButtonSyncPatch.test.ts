import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBrowserPageDefinition } from '@openagentinternet/agent-browser-ui/browser';
import {
  APPLY_ACTIVE_TAB_STATE_TAIL,
  APPLY_ACTIVE_TAB_STATE_TAIL_PATCHED,
  patchBrowserNavButtonSync,
} from '../src/renderer/features/botBrowser/browserIframeBridge';

/**
 * ABC updates the shared toolbar's back/forward `disabled` state only from
 * syncToolbarForActiveTab() (tab open/close/switch). In-tab navigation never
 * re-syncs, so after an empty open-tab / last-tab close / tab switch the
 * buttons stay disabled forever even as the tab accumulates history.
 * patchBrowserNavButtonSync appends a toolbar sync to applyActiveTabState(),
 * which runs after every history mutation. These tests pin the patch anchor
 * against the shipped ABC bundle so an upstream layout change fails loudly
 * instead of silently disabling the fix.
 */
test('the applyActiveTabState anchor exists exactly once in the shipped ABC page script', () => {
  const definition = buildBrowserPageDefinition();
  const script = definition.script || '';
  const first = script.indexOf(APPLY_ACTIVE_TAB_STATE_TAIL);
  assert.notEqual(first, -1, 'applyActiveTabState tail anchor not found in ABC bundle');
  assert.equal(
    script.indexOf(APPLY_ACTIVE_TAB_STATE_TAIL, first + 1),
    -1,
    'applyActiveTabState tail anchor must be unique',
  );
});

test('patchBrowserNavButtonSync appends a toolbar sync after every history mutation', () => {
  const definition = buildBrowserPageDefinition();
  const patched = patchBrowserNavButtonSync(definition);
  const script = patched.script || '';

  assert.ok(script.includes(APPLY_ACTIVE_TAB_STATE_TAIL_PATCHED));
  assert.equal(
    script.includes(APPLY_ACTIVE_TAB_STATE_TAIL),
    false,
    'the unpatched applyActiveTabState tail must be gone',
  );
  // The patched page script must still parse as valid JavaScript.
  assert.doesNotThrow(() => new Function(script));
});

test('patchBrowserNavButtonSync is idempotent and degrades gracefully', () => {
  const definition = buildBrowserPageDefinition();
  const once = patchBrowserNavButtonSync(definition);
  const twice = patchBrowserNavButtonSync(once);
  assert.equal(twice.script, once.script, 'patching twice must not double-splice');

  const foreign = { ...definition, script: 'function unrelated() {}' };
  const untouched = patchBrowserNavButtonSync(foreign);
  assert.equal(untouched.script, foreign.script, 'missing anchor must leave the script unchanged');
});
