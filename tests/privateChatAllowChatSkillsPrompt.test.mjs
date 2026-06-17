import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const privateChatDaemonPath = (() => {
  try {
    return require.resolve('../dist-electron/main/services/privateChatDaemon.js');
  } catch {
    return require.resolve('../dist-electron/services/privateChatDaemon.js');
  }
})();
const {
  buildPrivateChatA2ASystemPrompt,
} = require(privateChatDaemonPath);

function baseAnalysis(overrides = {}) {
  return {
    contextMessages: [
      {
        speaker: 'Peer Bot',
        content: '请查一下天气',
        direction: 'incoming',
        timestamp: 1_770_000_000_000,
      },
    ],
    incomingTurnCount: 1,
    shouldForceBye: false,
    ...overrides,
  };
}

function baseMetabot() {
  return {
    name: 'Local Bot',
    role: 'Technical partner',
    soul: 'direct',
    goal: 'useful discussion',
    bio: 'MetaID',
  };
}

test('private chat prompt injects allowed local chat skills without the no-tools rule', () => {
  const prompt = buildPrivateChatA2ASystemPrompt({
    metabot: baseMetabot(),
    analysis: baseAnalysis(),
    skillsPrompt: '<available_skills><skill><id>weather-skill</id></skill></available_skills>',
  });

  assert.match(prompt, /<available_skills>/);
  assert.match(prompt, /weather-skill/);
  assert.match(prompt, /only the local skills listed/i);
  assert.match(prompt, /brief wait notice/i);
  assert.doesNotMatch(prompt, /Do not claim local tool access or execute local skills/i);
});

test('private chat prompt without skills keeps the no-tools rule', () => {
  const prompt = buildPrivateChatA2ASystemPrompt({
    metabot: baseMetabot(),
    analysis: baseAnalysis(),
  });

  assert.doesNotMatch(prompt, /<available_skills>/);
  assert.doesNotMatch(prompt, /brief wait notice/i);
  assert.match(prompt, /Do not claim local tool access or execute local skills/i);
});

test('private chat force-bye prompt does not inject chat skills', () => {
  const prompt = buildPrivateChatA2ASystemPrompt({
    metabot: baseMetabot(),
    analysis: baseAnalysis({
      incomingTurnCount: 30,
      shouldForceBye: true,
    }),
    skillsPrompt: '<available_skills><skill><id>weather-skill</id></skill></available_skills>',
  });

  assert.match(prompt, /Reply exactly "bye" now/);
  assert.doesNotMatch(prompt, /<available_skills>/);
  assert.doesNotMatch(prompt, /weather-skill/);
  assert.doesNotMatch(prompt, /brief wait notice/i);
});

test('private chat prompt includes local-only operator guidance when provided', () => {
  const prompt = buildPrivateChatA2ASystemPrompt({
    metabot: baseMetabot(),
    analysis: baseAnalysis(),
    operatorGuidance: '下一轮先让对方给出预算范围。',
  });

  assert.match(prompt, /Human Operator Guidance/);
  assert.match(prompt, /local MetaBot only/);
  assert.match(prompt, /not a message from the remote peer/);
  assert.match(prompt, /下一轮先让对方给出预算范围。/);
  assert.match(prompt, /Do not claim local tool access or execute local skills/i);
});

test('private chat force-bye prompt ignores operator guidance', () => {
  const prompt = buildPrivateChatA2ASystemPrompt({
    metabot: baseMetabot(),
    analysis: baseAnalysis({
      incomingTurnCount: 30,
      shouldForceBye: true,
    }),
    operatorGuidance: '不要结束，继续追问。',
  });

  assert.match(prompt, /Reply exactly "bye" now/);
  assert.match(prompt, /When you say "bye", say exactly "bye" and nothing else/);
  assert.doesNotMatch(prompt, /Human Operator Guidance/);
  assert.doesNotMatch(prompt, /不要结束/);
});
