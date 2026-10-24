import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { buildOpenAIResponsesUrl } from './openaiResponsesUrl';

/**
 * Tests for the renderer's shared OpenAI Responses URL builder
 * (src/renderer/services/openaiResponsesUrl.ts).
 *
 * The routing rule must mirror the main-process builder
 * (coworkOpenAICompatProxy.buildOpenAIResponsesURL) exactly: DeepSeek host
 * root, versioned bases (…/v1, …/v4 — e.g. Zhipu's /api/coding/paas/v4)
 * mount /responses directly, and a trailing /chat/completions identifies the
 * chat endpoint rather than the base. The renderer's three call paths
 * (Settings.tsx probe, llmConnection.testProviderConnection, api.ts direct
 * streaming) previously each carried a copy that recognized only a literal
 * /v1 ending and blindly appended /v1/responses to everything else — a /v4
 * base produced the doubled path …/v4/v1/responses (route-construction 404,
 * 2026-10-23; renderer residue tracked as ledger #27, 2026-10-25).
 *
 * Run: npx tsx --test src/renderer/services/openaiResponsesUrl.test.ts
 * (the parity block additionally requires `pnpm run compile:electron`).
 */

const require = createRequire(import.meta.url);

test('empty base resolves to the bare /v1/responses path', () => {
  assert.equal(buildOpenAIResponsesUrl(''), '/v1/responses');
});

test('base already ending in /responses is used as-is', () => {
  assert.equal(
    buildOpenAIResponsesUrl('https://host.example/responses'),
    'https://host.example/responses',
  );
});

test('base already ending in /v1/responses is used as-is', () => {
  assert.equal(
    buildOpenAIResponsesUrl('https://host.example/v1/responses'),
    'https://host.example/v1/responses',
  );
});

test('/v1 base mounts /responses directly (unchanged legacy behavior)', () => {
  assert.equal(
    buildOpenAIResponsesUrl('https://host.example/v1'),
    'https://host.example/v1/responses',
  );
});

test('unversioned host takes the conventional /v1/responses suffix (unchanged legacy behavior)', () => {
  assert.equal(buildOpenAIResponsesUrl('https://host.example'), 'https://host.example/v1/responses');
  assert.equal(buildOpenAIResponsesUrl('https://host.example/openai/'), 'https://host.example/openai/v1/responses');
});

test('trailing slashes and surrounding whitespace are trimmed first', () => {
  assert.equal(buildOpenAIResponsesUrl('  https://host.example/v1/  '), 'https://host.example/v1/responses');
});

test('versioned /v4 base mounts /responses directly — no /v4/v1/responses doubling', () => {
  // Zhipu GLM coding-plan chat base, the exact base from the 2026-10-23
  // route-construction 404 report (main-process fix PR #94; this is the
  // renderer-side residue).
  assert.equal(
    buildOpenAIResponsesUrl('https://open.bigmodel.cn/api/coding/paas/v4'),
    'https://open.bigmodel.cn/api/coding/paas/v4/responses',
  );
  // A later version segment behaves the same way.
  assert.equal(
    buildOpenAIResponsesUrl('https://host.example/api/v6'),
    'https://host.example/api/v6/responses',
  );
});

test('chat-completions base is stripped before the version check — no …/chat/completions/v1/responses doubling', () => {
  // The observed failure shape: a base carrying the chat endpoint path got
  // /v1/responses appended, yielding /v4/chat/completions/v1/responses.
  assert.equal(
    buildOpenAIResponsesUrl('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions'),
    'https://open.bigmodel.cn/api/coding/paas/v4/responses',
  );
});

test('deepseek host resolves to the root /responses path', () => {
  assert.equal(buildOpenAIResponsesUrl('https://api.deepseek.com'), 'https://api.deepseek.com/responses');
  assert.equal(buildOpenAIResponsesUrl('https://api.deepseek.com', 'deepseek'), 'https://api.deepseek.com/responses');
});

test('deepseek host with /anthropic or /v1 base strips the suffix', () => {
  assert.equal(
    buildOpenAIResponsesUrl('https://api.deepseek.com/anthropic'),
    'https://api.deepseek.com/responses',
  );
  assert.equal(
    buildOpenAIResponsesUrl('https://api.deepseek.com/v1'),
    'https://api.deepseek.com/responses',
  );
});

test('provider="deepseek" flag routes a non-deepseek host to the root /responses path too', () => {
  assert.equal(
    buildOpenAIResponsesUrl('https://relay.example/deepseek', 'deepseek'),
    'https://relay.example/deepseek/responses',
  );
});

test('deepseek host already ending in /responses is used as-is', () => {
  assert.equal(
    buildOpenAIResponsesUrl('https://api.deepseek.com/responses'),
    'https://api.deepseek.com/responses',
  );
});

test('parity with the main-process builder on every battery input', async () => {
  // The renderer builder must stay byte-identical to the main-process
  // coworkOpenAICompatProxy.buildOpenAIResponsesURL — any divergence means
  // the settings probe or the direct renderer stream hits a different URL
  // than the host proxy would for the same config. Requires
  // `pnpm run compile:electron` to have produced dist-electron.
  let mainBuilder: ((baseURL: string, provider?: string) => string) | null = null;
  try {
    // Three levels up from src/renderer/services/ to the project root.
    ({ buildOpenAIResponsesURL: mainBuilder } = require('../../../dist-electron/main/libs/coworkOpenAICompatProxy.js'));
  } catch {
    // dist-electron not compiled in this checkout — skip parity (CI compiles
    // before the test steps); the behavioral cases above still run. Printed
    // loudly so a silent skip can never read as a pass.
    console.warn('[openaiResponsesUrl.test] dist-electron not compiled — parity block SKIPPED (run pnpm run compile:electron first)');
    mainBuilder = null;
  }
  if (!mainBuilder) return;

  const battery: Array<[string, string | undefined]> = [
    ['', undefined],
    ['https://host.example/responses', undefined],
    ['https://host.example/v1/responses', undefined],
    ['https://host.example/v1', undefined],
    ['https://host.example', undefined],
    ['https://host.example/openai/', undefined],
    ['  https://host.example/v1/  ', undefined],
    ['https://open.bigmodel.cn/api/coding/paas/v4', undefined],
    ['https://open.bigmodel.cn/api/coding/paas/v4/chat/completions', undefined],
    ['https://host.example/api/v6', undefined],
    ['https://host.example/chat/completions', undefined],
    ['https://api.deepseek.com', undefined],
    ['https://api.deepseek.com', 'deepseek'],
    ['https://api.deepseek.com/anthropic', undefined],
    ['https://api.deepseek.com/v1', 'deepseek'],
    ['https://api.deepseek.com/responses', undefined],
    ['https://relay.example/deepseek', 'deepseek'],
    ['https://host.example/v4?mode=x', undefined],
    ['https://HOST.EXAMPLE/V4', undefined],
  ];
  for (const [base, provider] of battery) {
    assert.equal(
      buildOpenAIResponsesUrl(base, provider),
      mainBuilder(base, provider),
      `renderer/main divergence for base=${JSON.stringify(base)} provider=${JSON.stringify(provider)}`,
    );
  }
});
