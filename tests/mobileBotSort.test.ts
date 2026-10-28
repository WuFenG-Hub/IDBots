import assert from 'node:assert/strict';
import test from 'node:test';
import { sortBotsForList, avatarInitial } from '../src/mobile/app/botList.ts';
import type { MobileMetabot } from '../src/mobile/bridge/types.ts';

function bot(overrides: Partial<MobileMetabot> & { id: number; name: string }): MobileMetabot {
  return {
    wallet_id: overrides.id,
    enabled: true,
    globalmetaid: null,
    metabot_type: 'worker',
    role: 'worker',
    soul: '',
    goal: null,
    bio: null,
    background: null,
    boss_id: null,
    boss_global_metaid: null,
    llm_id: null,
    llm_effort: null,
    mvc_address: '',
    metabot_info_pinid: null,
    tools: [],
    skills: [],
    allow_chat_skills: [],
    created_at: 0,
    updated_at: 0,
    avatar: null,
    ...overrides,
  } as MobileMetabot;
}

test('Twin Bot ranks first, remaining Bots follow created_at ascending (earliest second, newest last)', () => {
  const input = [
    bot({ id: 3, name: 'newest', created_at: 3000 }),
    bot({ id: 1, name: 'earliest', created_at: 1000 }),
    bot({ id: 9, name: 'twin', metabot_type: 'twin', created_at: 9000 }),
    bot({ id: 2, name: 'middle', created_at: 2000 }),
  ];
  const output = sortBotsForList(input);
  assert.deepEqual(output.map((entry) => entry.name), ['twin', 'earliest', 'middle', 'newest']);
  assert.deepEqual(input.map((entry) => entry.name), ['newest', 'earliest', 'twin', 'middle'], 'input array must not be mutated');
});

test('dirty data: a Twin Bot listed mid-roster still ranks first regardless of dates', () => {
  const input = [
    bot({ id: 1, name: 'old-worker', created_at: 1 }),
    bot({ id: 2, name: 'late-twin', metabot_type: 'twin', created_at: 999_999 }),
    bot({ id: 3, name: 'old-worker-2', created_at: 2 }),
  ];
  const output = sortBotsForList(input);
  assert.deepEqual(output.map((entry) => entry.name), ['late-twin', 'old-worker', 'old-worker-2']);
});

test('dirty data: duplicate Twin rivals only make ONE head entry; more Twins keep created_at order among themselves', () => {
  const input = [
    bot({ id: 1, name: 'twin-late', metabot_type: 'twin', created_at: 5000 }),
    bot({ id: 2, name: 'twin-early', metabot_type: 'twin', created_at: 2000 }),
    bot({ id: 3, name: 'worker', created_at: 3000 }),
  ];
  const output = sortBotsForList(input);
  assert.deepEqual(output.map((entry) => entry.name), ['twin-early', 'twin-late', 'worker']);
});

test('no-Twin roster: plain created_at ascending, ties keep insertion order (stable)', () => {
  const input = [
    bot({ id: 7, name: 'c', created_at: 30 }),
    bot({ id: 5, name: 'a', created_at: 10 }),
    bot({ id: 6, name: 'b', created_at: 20 }),
  ];
  const output = sortBotsForList(input);
  assert.deepEqual(output.map((entry) => entry.name), ['a', 'b', 'c']);

  const tied = [
    bot({ id: 11, name: 'first-in', created_at: 100 }),
    bot({ id: 12, name: 'second-in', created_at: 100 }),
    bot({ id: 13, name: 'third-in', created_at: 100 }),
  ];
  assert.deepEqual(sortBotsForList(tied).map((entry) => entry.name), ['first-in', 'second-in', 'third-in']);
});

test('dirty data: missing or non-numeric created_at sorts last among non-Twin Bots and never breaks the Twin rule', () => {
  const input = [
    bot({ id: 1, name: 'no-date', created_at: undefined as unknown as number }),
    bot({ id: 2, name: 'twin', metabot_type: 'twin' }),
    bot({ id: 3, name: 'dated', created_at: 42 }),
    bot({ id: 4, name: 'garbage-date', created_at: Number.NaN }),
  ];
  const output = sortBotsForList(input);
  assert.deepEqual(output.map((entry) => entry.name), ['twin', 'dated', 'no-date', 'garbage-date']);
});

test('empty roster sorts to an empty row of a new array', () => {
  const output = sortBotsForList([]);
  assert.deepEqual(output, []);
});

test('avatarInitial takes the first letter/number character and falls back to "?"', () => {
  assert.equal(avatarInitial('Twin Bot'), 'T');
  assert.equal(avatarInitial('  42workers'), '4');
  assert.equal(avatarInitial(null), '?');
  assert.equal(avatarInitial('   '), '?');
});
