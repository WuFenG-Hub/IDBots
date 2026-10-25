// Static guard for the renderer's three OpenAI Responses URL call paths
// (ledger #27, 2026-10-25): the routing rule must live in ONE shared module
// (src/renderer/services/openaiResponsesUrl.ts) and every call site must
// delegate to it — no file may carry its own /v1-only responses constructor
// again. Before this, each of the three paths (Settings.tsx connection
// probe, llmConnection.testProviderConnection, api.ts direct streaming)
// recognized only a literal /v1 ending and blindly appended /v1/responses,
// so a versioned base like Zhipu's /api/coding/paas/v4 produced the doubled
// path …/v4/v1/responses (route-construction 404) even though the
// main-process builder was fixed in PR #94 (2026-10-23).
//
// Run: node --test tests/rendererResponsesUrlDelegation.test.mjs
// (no compile needed — pure source checks; also wired into test:ui-regressions)

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...segments) => readFileSync(join(here, '..', ...segments), 'utf8');

const SHARED_IMPORT_FROM_SERVICES = /from\s+'\.\/openaiResponsesUrl'/;
const SHARED_IMPORT_FROM_COMPONENTS = /from\s+'\.\.\/services\/openaiResponsesUrl'/;

test('the shared module exists and carries the versioned-base guard', () => {
  const shared = read('src', 'renderer', 'services', 'openaiResponsesUrl.ts');
  assert.match(shared, /export function buildOpenAIResponsesUrl/, 'shared module exports the builder');
  // The guard itself: strip a trailing /chat/completions, then a versioned
  // base (…/v1, …/v4) mounts /responses directly.
  assert.ok(
    shared.includes('replace(/\\/chat\\/completions$/'),
    'strips a trailing /chat/completions before the version check',
  );
  assert.ok(
    shared.includes('/\\/v\\d+$/.test(versioned)'),
    'tests for a trailing version segment',
  );
});

test('Settings.tsx delegates to the shared builder and passes the active provider', () => {
  const source = read('src', 'renderer', 'components', 'Settings.tsx');
  assert.match(source, SHARED_IMPORT_FROM_COMPONENTS, 'imports the shared builder');
  assert.doesNotMatch(
    source,
    /const buildOpenAIResponsesUrl\s*=/,
    'no local responses constructor definition may remain',
  );
  // The connection probe must send the provider so DeepSeek-host routing
  // matches what the data paths (llmConnection/api.ts) build for the same
  // config — otherwise the probe can fail while real traffic works.
  assert.match(
    source,
    /buildOpenAIResponsesUrl\(normalizedBaseUrl,\s*activeProvider\)/,
    'the settings probe passes the active provider',
  );
  assert.doesNotMatch(
    source,
    /buildOpenAIResponsesUrl\(normalizedBaseUrl\)\s*:/,
    'no provider-less probe call remains',
  );
});

test('llmConnection.ts re-exports the shared builder instead of its own copy', () => {
  const source = read('src', 'renderer', 'services', 'llmConnection.ts');
  assert.match(source, SHARED_IMPORT_FROM_SERVICES, 'imports the shared builder');
  assert.match(source, /export\s*\{\s*buildOpenAIResponsesUrl\s*\}/, 'keeps the public export surface');
  assert.doesNotMatch(
    source,
    /export function buildOpenAIResponsesUrl/,
    'no local implementation may remain',
  );
});

test('api.ts delegates its private method to the shared builder', () => {
  const source = read('src', 'renderer', 'services', 'api.ts');
  assert.match(source, SHARED_IMPORT_FROM_SERVICES, 'imports the shared builder');
  assert.match(
    source,
    /private buildOpenAIResponsesUrl\([^)]*\)\s*:\s*string\s*\{\s*return buildOpenAIResponsesUrl\(/,
    'the private method delegates to the shared builder',
  );
  assert.doesNotMatch(
    source,
    /endsWith\('\/v1'\)\s*\{\s*return `\$\{normalized\}\/responses`/,
    'the old /v1-only responses branch must be gone',
  );
});

test('no renderer call-path file defines its own responses constructor', () => {
  const offender = /const buildOpenAIResponsesUrl\s*=|function buildOpenAIResponsesUrl\s*\(/;
  // Targeted sweep over the known call-path files (a recursive directory walk
  // over all of src/renderer would also sweep test fixtures; the three call
  // paths are the contract).
  const files = [
    ['src', 'renderer', 'components', 'Settings.tsx'],
    ['src', 'renderer', 'services', 'llmConnection.ts'],
    ['src', 'renderer', 'services', 'api.ts'],
  ];
  for (const file of files) {
    const source = read(...file);
    assert.doesNotMatch(
      source,
      offender,
      `${file.join('/')} must not define its own responses URL constructor`,
    );
  }
});
