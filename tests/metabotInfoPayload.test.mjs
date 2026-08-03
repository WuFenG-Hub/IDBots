import assert from 'node:assert/strict';
import test from 'node:test';

const {
  buildMetabotInfoPayloads,
  buildMetabotHomepagePayload,
  normalizeBotInfoStringArrayForTests,
} = await import('../dist-electron/main/services/metabotInfoPayload.js');

test('buildMetabotInfoPayloads emits protocol info payload steps', () => {
  const payloads = buildMetabotInfoPayloads({
    bio: ' Local bio ',
    background: ' Deprecated background ',
    role: ' assistant ',
    soul: ' helpful ',
    goal: ' ship protocol alignment ',
    llm_id: ' openai ',
    fallback_llm_id: ' gemini ',
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
  assert.equal(payloads[0].payload, 'Local bio');
  assert.equal(typeof payloads[0].payload, 'string');
  assert.deepEqual(JSON.parse(payloads[1].payload), {
    role: 'assistant',
    soul: 'helpful',
    goal: 'ship protocol alignment',
  });
  assert.deepEqual(JSON.parse(payloads[2].payload), {
    primaryProvider: 'openai',
    fallbackProvider: 'gemini',
  });
  assert.deepEqual(JSON.parse(payloads[3].payload), {
    allowPrivateChatSkills: ['alpha', 'beta'],
    allowGroupChatSkills: ['alpha', 'beta'],
  });
});

test('buildMetabotInfoPayloads clears nullish values to protocol defaults', () => {
  const payloads = buildMetabotInfoPayloads({
    bio: null,
    background: null,
    role: null,
    soul: undefined,
    goal: null,
    llm_id: '',
    fallback_llm_id: '   ',
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

test('buildMetabotInfoPayloads maps fallback_llm_id to fallbackProvider with trimming', () => {
  const withFallback = buildMetabotInfoPayloads({ llm_id: 'openai', fallback_llm_id: ' ollama ' });
  assert.deepEqual(JSON.parse(withFallback[2].payload), {
    primaryProvider: 'openai',
    fallbackProvider: 'ollama',
  });

  const withoutFallback = buildMetabotInfoPayloads({ llm_id: 'openai' });
  assert.deepEqual(JSON.parse(withoutFallback[2].payload), {
    primaryProvider: 'openai',
    fallbackProvider: null,
  });

  const nullFallback = buildMetabotInfoPayloads({ llm_id: 'openai', fallback_llm_id: null });
  assert.deepEqual(JSON.parse(nullFallback[2].payload), {
    primaryProvider: 'openai',
    fallbackProvider: null,
  });
});

test('buildMetabotInfoPayloads falls back to deprecated background for old local rows', () => {
  const payloads = buildMetabotInfoPayloads({
    background: ' Legacy background ',
  });

  assert.equal(payloads[0].path, '/info/bio');
  assert.equal(payloads[0].contentType, 'text/plain');
  assert.equal(payloads[0].payload, 'Legacy background');
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

test('buildMetabotHomepagePayload empty for null/invalid', () => {
  assert.equal(buildMetabotHomepagePayload(null).payload, '');
  assert.equal(buildMetabotHomepagePayload('garbage').payload, '');
});

test('buildMetabotHomepagePayload compact JSON for valid homepage', () => {
  const hp = '{"uri":"metaapp://p1","renderer":"metaapp","contentType":"application/vnd.metaapp"}';
  const out = buildMetabotHomepagePayload(hp);
  assert.equal(out.step, 'homepage');
  assert.equal(out.path, '/info/homepage');
  assert.equal(out.contentType, 'application/json');
  assert.deepEqual(JSON.parse(out.payload), { uri: 'metaapp://p1', renderer: 'metaapp', contentType: 'application/vnd.metaapp' });
});
