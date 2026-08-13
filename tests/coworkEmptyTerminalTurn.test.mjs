import test from 'node:test';
import assert from 'node:assert/strict';

async function importCompiled(modulePath) {
  try {
    return await import(`../dist-electron/main/libs/${modulePath}.js`);
  } catch {
    return import(`../dist-electron/libs/${modulePath}.js`);
  }
}

// Regression coverage for the "task auto-terminates as completed with no final
// reply" failure mode (session d41b04c0): a DeepSeek thinking turn that ended
// after emitting only the `[reasoning unavailable]` placeholder produced an
// SDK `success` result with empty `result` text, yet the session was marked
// `completed`. The empty-terminal-turn guard now keys off this helper.
test('isEmptyTerminalSdkResult flags success results with no final reply text', async () => {
  const { isEmptyTerminalSdkResult } = await importCompiled('coworkAssistantReply');

  // The failure signature: success but the model emitted only placeholder
  // thinking — no final answer string at all.
  assert.equal(isEmptyTerminalSdkResult({ subtype: 'success', result: '' }), true);
  assert.equal(isEmptyTerminalSdkResult({ subtype: 'success', result: '   \n ' }), true);
  assert.equal(isEmptyTerminalSdkResult({ subtype: 'success' }), true, 'missing result -> empty terminal');
  assert.equal(isEmptyTerminalSdkResult({ subtype: 'success', result: null }), true);
  assert.equal(isEmptyTerminalSdkResult({ subtype: 'success', result: 42 }), true, 'non-string result -> empty terminal');

  // A real final handoff/report must NOT be flagged.
  assert.equal(
    isEmptyTerminalSdkResult({ subtype: 'success', result: '已确认 fee 结构，汇报如下：...' }),
    false
  );
  assert.equal(isEmptyTerminalSdkResult({ subtype: 'success', result: 'done' }), false);

  // Defensive: null/undefined payload -> treat as empty terminal.
  assert.equal(isEmptyTerminalSdkResult(null), true);
  assert.equal(isEmptyTerminalSdkResult(undefined), true);
});

test('DEEPSEEK_RESPONSES_REASONING_PLACEHOLDER is the exact sentinel the hygiene guards skip', async () => {
  const { DEEPSEEK_RESPONSES_REASONING_PLACEHOLDER, isNonAnswerAssistantReply } = await importCompiled('coworkAssistantReply');

  assert.equal(DEEPSEEK_RESPONSES_REASONING_PLACEHOLDER, '[reasoning unavailable]');
  // The placeholder round-trips back as thinking content; both the persistence
  // hygiene guards and the reply extractor must recognize it as a non-answer.
  assert.equal(isNonAnswerAssistantReply(DEEPSEEK_RESPONSES_REASONING_PLACEHOLDER), true);
  assert.equal(isNonAnswerAssistantReply('  [reasoning unavailable]  '), true, 'trimmed match');
  // Real reasoning text is left untouched.
  assert.equal(isNonAnswerAssistantReply('分析 fee 结构后，发现...'), false);
});

// The auto-continue cue fed back to the model on an empty terminal turn
// (DeepSeek reasoning-only end_turn). It MUST be a genuine, non-empty
// instruction — if it ever drifted to empty/whitespace or to the placeholder
// sentinel, the continue retry would itself look like another empty turn and
// the one-shot `!isRetry` guard could not reliably break the cycle.
test('EMPTY_TERMINAL_TURN_CONTINUE_PROMPT is a real instruction, never a non-answer', async () => {
  const { EMPTY_TERMINAL_TURN_CONTINUE_PROMPT, isNonAnswerAssistantReply, isEmptyTerminalSdkResult } =
    await importCompiled('coworkAssistantReply');

  assert.equal(typeof EMPTY_TERMINAL_TURN_CONTINUE_PROMPT, 'string');
  assert.ok(EMPTY_TERMINAL_TURN_CONTINUE_PROMPT.trim().length > 0, 'continue cue must be non-empty');
  // It must read as a genuine assistant/user message, NOT as the DeepSeek
  // placeholder or blank — otherwise the recovery turn would be re-flagged.
  assert.equal(isNonAnswerAssistantReply(EMPTY_TERMINAL_TURN_CONTINUE_PROMPT), false);
  // Sanity: the continue cue is distinct from the placeholder sentinel.
  assert.notEqual(EMPTY_TERMINAL_TURN_CONTINUE_PROMPT, '[reasoning unavailable]');
  // A success result carrying this cue as its reply text would be a normal,
  // non-empty turn — not an empty terminal turn.
  assert.equal(
    isEmptyTerminalSdkResult({ subtype: 'success', result: EMPTY_TERMINAL_TURN_CONTINUE_PROMPT }),
    false
  );
});

