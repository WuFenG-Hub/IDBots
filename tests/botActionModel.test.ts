import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptConfirmation, exampleBotAction, validateReceipt } from '../src/renderer/features/proposals/botActionModel.ts';

test('accepts a version-bound confirmation and trims its instruction', () => {
  const accepted = acceptConfirmation(exampleBotAction, null, {
    requestId: exampleBotAction.id, version: 1, approved: true,
    instruction: '  keep the Gallery direction  ', confirmedAt: new Date().toISOString(),
  });
  assert.equal(accepted.instruction, 'keep the Gallery direction');
});

test('duplicate confirmation retains the first immutable decision', () => {
  const first = { requestId: exampleBotAction.id, version: 1, approved: true,
    instruction: 'first', confirmedAt: new Date().toISOString() } as const;
  const second = { ...first, instruction: 'second' };
  assert.deepEqual(acceptConfirmation(exampleBotAction, first, second), first);
});

test('validates successful BotBrowser output provenance', () => {
  const base = { requestId: exampleBotAction.id, version: 1, status: 'succeeded' as const,
    summary: 'Preview ready', completedAt: new Date().toISOString() };
  assert.equal(validateReceipt(exampleBotAction, { ...base, outputUri: 'preview-metaapp://fixture/home' }), true);
  assert.equal(validateReceipt(exampleBotAction, { ...base, outputUri: 'https://example.com' }), false);
});

test('rejects stale and unapproved confirmations', () => {
  const base = { requestId: exampleBotAction.id, version: 1, approved: true,
    instruction: '', confirmedAt: new Date().toISOString() };
  assert.throws(() => acceptConfirmation(exampleBotAction, null, { ...base, version: 2 }));
  assert.throws(() => acceptConfirmation(exampleBotAction, null, { ...base, approved: false }));
});
