import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOpenCodeGoSessionHeaders,
  isOpenCodeGoBaseUrl,
  isOpenCodeGoProvider,
} from './opencodeGatewayHeaders';

test('isOpenCodeGoProvider: built-in opencode key matches case-insensitively', () => {
  assert.equal(isOpenCodeGoProvider('opencode'), true);
  assert.equal(isOpenCodeGoProvider('OpenCode'), true);
  assert.equal(isOpenCodeGoProvider('deepseek'), false);
  assert.equal(isOpenCodeGoProvider(null), false);
});

test('isOpenCodeGoBaseUrl: matches the Go gateway host only', () => {
  assert.equal(isOpenCodeGoBaseUrl('https://opencode.ai/zen/go/v1'), true);
  assert.equal(isOpenCodeGoBaseUrl('https://api.opencode.ai/v1'), true);
  assert.equal(isOpenCodeGoBaseUrl('https://api.deepseek.com'), false);
  assert.equal(isOpenCodeGoBaseUrl('https://evil-opencode.ai/x'), false);
  assert.equal(isOpenCodeGoBaseUrl(null), false);
  assert.equal(isOpenCodeGoBaseUrl(''), false);
});

test('buildOpenCodeGoSessionHeaders: opencode provider/base URL get x-opencode-session', () => {
  const byProvider = buildOpenCodeGoSessionHeaders('opencode', 'https://opencode.ai/zen/go/v1');
  assert.ok(byProvider['x-opencode-session']);
  assert.ok(byProvider['x-opencode-session']!.length > 0);

  const byBaseUrl = buildOpenCodeGoSessionHeaders('deepseek', 'https://opencode.ai/zen/go/v1');
  assert.ok(byBaseUrl['x-opencode-session']);
});

test('buildOpenCodeGoSessionHeaders: other providers and hosts stay untouched', () => {
  assert.deepEqual(buildOpenCodeGoSessionHeaders('deepseek', 'https://api.deepseek.com'), {});
  assert.deepEqual(buildOpenCodeGoSessionHeaders(null, null), {});
  // provider-key match wins even when baseUrl is empty (default opencode base is applied later)
  assert.ok(buildOpenCodeGoSessionHeaders('opencode', '')['x-opencode-session']);
});
