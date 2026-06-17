import assert from 'node:assert/strict';
import test from 'node:test';

const {
  parseMetaidRestoreProfileInfo,
} = await import('../dist-electron/main/services/metabotRestoreService.js');

test('new protocol fields override legacy bio JSON', () => {
  const parsed = parseMetaidRestoreProfileInfo({
    name: 'Restored Bot',
    bio: JSON.stringify({
      role: 'Legacy role',
      soul: 'Legacy soul',
      goal: 'Legacy goal',
      background: 'Legacy background',
      llm: 'legacy-llm',
      allowChatSkills: ['legacy-skill'],
    }),
    persona: { role: 'New role', soul: 'New soul', goal: 'New goal' },
    llm: { primaryProvider: 'codex', fallbackProvider: 'claude-code' },
    chatSkills: {
      allowPrivateChatSkills: ['metabot-help'],
      allowGroupChatSkills: ['group-skill'],
    },
    bioId: 'bio-pin',
    personaId: 'persona-pin',
    llmId: 'llm-pin',
    chatSkillsId: 'skills-pin',
  });

  assert.equal(parsed.bio.bio, 'Legacy background');
  assert.equal(parsed.bio.role, 'New role');
  assert.equal(parsed.bio.soul, 'New soul');
  assert.equal(parsed.bio.goal, 'New goal');
  assert.equal(parsed.bio.llm_id, 'codex');
  assert.deepEqual(parsed.bio.allowChatSkills, ['metabot-help']);
  assert.equal(parsed.metabotInfoPinId, 'skills-pin');
});

test('plain text bio becomes local bio while new paths fill profile fields', () => {
  const parsed = parseMetaidRestoreProfileInfo({
    name: 'Restored Bot',
    bio: 'Plain public bio',
    persona: { role: 'Role', soul: 'Soul', goal: '' },
    chatSkills: {},
  });

  assert.equal(parsed.bio.bio, 'Plain public bio');
  assert.equal(parsed.bio.role, 'Role');
  assert.equal(parsed.bio.soul, 'Soul');
  assert.equal(parsed.bio.goal, null);
  assert.deepEqual(parsed.bio.allowChatSkills, []);
});

test('legacy bio JSON still restores old bots', () => {
  const parsed = parseMetaidRestoreProfileInfo({
    name: 'Legacy Bot',
    bio: JSON.stringify({
      role: 'Legacy role',
      soul: 'Legacy soul',
      goal: 'Legacy goal',
      background: 'Legacy background',
      llm: 'codex',
      allowChatSkills: ['legacy-skill'],
      boss_id: '42',
      boss_global_metaid: 'meta-owner',
      createdBy: '0000',
    }),
    bioId: 'legacy-bio-pin',
  });

  assert.equal(parsed.bio.role, 'Legacy role');
  assert.equal(parsed.bio.soul, 'Legacy soul');
  assert.equal(parsed.bio.goal, 'Legacy goal');
  assert.equal(parsed.bio.bio, 'Legacy background');
  assert.equal(parsed.bio.llm_id, 'codex');
  assert.deepEqual(parsed.bio.allowChatSkills, ['legacy-skill']);
  assert.equal(parsed.bio.boss_id, 42);
  assert.equal(parsed.bio.boss_global_metaid, 'meta-owner');
  assert.equal(parsed.metabotInfoPinId, 'legacy-bio-pin');
});

test('empty new protocol payloads clear stale legacy profile values', () => {
  const parsed = parseMetaidRestoreProfileInfo({
    name: 'Clear Bot',
    bio: JSON.stringify({
      role: 'Legacy role',
      soul: 'Legacy soul',
      goal: 'Legacy goal',
      background: 'Legacy background',
      llm: 'legacy-llm',
      allowChatSkills: ['legacy-skill'],
    }),
    persona: '',
    llm: '',
    chatSkills: '',
  });

  assert.equal(parsed.bio.bio, 'Legacy background');
  assert.equal(parsed.bio.role, '');
  assert.equal(parsed.bio.soul, '');
  assert.equal(parsed.bio.goal, null);
  assert.equal(parsed.bio.llm_id, null);
  assert.deepEqual(parsed.bio.allowChatSkills, []);
});

test('null new protocol placeholders without pin ids keep legacy bio JSON values', () => {
  const parsed = parseMetaidRestoreProfileInfo({
    name: 'Legacy Placeholder Bot',
    bio: JSON.stringify({
      role: 'Legacy role',
      soul: 'Legacy soul',
      goal: 'Legacy goal',
      background: 'Legacy background',
      llm: 'legacy-llm',
      allowChatSkills: ['legacy-skill'],
    }),
    persona: null,
    llm: null,
    chatSkills: null,
  });

  assert.equal(parsed.bio.bio, 'Legacy background');
  assert.equal(parsed.bio.role, 'Legacy role');
  assert.equal(parsed.bio.soul, 'Legacy soul');
  assert.equal(parsed.bio.goal, 'Legacy goal');
  assert.equal(parsed.bio.llm_id, 'legacy-llm');
  assert.deepEqual(parsed.bio.allowChatSkills, ['legacy-skill']);
});

test('null new protocol payloads with pin ids still clear legacy profile values', () => {
  const parsed = parseMetaidRestoreProfileInfo({
    name: 'Pinned Clear Bot',
    bio: JSON.stringify({
      role: 'Legacy role',
      soul: 'Legacy soul',
      goal: 'Legacy goal',
      llm: 'legacy-llm',
      allowChatSkills: ['legacy-skill'],
    }),
    persona: null,
    personaId: 'persona-pin',
    llm: null,
    llmId: 'llm-pin',
    chatSkills: null,
    chatSkillsId: 'chat-skills-pin',
  });

  assert.equal(parsed.bio.role, '');
  assert.equal(parsed.bio.soul, '');
  assert.equal(parsed.bio.goal, null);
  assert.equal(parsed.bio.llm_id, null);
  assert.deepEqual(parsed.bio.allowChatSkills, []);
  assert.equal(parsed.metabotInfoPinId, 'chat-skills-pin');
});

test('canonical chatSkills restore ignores group-only skills when private list is missing', () => {
  const parsed = parseMetaidRestoreProfileInfo({
    name: 'Group Only Bot',
    bio: JSON.stringify({
      allowChatSkills: ['legacy-skill'],
    }),
    chatSkills: {
      allowGroupChatSkills: ['group-only'],
    },
  });

  assert.deepEqual(parsed.bio.allowChatSkills, []);
});
