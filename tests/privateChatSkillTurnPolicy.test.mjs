import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';

const require = Module.createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compiledPath = fs.existsSync(path.join(projectRoot, 'dist-electron/main/services/privateChatSkillTurnPolicy.js'))
  ? path.join(projectRoot, 'dist-electron/main/services/privateChatSkillTurnPolicy.js')
  : path.join(projectRoot, 'dist-electron/services/privateChatSkillTurnPolicy.js');

const {
  classifyPrivateChatSkillTurnError,
  nextSkillTurnRetryAt,
  PRIVATE_CHAT_SKILL_TURN_MAX_ATTEMPTS,
  shouldRetryPrivateChatSkillTurn,
} = require(compiledPath);

test('quota and auth failures are terminal skill-turn errors', () => {
  assert.equal(
    classifyPrivateChatSkillTurnError(
      'DSH turn failed: {"kind":"error","error":{"message":"429: {\\"code\\":\\"free_quota_exhausted\\"}","code":"QUOTA"}}',
    ),
    'terminal',
  );
  assert.equal(classifyPrivateChatSkillTurnError('insufficient_quota'), 'terminal');
  assert.equal(classifyPrivateChatSkillTurnError('401 unauthorized'), 'terminal');
  assert.equal(classifyPrivateChatSkillTurnError('ETIMEDOUT'), 'retryable');
});

test('terminal quota errors are never retried', () => {
  assert.equal(
    shouldRetryPrivateChatSkillTurn({
      error: 'free_quota_exhausted',
      attempts: 1,
    }),
    false,
  );
});

test('retryable skill-turn errors back off then stop', () => {
  assert.equal(PRIVATE_CHAT_SKILL_TURN_MAX_ATTEMPTS, 3);
  assert.equal(shouldRetryPrivateChatSkillTurn({ error: 'ETIMEDOUT', attempts: 1 }), true);
  assert.equal(shouldRetryPrivateChatSkillTurn({ error: 'ETIMEDOUT', attempts: 2 }), true);
  assert.equal(shouldRetryPrivateChatSkillTurn({ error: 'ETIMEDOUT', attempts: 3 }), false);
  const first = nextSkillTurnRetryAt(1, 1_000);
  const second = nextSkillTurnRetryAt(2, 1_000);
  assert.equal(first, 16_000);
  assert.equal(second, 61_000);
});
