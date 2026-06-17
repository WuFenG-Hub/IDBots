import assert from 'node:assert/strict';
import test from 'node:test';

const {
  buildMetabotInfoPayloads,
  normalizeBotInfoStringArrayForTests,
} = await import('../dist-electron/main/services/metabotInfoPayload.js');

test('buildMetabotInfoPayloads emits protocol info payload steps', () => {
  const payloads = buildMetabotInfoPayloads({
    background: ' Local background ',
    role: ' assistant ',
    soul: ' helpful ',
    goal: ' ship protocol alignment ',
    llm_id: ' openai ',
    allow_chat_skills: ['alpha', 'beta'],
  });

  assert.deepEqual(
    payloads.map((payload) => payload.step),
    ['bio', 'persona', 'llm', 'chatSkills'],
  );
  assert.deepEqual(
    payloads.map((payload) => payload.path),
    ['/info/bio', '/info/persona', '/info/llm', '/info/chatSkills'],
  );
  assert.deepEqual(
    payloads.map((payload) => payload.contentType),
    ['text/plain', 'application/json', 'application/json', 'application/json'],
  );
  assert.equal(payloads[0].payload, 'Local background');
  assert.equal(typeof payloads[0].payload, 'string');
  assert.deepEqual(JSON.parse(payloads[1].payload), {
    role: 'assistant',
    soul: 'helpful',
    goal: 'ship protocol alignment',
  });
  assert.deepEqual(JSON.parse(payloads[2].payload), {
    primaryProvider: 'openai',
    fallbackProvider: null,
  });
  assert.deepEqual(JSON.parse(payloads[3].payload), {
    allowPrivateChatSkills: ['alpha', 'beta'],
    allowGroupChatSkills: ['alpha', 'beta'],
  });
});

test('buildMetabotInfoPayloads clears nullish values to protocol defaults', () => {
  const payloads = buildMetabotInfoPayloads({
    background: null,
    role: null,
    soul: undefined,
    goal: null,
    llm_id: '',
    allow_chat_skills: null,
  });

  assert.equal(payloads[0].payload, '');
  assert.deepEqual(JSON.parse(payloads[1].payload), { role: '', soul: '', goal: '' });
  assert.deepEqual(JSON.parse(payloads[2].payload), {
    primaryProvider: null,
    fallbackProvider: null,
  });
  assert.deepEqual(JSON.parse(payloads[3].payload), {
    allowPrivateChatSkills: [],
    allowGroupChatSkills: [],
  });
});

test('normalizeBotInfoStringArrayForTests normalizes array and string forms', () => {
  assert.deepEqual(
    normalizeBotInfoStringArrayForTests([' alpha ', '', 'beta', 'alpha', null, 7]),
    ['alpha', 'beta', '7'],
  );
  assert.deepEqual(
    normalizeBotInfoStringArrayForTests('["alpha"," beta ","","alpha"]'),
    ['alpha', 'beta'],
  );
  assert.deepEqual(
    normalizeBotInfoStringArrayForTests('alpha, beta,alpha,, gamma '),
    ['alpha', 'beta', 'gamma'],
  );
});
