import test from 'node:test';
import assert from 'node:assert/strict';

test('deepseek-v4-pro gets SDK auto-compact env at ~82% of usable window', async () => {
  const {
    buildCoworkSdkAutoCompactEnv,
  } = await import('../dist-electron/main/libs/coworkSdkAutoCompact.js');

  const result = buildCoworkSdkAutoCompactEnv({
    modelId: 'deepseek-v4-pro',
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
    source: 'known-model',
  });

  assert.ok(result);
  assert.equal(result.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1000000');
  // usable = 1_000_000 - 32_768 = 967_232; 967_232 * 0.82 + 20_000 + 13_000 = 826_130
  assert.equal(result.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '826130');
  assert.equal(result.autoCompactWindow, 826130);
});

test('deepseek-v4-flash shares the same 1M window config as v4-pro', async () => {
  const {
    buildCoworkSdkAutoCompactEnv,
  } = await import('../dist-electron/main/libs/coworkSdkAutoCompact.js');

  const result = buildCoworkSdkAutoCompactEnv({
    modelId: 'deepseek-v4-flash',
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
    source: 'known-model',
  });

  assert.ok(result);
  assert.equal(result.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1000000');
  assert.equal(result.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '826130');
});

test('Claude-prefixed model ids are left to the CLI defaults', async () => {
  const {
    buildCoworkSdkAutoCompactEnv,
  } = await import('../dist-electron/main/libs/coworkSdkAutoCompact.js');

  const result = buildCoworkSdkAutoCompactEnv({
    modelId: 'claude-opus-4-7',
    contextWindow: 1_048_576,
    maxOutputTokens: 32_768,
    source: 'known-model',
  });

  assert.equal(result, null);
});

test('OpenRouter claude alias is treated as non-Claude (CLI honors window override)', async () => {
  const {
    buildCoworkSdkAutoCompactEnv,
  } = await import('../dist-electron/main/libs/coworkSdkAutoCompact.js');

  const result = buildCoworkSdkAutoCompactEnv({
    modelId: 'anthropic/claude-sonnet-4.6',
    contextWindow: 1_048_576,
    maxOutputTokens: 8_192,
    source: 'known-model',
  });

  assert.ok(result);
  assert.equal(result.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1048576');
  // usable = 1_048_576 - 8_192 = 1_040_384; * 0.82 + min(8_192, 20k) + 13k = 874_307
  assert.equal(result.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '874307');
});

test('fallback-sourced limits never enable SDK auto-compact', async () => {
  const {
    buildCoworkSdkAutoCompactEnv,
  } = await import('../dist-electron/main/libs/coworkSdkAutoCompact.js');

  const result = buildCoworkSdkAutoCompactEnv({
    modelId: 'deepseek-v4-pro',
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
    source: 'fallback',
  });

  assert.equal(result, null);
});

test('context windows below the CLI 100k minimum are rejected', async () => {
  const {
    buildCoworkSdkAutoCompactEnv,
  } = await import('../dist-electron/main/libs/coworkSdkAutoCompact.js');

  const result = buildCoworkSdkAutoCompactEnv({
    modelId: 'tiny-local-model',
    contextWindow: 32_768,
    maxOutputTokens: 4_096,
    source: 'provider-model',
  });

  assert.equal(result, null);
});

test('windows above 1M are passed through but auto-compact window caps at 1M', async () => {
  const {
    buildCoworkSdkAutoCompactEnv,
  } = await import('../dist-electron/main/libs/coworkSdkAutoCompact.js');

  const result = buildCoworkSdkAutoCompactEnv({
    modelId: 'google/gemini-3.1-pro-preview',
    contextWindow: 2_000_000,
    maxOutputTokens: 8_192,
    source: 'known-model',
  });

  assert.ok(result);
  assert.equal(result.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '2000000');
  assert.equal(result.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '1000000');
});

test('empty model id is rejected', async () => {
  const {
    buildCoworkSdkAutoCompactEnv,
  } = await import('../dist-electron/main/libs/coworkSdkAutoCompact.js');

  const result = buildCoworkSdkAutoCompactEnv({
    modelId: '',
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
    source: 'known-model',
  });

  assert.equal(result, null);
});
