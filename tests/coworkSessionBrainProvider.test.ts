// Regression guard for the session model chip's provider resolution.
//
// Defect (v0.9.0): CoworkSessionDetail's `metabot:get` effect built the
// sessionMetabot payload from name/avatar/llm_id/globalmetaid/metabot_type only,
// silently dropping llm_provider (and llm_effort). The derived
// `sessionModelEffortValue.providerKey` therefore resolved to null, and
// resolveBrainModelInGroups fell back to catalog order. When two providers
// expose the same model id (deepseek listed before opencode) the composer chip
// labelled the session "Deepseek" even though the bot actually ran on opencode —
// and picking that chip entry would really switch the session to deepseek.
//
// Harness note: this repo's renderer tests are server-rendered (no DOM/jsdom),
// so a React effect cannot be executed by mounting. Instead this test runs the
// REAL payload mapping lifted from the component source against a fake
// `metabot:get` result, then feeds those values through the REAL
// resolveBrainModelInGroups — exactly the derivation the chip uses. Dropping
// llm_provider in the payload makes the final assertion fail, so the test is a
// genuine red-before / green-after guard rather than a text match.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  buildModelGroupsFromConfig,
  resolveBrainModelInGroups,
} from '../src/renderer/services/modelCatalog';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'cowork',
  'CoworkSessionDetail.tsx',
);

// A real metabot row shape: the brain model id shared by two providers, with
// the provider recorded explicitly (main side returns it — metabotStore.ts).
const metabotRow = {
  name: 'Twin',
  avatar: null,
  llm_id: 'deepseek-flash',
  llm_provider: 'opencode',
  llm_effort: 'high',
  globalmetaid: 'idq1example',
  metabot_type: 'twin',
};

// deepseek first, opencode second, both serving 'deepseek-flash' — the ordering
// that made a missing provider hint resolve to the wrong group.
const catalogGroups = () =>
  buildModelGroupsFromConfig({
    providers: {
      deepseek: {
        enabled: true,
        apiKey: 'sk-ds',
        baseUrl: 'https://api.deepseek.com',
        models: [{ id: 'deepseek-flash', name: 'Deepseek Chat' }],
      },
      opencode: {
        enabled: true,
        apiKey: 'sk-oc',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        name: 'Opencode',
        models: [{ id: 'deepseek-flash', name: 'Deepseek Flash' }],
      },
    },
  });

/**
 * Execute the component's real setSessionMetabot payload construction against a
 * fake `metabot:get` result and return the mapped object.
 */
function mappedSessionMetabot(): Record<string, unknown> {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const match = source.match(/\bsetSessionMetabot\(\{([\s\S]*?)\}\);/);
  assert.ok(match, 'setSessionMetabot payload literal found in CoworkSessionDetail.tsx');
  const body = match![1];

  // Non-vacuity guard on the extractor itself: if the regex grabbed the wrong
  // block, fail loudly instead of silently asserting on an empty object.
  assert.match(body, /llm_id:\s*result\.metabot\.llm_id/, 'extractor found the metabot payload block');

  return vm.runInNewContext(`({${body}})`, {
    result: { success: true, metabot: metabotRow },
  }) as Record<string, unknown>;
}

test('control: catalog order alone labels the shared model id "deepseek" (the pre-fix outcome)', () => {
  const resolved = resolveBrainModelInGroups(catalogGroups(), metabotRow.llm_id);
  assert.equal(resolved?.providerKey, 'deepseek');
});

test('control: an explicit opencode provider hint resolves the shared model id to "opencode"', () => {
  const resolved = resolveBrainModelInGroups(catalogGroups(), metabotRow.llm_id, 'opencode');
  assert.equal(resolved?.providerKey, 'opencode');
  assert.equal(resolved?.model.id, 'deepseek-flash');
});

test('CoworkSessionDetail carries the bot brain provider/effort and the chip resolves "opencode"', () => {
  const payload = mappedSessionMetabot();

  // The defect: these two keys were absent from the payload, so the chip fell
  // back to catalog order and displayed the wrong provider.
  assert.equal(payload.llm_provider, 'opencode', 'sessionMetabot carries the bot brain llm_provider');
  assert.equal(payload.llm_effort, 'high', 'sessionMetabot carries the bot brain llm_effort');
  assert.equal(payload.llm_id, 'deepseek-flash', 'sessionMetabot still carries the model id');

  // End-to-end: the mapped values, resolved by the real catalog service, must
  // yield the provider the bot actually runs on.
  const resolved = resolveBrainModelInGroups(
    catalogGroups(),
    payload.llm_id as string,
    payload.llm_provider as string | null,
  );
  assert.equal(resolved?.providerKey, 'opencode');
  assert.notEqual(resolved?.providerKey, 'deepseek');
});
