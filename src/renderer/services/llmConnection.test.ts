import test from 'node:test';
import assert from 'node:assert/strict';

import { buildOpenAIResponsesUrl } from './llmConnection';

test('buildOpenAIResponsesUrl: regular host appends /v1/responses', () => {
  assert.equal(
    buildOpenAIResponsesUrl('https://opencode.ai/zen/go/v1'),
    'https://opencode.ai/zen/go/v1/responses',
  );
});

test('buildOpenAIResponsesUrl: opencode host already ending in /v1 gains /responses', () => {
  assert.equal(
    buildOpenAIResponsesUrl('https://opencode.ai/zen/go/v1', 'opencode'),
    'https://opencode.ai/zen/go/v1/responses',
  );
});

test('buildOpenAIResponsesUrl: deepseek host resolves to root /responses', () => {
  assert.equal(
    buildOpenAIResponsesUrl('https://api.deepseek.com', 'deepseek'),
    'https://api.deepseek.com/responses',
  );
});

test('buildOpenAIResponsesUrl: deepseek host with /anthropic base strips suffix', () => {
  assert.equal(
    buildOpenAIResponsesUrl('https://api.deepseek.com/anthropic', 'deepseek'),
    'https://api.deepseek.com/responses',
  );
});

test('buildOpenAIResponsesUrl: deepseek host with /v1 base strips suffix', () => {
  assert.equal(
    buildOpenAIResponsesUrl('https://api.deepseek.com/v1', 'deepseek'),
    'https://api.deepseek.com/responses',
  );
});

test('buildOpenAIResponsesUrl: deepseek host detected by base URL even without provider flag', () => {
  assert.equal(
    buildOpenAIResponsesUrl('https://api.deepseek.com'),
    'https://api.deepseek.com/responses',
  );
});
