/**
 * Tests for the IM-side OpenAI Responses URL builder
 * (buildOpenAIResponsesUrlForBase in src/main/im/imChatHandler.ts).
 *
 * The routing rule mirrors the cowork proxy's buildOpenAIResponsesURL (see
 * tests/deepseekResponses.test.mjs) and the chat-completions constructor in
 * the same file: versioned bases (…/v1, …/v4 — e.g. Zhipu's
 * /api/coding/paas/v4) mount /responses directly. The old implementation
 * recognized only …/v1 and blindly appended /v1/responses to everything
 * else, producing doubled paths like …/v4/v1/responses and
 * …/v4/chat/completions/v1/responses (route-construction 404s, 2026-10-23).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { buildOpenAIResponsesUrlForBase } = require('../dist-electron/main/im/imChatHandler.js');

test('empty base resolves to the bare /v1/responses path', () => {
  assert.equal(buildOpenAIResponsesUrlForBase(''), '/v1/responses');
});

test('base already ending in /responses is used as-is', () => {
  assert.equal(buildOpenAIResponsesUrlForBase('https://host.example/responses'), 'https://host.example/responses');
});

test('/v1 base mounts /responses directly (unchanged legacy behavior)', () => {
  assert.equal(buildOpenAIResponsesUrlForBase('https://host.example/v1'), 'https://host.example/v1/responses');
});

test('unversioned host takes the conventional /v1/responses suffix (unchanged legacy behavior)', () => {
  assert.equal(buildOpenAIResponsesUrlForBase('https://host.example'), 'https://host.example/v1/responses');
  assert.equal(buildOpenAIResponsesUrlForBase('https://host.example/openai/'), 'https://host.example/openai/v1/responses');
});

test('versioned /v4 base mounts /responses directly — no /v4/v1/responses doubling', () => {
  // Zhipu GLM coding-plan chat base, the exact base from the 2026-10-23
  // route-construction 404 report.
  assert.equal(
    buildOpenAIResponsesUrlForBase('https://open.bigmodel.cn/api/coding/paas/v4'),
    'https://open.bigmodel.cn/api/coding/paas/v4/responses'
  );
});

test('chat-completions base is stripped before the version check — no …/chat/completions/v1/responses doubling', () => {
  // The observed failure shape: a base carrying the chat endpoint path got
  // /v1/responses appended, yielding /v4/chat/completions/v1/responses.
  assert.equal(
    buildOpenAIResponsesUrlForBase('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions'),
    'https://open.bigmodel.cn/api/coding/paas/v4/responses'
  );
});
