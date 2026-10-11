import assert from 'node:assert/strict';
import test from 'node:test';

const {
  buildPrivateChatA2ASystemPrompt,
  buildPrivateChatLanguageContract,
  buildPrivateChatSkillWaitNoticeSystemPrompt,
  buildBuyerRatingSystemPrompt,
} = await import('../dist-electron/main/services/privateChatDaemon.js');

function baseAnalysis(overrides = {}) {
  return {
    contextMessages: [
      {
        speaker: 'Peer Bot',
        content: 'Could you check the weather for me?',
        direction: 'incoming',
        timestamp: 1_770_000_000_000,
      },
    ],
    incomingTurnCount: 1,
    shouldForceBye: false,
    ...overrides,
  };
}

test('language contract requires peer-language replies, peer-language thinking, and the English fallback', () => {
  const contract = buildPrivateChatLanguageContract();

  assert.match(contract, /Language Contract/);
  assert.match(contract, /same language/i);
  assert.match(contract, /reasoning\/thinking in that language/i);
  assert.match(contract, /never set the reply language/i);
  assert.match(contract, /write in English/i);
  assert.match(contract, /Chinese only when the peer writes Chinese/i);
});

test('A2A prompt carries the mirror-the-peer rule in the channel block and the policy block', () => {
  const prompt = buildPrivateChatA2ASystemPrompt({
    metabot: { name: 'Local Bot', role: 'Analyst', soul: 'direct', goal: 'useful', bio: 'MetaID' },
    analysis: baseAnalysis(),
  });

  assert.match(prompt, /Language mirrors the peer/);
  assert.match(prompt, /Never default to Chinese unless the peer is writing Chinese/);
  assert.match(prompt, /Language follows the peer/);
  assert.match(prompt, /operator-guidance language never sets the reply language/);
});

test('A2A prompt still keeps the force-bye and sentinel rules alongside the language rules', () => {
  const prompt = buildPrivateChatA2ASystemPrompt({
    metabot: { name: 'Local Bot' },
    analysis: baseAnalysis({ incomingTurnCount: 30, shouldForceBye: true }),
  });

  assert.match(prompt, /Language mirrors the peer/);
  assert.match(prompt, /Reply exactly "bye" now/);
  assert.match(prompt, /When you say "bye", say exactly "bye" and nothing else/);
});

test('skill wait notice prompt pins the notice language to the peer message with English fallback', () => {
  const prompt = buildPrivateChatSkillWaitNoticeSystemPrompt({
    name: 'Local Bot',
    role: 'Analyst',
    soul: 'direct',
    goal: 'useful',
    bio: 'MetaID',
  });

  assert.match(prompt, /same language as the latest peer message/);
  assert.match(prompt, /if its language is unclear, use English/);
});

test('buyer rating prompt keeps the request-language rule and adds the English fallback', () => {
  const prompt = buildBuyerRatingSystemPrompt({
    originalRequest: 'Generate a poster for my cafe opening',
    serviceResult: 'Poster delivered as metafile://abc123.png',
  });

  assert.match(prompt, /same language as your original request/);
  assert.match(prompt, /if it is unclear, use English/);
});
