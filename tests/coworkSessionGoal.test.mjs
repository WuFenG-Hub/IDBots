import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSessionGoal,
  serializeSessionGoal,
  buildGoalPromptSection,
} from '../src/main/libs/coworkSessionGoal.ts';

test('parseSessionGoal round-trips a serialized goal and rejects junk', () => {
  const goal = { text: 'make all tests green', status: 'active', updatedAt: 1234 };
  assert.deepEqual(parseSessionGoal(serializeSessionGoal(goal)), goal);
  assert.deepEqual(
    parseSessionGoal(serializeSessionGoal({ ...goal, status: 'paused' })),
    { text: 'make all tests green', status: 'paused', updatedAt: 1234 },
  );
  assert.equal(parseSessionGoal(null), null);
  assert.equal(parseSessionGoal(undefined), null);
  assert.equal(parseSessionGoal(''), null);
  assert.equal(parseSessionGoal('not json'), null);
  // Empty text is not a goal.
  assert.equal(parseSessionGoal(JSON.stringify({ text: '  ', status: 'active' })), null);
  // Unknown status falls back to active; missing updatedAt is filled.
  const lenient = parseSessionGoal(JSON.stringify({ text: 'objective' }));
  assert.equal(lenient?.status, 'active');
  assert.equal(typeof lenient?.updatedAt, 'number');
});

test('buildGoalPromptSection states the objective and the persistence rule', () => {
  const text = buildGoalPromptSection({ text: 'ship v1.2', status: 'active', updatedAt: 1 });
  assert.match(text, /<session_goal>/);
  assert.match(text, /ship v1\.2/);
  assert.match(text, /<\/session_goal>/);
  assert.match(text, /until the goal is fully achieved/i);
});
