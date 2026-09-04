import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);

function loadFallback() {
  try {
    return require(require.resolve('../dist-electron/main/services/llmFallback.js'));
  } catch {
    return require('../dist-electron/services/llmFallback.js');
  }
}

const { runWithLlmFallback } = loadFallback();

test('fallback retries once when the primary fails and the signal is live', async () => {
  const attempts = [];
  const result = await runWithLlmFallback(
    { llmId: 'primary-model', fallbackLlmId: 'fallback-model' },
    async (options) => {
      attempts.push(options.llmId);
      if (options.llmId === 'primary-model') throw new Error('primary down');
      return 'ok';
    },
    () => {},
  );
  assert.equal(result, 'ok');
  assert.deepEqual(attempts, ['primary-model', 'fallback-model']);
});

test('fallback is skipped when the shared abort signal already fired', async () => {
  // The caller passes ONE AbortSignal.timeout through options; once the
  // primary attempt consumed it (timeout), a fallback attempt would fail
  // instantly with the same abort — the retry must be skipped and the
  // primary error surfaced (2026-09-04 deep-consolidation timeout).
  const controller = new AbortController();
  const attempts = [];
  const primaryError = new Error('The operation was aborted due to timeout');
  await assert.rejects(
    runWithLlmFallback(
      {
        llmId: 'primary-model',
        fallbackLlmId: 'fallback-model',
        signal: controller.signal,
      },
      async (options) => {
        attempts.push(options.llmId);
        controller.abort();
        throw primaryError;
      },
      () => {},
    ),
    (error) => error === primaryError,
  );
  assert.deepEqual(attempts, ['primary-model']);
});
