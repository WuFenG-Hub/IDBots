import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveContinueSystemPrompt } = require('../dist-electron/main/libs/coworkPromptStrategy.js');

const resolve = (input) => resolveContinueSystemPrompt(input);

test('returns undefined when no requested prompt is provided', () => {
  assert.equal(resolve({ persistedSystemPrompt: 'persisted', activeSkillIds: ['a'] }), undefined);
});

test('returns undefined for a blank requested prompt', () => {
  assert.equal(resolve({ requestedSystemPrompt: '   ', persistedSystemPrompt: 'persisted' }), undefined);
});

test('returns the requested prompt when nothing is persisted', () => {
  assert.equal(resolve({ requestedSystemPrompt: 'fresh' }), 'fresh');
  assert.equal(resolve({ requestedSystemPrompt: 'fresh', persistedSystemPrompt: null }), 'fresh');
});

test('keeps the persisted prompt when skill sets match (live-catalog drift guard)', () => {
  assert.equal(
    resolve({
      persistedSystemPrompt: 'persisted-with-catalog-v1',
      requestedSystemPrompt: 'rebuilt-with-catalog-v2',
      activeSkillIds: ['skill-a', 'skill-b'],
      persistedActiveSkillIds: ['skill-a', 'skill-b'],
    }),
    undefined,
  );
});

test('keeps the persisted prompt when skill sets match regardless of order', () => {
  assert.equal(
    resolve({
      persistedSystemPrompt: 'persisted',
      requestedSystemPrompt: 'rebuilt',
      activeSkillIds: ['skill-b', 'skill-a'],
      persistedActiveSkillIds: ['skill-a', 'skill-b'],
    }),
    undefined,
  );
});

test('keeps the persisted prompt when both skill sets are empty', () => {
  assert.equal(
    resolve({
      persistedSystemPrompt: 'persisted',
      requestedSystemPrompt: 'rebuilt',
      activeSkillIds: [],
      persistedActiveSkillIds: [],
    }),
    undefined,
  );
});

test('forwards the requested prompt on a deliberate skill-set change', () => {
  assert.equal(
    resolve({
      persistedSystemPrompt: 'persisted',
      requestedSystemPrompt: 'rebuilt-for-skill-b',
      activeSkillIds: ['skill-b'],
      persistedActiveSkillIds: ['skill-a'],
    }),
    'rebuilt-for-skill-b',
  );
});

test('forwards the requested prompt when skills are added to a skill-less session', () => {
  assert.equal(
    resolve({
      persistedSystemPrompt: 'persisted',
      requestedSystemPrompt: 'rebuilt-with-skill-a',
      activeSkillIds: ['skill-a'],
      persistedActiveSkillIds: [],
    }),
    'rebuilt-with-skill-a',
  );
});

test('forwards the requested prompt when skills are cleared mid-session', () => {
  assert.equal(
    resolve({
      persistedSystemPrompt: 'persisted',
      requestedSystemPrompt: 'rebuilt-without-skills',
      activeSkillIds: [],
      persistedActiveSkillIds: ['skill-a'],
    }),
    'rebuilt-without-skills',
  );
});

test('treats duplicate requested ids as the same set', () => {
  assert.equal(
    resolve({
      persistedSystemPrompt: 'persisted',
      requestedSystemPrompt: 'rebuilt',
      activeSkillIds: ['skill-a', 'skill-a'],
      persistedActiveSkillIds: ['skill-a'],
    }),
    undefined,
  );
});

test('forwards when persisted skill tracking is absent and skills are requested', () => {
  assert.equal(
    resolve({
      persistedSystemPrompt: 'persisted',
      requestedSystemPrompt: 'rebuilt-with-skill-a',
      activeSkillIds: ['skill-a'],
    }),
    'rebuilt-with-skill-a',
  );
});
