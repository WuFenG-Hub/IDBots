import test from 'node:test';
import assert from 'node:assert/strict';

test('DeepSeek reasoning_content classifier uses proxy lastError when SDK only reports process exit', async () => {
  const {
    buildCoworkProviderErrorSignal,
    isDeepSeekMissingReasoningContentError,
  } = await import('../dist-electron/main/libs/coworkProviderErrors.js');

  const sdkExitError = 'Claude Code process exited with code 1';
  const proxyLastError = 'DeepSeek thinking request is missing reasoning_content for 1 assistant tool-call message(s). Tool call ids: call_00_example.';
  const signal = buildCoworkProviderErrorSignal(sdkExitError, {
    proxyLastError,
    stderr: '',
  });

  assert.equal(isDeepSeekMissingReasoningContentError(sdkExitError), false);
  assert.equal(isDeepSeekMissingReasoningContentError(signal), true);
  assert.match(signal, /Claude Code process exited with code 1/);
  assert.match(signal, /DeepSeek thinking request is missing reasoning_content/);
});

test('provider error signal de-duplicates repeated details', async () => {
  const {
    buildCoworkProviderErrorSignal,
  } = await import('../dist-electron/main/libs/coworkProviderErrors.js');

  const signal = buildCoworkProviderErrorSignal('same error', {
    proxyLastError: 'same error',
    stderr: 'same error',
  });

  assert.equal(signal, 'same error');
});

test('isQuotaDshTurnError matches the kernel QUOTA code and upstream credit fingerprints', async () => {
  const { isQuotaDshTurnError } = await import('../dist-electron/main/libs/coworkAssistantReply.js');

  // Kernel-normalized code (the 2026-09-14 commandcode incident shape).
  assert.equal(
    isQuotaDshTurnError({
      kind: 'error',
      error: {
        code: 'QUOTA',
        message: '400: {"message":"You have insufficient credits to make this request.","type":"invalid_request_error","code":"BAD_REQUEST"}',
      },
    }),
    true,
  );
  // Fingerprint-only variants (code lost or relayed as BAD_REQUEST).
  assert.equal(
    isQuotaDshTurnError({ kind: 'error', error: { code: 'BAD_REQUEST', message: 'Insufficient Balance' } }),
    true,
  );
  assert.equal(
    isQuotaDshTurnError({ kind: 'error', error: { message: 'This request exceeds your billing limit.' } }),
    true,
  );
  // Non-quota failures must not classify.
  assert.equal(
    isQuotaDshTurnError({ kind: 'error', error: { code: 'SERVER', message: 'OpenAI API error (500)' } }),
    false,
  );
  assert.equal(
    isQuotaDshTurnError({ kind: 'error', error: { code: 'TRANSPORT', message: 'fetch failed' } }),
    false,
  );
  assert.equal(isQuotaDshTurnError({ kind: 'completed' }), false);
  assert.equal(isQuotaDshTurnError(null), false);
});
