import assert from 'node:assert/strict';
import fs from 'fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = Module.createRequire(import.meta.url);
const {
  buildPostSimpleQaAgentTools,
  formatSimpleQuestionResult,
  formatSimpleAnswerResult,
  formatAlreadyAnsweredNotice,
} = require('../dist-electron/main/libs/postSimpleQaAgentTools.js');
const {
  setSimpleQaAnswerLedgerStore,
  listSimpleQaAnswers,
  recordSimpleQaAnswer,
} = require('../dist-electron/main/libs/simpleQaAnswerLedger.js');

const SESSION_ID = 'sess-qa-1';
const METABOT_ID = 42;
const QUESTION_PIN_ID = '5f1e07c4b2a93d8e6f0c1b7a9d3e5f2c8a4b6d0e2f9c3a5b7d1e9f0c2a4b6d8ei0';

const SAMPLE_PIN_RESULT = { txids: ['tx-qa-1'], pinId: 'tx-qa-1i0', totalCost: 1800 };

function makeFixtureFile(name = 'error.png', contents = 'png-bytes') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-simpleqa-test-'));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function makeHarness(overrides = {}) {
  const calls = { createPin: [], upload: [], listPrior: [], record: [] };
  const createPin = async (metabotId, metaidData, options) => {
    calls.createPin.push({ metabotId, metaidData, options });
    if (overrides.createPinError) throw overrides.createPinError;
    return overrides.pinResult ?? SAMPLE_PIN_RESULT;
  };
  const uploadFile = async (params) => {
    calls.upload.push(params);
    if (overrides.uploadError) throw overrides.uploadError;
    return overrides.uploadResult ?? { metafileUri: 'metafile://uploadedi0.png' };
  };
  const resolveMetabotId = (sessionId) => {
    return 'metabotId' in overrides ? overrides.metabotId : METABOT_ID;
  };
  const ledger = overrides.ledger ?? new Map();
  const listPriorAnswers = (metabotId, questionPinId) => {
    calls.listPrior.push({ metabotId, questionPinId });
    if (overrides.priorAnswers) return overrides.priorAnswers;
    return ledger.get(`${metabotId}:${questionPinId}`) ?? [];
  };
  const recordAnswer = (metabotId, questionPinId, entry) => {
    calls.record.push({ metabotId, questionPinId, entry });
    if (overrides.disableRecording) return;
    const existing = ledger.get(`${metabotId}:${questionPinId}`) ?? [];
    existing.push(entry);
    ledger.set(`${metabotId}:${questionPinId}`, existing);
  };
  const tools = buildPostSimpleQaAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    createPin,
    uploadFile,
    sessionId: SESSION_ID,
    resolveMetabotId,
    listPriorAnswers,
    recordAnswer,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName, ledger };
}

// ---------------------------------------------------------------------------
// Registration + question tool
// ---------------------------------------------------------------------------

test('registers exactly post_simplequestion and post_simpleanswer', () => {
  const { byName } = makeHarness();
  assert.deepEqual(Object.keys(byName), ['post_simplequestion', 'post_simpleanswer']);
});

test('minimal question (title only) writes the smallest legal payload — no empty optional keys, no createTime', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.post_simplequestion.handler({
    title: 'What is the recommended fee rate for MVC mainnet pin broadcasts?',
  });
  assert.equal(result.isError, undefined);
  assert.equal(calls.createPin.length, 1);
  const { metabotId, metaidData, options } = calls.createPin[0];
  assert.equal(metabotId, METABOT_ID);
  assert.deepEqual(options, { network: 'mvc', origin: 'tool:post_simplequestion' });
  assert.equal(metaidData.operation, 'create');
  assert.equal(metaidData.path, '/protocols/simplequestion');
  assert.equal(metaidData.version, '1.0.0');
  assert.equal(metaidData.encryption, '0');
  assert.equal(metaidData.contentType, 'application/json');
  const payload = JSON.parse(metaidData.payload);
  // Declarative minimalism: only the title, nothing else — and never a declared timestamp.
  assert.deepEqual(Object.keys(payload), ['title']);
  assert.equal(payload.title, 'What is the recommended fee rate for MVC mainnet pin broadcasts?');
  assert.equal('createTime' in payload, false);
});

test('full question writes content/contentType/tags/attachments and mentions the question pinId role', async () => {
  const screenshot = makeFixtureFile('error.png');
  const { calls, byName } = makeHarness();
  const result = await byName.post_simplequestion.handler({
    title: 'How to recover a wallet when the mnemonic is lost?',
    content: 'User reinstalled and lost the mnemonic. Old directory survives.',
    tags: ['wallet', ' recovery ', ''],
    attachments: [screenshot, 'metafile://existingi0.png'],
    network: 'btc',
  });
  assert.equal(result.isError, undefined);
  assert.equal(calls.createPin[0].options.network, 'btc');
  assert.deepEqual(calls.upload.map((call) => call.network), ['btc']);
  const payload = JSON.parse(calls.createPin[0].metaidData.payload);
  assert.deepEqual(Object.keys(payload).sort(), ['attachments', 'content', 'contentType', 'tags', 'title']);
  assert.equal(payload.contentType, 'text/markdown');
  assert.deepEqual(payload.tags, ['wallet', 'recovery']);
  assert.deepEqual(payload.attachments, ['metafile://uploadedi0.png', 'metafile://existingi0.png']);
  assert.equal('createTime' in payload, false);
  const text = result.content[0].text;
  assert.match(text, /Question published on-chain\./);
  assert.match(text, /question pinId: tx-qa-1i0/);
  assert.match(text, /others answer this question by referencing this pinId as `answer_to`/);
  assert.match(text, /view link: \[pin:\/\/tx-qa-1i0\]\(pin:\/\/tx-qa-1i0\)/);
  assert.doesNotMatch(text, /https?:\/\//);
});

test('explicit content_type is honored; empty content omits contentType entirely', async () => {
  const { calls, byName } = makeHarness();
  await byName.post_simplequestion.handler({ title: 't1', content: 'plain', content_type: 'text/plain' });
  let payload = JSON.parse(calls.createPin[0].metaidData.payload);
  assert.equal(payload.contentType, 'text/plain');
  await byName.post_simplequestion.handler({ title: 't2', content_type: 'text/plain' });
  payload = JSON.parse(calls.createPin[1].metaidData.payload);
  assert.equal('contentType' in payload, false);
});

test('rejects empty title, relative attachment paths and missing files honestly', async () => {
  const { byName } = makeHarness();
  const empty = await byName.post_simplequestion.handler({ title: '   ' });
  assert.equal(empty.isError, true);
  assert.match(empty.content[0].text, /requires `title`/);
  const relative = await byName.post_simplequestion.handler({ title: 't', attachments: ['shot.png'] });
  assert.equal(relative.isError, true);
  assert.match(relative.content[0].text, /ABSOLUTE local file paths/);
  const missing = await byName.post_simplequestion.handler({ title: 't', attachments: ['/nonexistent/shot.png'] });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /file not found/);
});

// ---------------------------------------------------------------------------
// Answer tool
// ---------------------------------------------------------------------------

test('answer writes the simpleanswer 1.0.0 payload and records it in the local ledger', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.post_simpleanswer.handler({
    answer_to: QUESTION_PIN_ID,
    content: 'Use 1000 sat/kb right now.',
    tags: ['fees'],
  });
  assert.equal(result.isError, undefined);
  assert.equal(calls.listPrior.length, 1);
  assert.deepEqual(calls.listPrior[0], { metabotId: METABOT_ID, questionPinId: QUESTION_PIN_ID });
  const { metaidData, options } = calls.createPin[0];
  assert.deepEqual(options, { network: 'mvc', origin: 'tool:post_simpleanswer' });
  assert.equal(metaidData.path, '/protocols/simpleanswer');
  assert.equal(metaidData.version, '1.0.0');
  const payload = JSON.parse(metaidData.payload);
  assert.deepEqual(Object.keys(payload).sort(), ['answerTo', 'content', 'tags']);
  assert.equal(payload.answerTo, QUESTION_PIN_ID);
  assert.equal('createTime' in payload, false);
  assert.equal(calls.record.length, 1);
  assert.equal(calls.record[0].entry.answerPinId, 'tx-qa-1i0');
  assert.equal(calls.record[0].entry.network, 'mvc');
  assert.match(result.content[0].text, /Answer published on-chain\./);
  assert.match(result.content[0].text, /question pinId: 5f1e07c4/);
  // First answer to this question: no repeat note.
  assert.doesNotMatch(result.content[0].text, /answer #/);
});

test('prior local answers surface BEFORE publishing — informational, not an error, not a gate', async () => {
  const prior = [
    {
      answerPinId: 'oldanswer1i0',
      content: 'Try restarting the runtime first, then check the config diff log.',
      postedAt: 1757000000000,
      network: 'mvc',
    },
  ];
  const { calls, byName } = makeHarness({ priorAnswers: prior });
  const result = await byName.post_simpleanswer.handler({
    answer_to: QUESTION_PIN_ID,
    content: 'New completely different answer.',
  });
  // Informational notice: no isError, nothing published, nothing recorded.
  assert.equal(result.isError, undefined);
  assert.equal(calls.createPin.length, 0);
  assert.equal(calls.record.length, 0);
  const text = result.content[0].text;
  assert.match(text, /Not published yet/);
  assert.match(text, /1 previous answer/);
  assert.match(text, /answer pinId: oldanswer1i0/);
  assert.match(text, /restarting the runtime first/);
  assert.match(text, /allow_repeat=true/);
  assert.match(text, /paycomment/i);
  // The decision stays with the bot — the notice says so explicitly.
  assert.match(text, /your decision/);
});

test('allow_repeat=true publishes and labels the answer number from local bookkeeping', async () => {
  const prior = [
    {
      answerPinId: 'oldanswer1i0',
      content: 'Old take.',
      postedAt: 1757000000000,
      network: 'mvc',
    },
  ];
  const { calls, byName } = makeHarness({ priorAnswers: prior });
  const result = await byName.post_simpleanswer.handler({
    answer_to: QUESTION_PIN_ID,
    content: 'Substantially revised, correct answer.',
    allow_repeat: true,
  });
  assert.equal(result.isError, undefined);
  assert.equal(calls.createPin.length, 1);
  assert.equal(calls.record.length, 1);
  assert.match(result.content[0].text, /answer #2 you published to this question from this host/);
});

test('answer validation: missing answer_to/content, no MetaBot, publish failure', async () => {
  const missing = makeHarness();
  const badArgs = await missing.byName.post_simpleanswer.handler({ answer_to: '', content: 'x' });
  assert.equal(badArgs.isError, true);
  assert.match(badArgs.content[0].text, /requires both `answer_to`/);
  const noBot = makeHarness({ metabotId: undefined });
  const noBotResult = await noBot.byName.post_simpleanswer.handler({ answer_to: 'qi0', content: 'x' });
  assert.equal(noBotResult.isError, true);
  assert.match(noBotResult.content[0].text, /could not determine which MetaBot/);
  const failed = makeHarness({ createPinError: new Error('insufficient balance') });
  const failedResult = await failed.byName.post_simpleanswer.handler({ answer_to: 'qi0', content: 'x' });
  assert.equal(failedResult.isError, true);
  assert.match(failedResult.content[0].text, /Answer publish failed: insufficient balance/);
  // Failed publish must NOT be recorded as an answer.
  assert.equal(failed.calls.record.length, 0);
});

test('DOGE answer write keeps file uploads on MVC', async () => {
  const screenshot = makeFixtureFile();
  const { calls, byName } = makeHarness();
  await byName.post_simpleanswer.handler({
    answer_to: QUESTION_PIN_ID,
    content: 'proof',
    attachments: [screenshot],
    network: 'doge',
  });
  assert.equal(calls.upload[0].network, 'mvc');
  assert.equal(calls.createPin[0].options.network, 'doge');
});

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

test('formatSimpleQuestionResult and formatSimpleAnswerResult minimal shapes', () => {
  const question = formatSimpleQuestionResult({ pinId: '', txids: [], totalCost: 0, title: 't', attachments: [] });
  assert.equal(question, 'Question published on-chain.\n- title: t\n- cost: 0 sats');
  const answer = formatSimpleAnswerResult({
    pinId: '',
    txids: [],
    totalCost: 0,
    questionPinId: 'qi0',
    attachments: [],
    priorAnswerCount: 0,
  });
  assert.equal(answer, 'Answer published on-chain.\n- question pinId: qi0\n- cost: 0 sats');
});

test('formatAlreadyAnsweredNotice truncates long content and keeps the decision wording', () => {
  const notice = formatAlreadyAnsweredNotice('qi0', [
    { answerPinId: 'ai0', content: 'x'.repeat(600), postedAt: 1, network: 'mvc' },
  ]);
  assert.match(notice, /1 previous answer/);
  assert.match(notice, /content: x{400}…/);
  assert.match(notice, /view link: \[pin:\/\/ai0\]\(pin:\/\/ai0\)/);
  assert.match(notice, /your decision/);
});

// ---------------------------------------------------------------------------
// Local answer ledger (kv-backed module)
// ---------------------------------------------------------------------------

function makeKvStore() {
  const map = new Map();
  return {
    get: (key) => map.get(key),
    set: (key, value) => map.set(key, value),
    _map: map,
  };
}

test('ledger round-trips entries per (metabotId, questionPinId) and tolerates junk', () => {
  const kv = makeKvStore();
  setSimpleQaAnswerLedgerStore(kv);
  try {
    assert.deepEqual(listSimpleQaAnswers(METABOT_ID, 'qi0'), []);
    recordSimpleQaAnswer(METABOT_ID, 'qi0', {
      answerPinId: 'a1i0',
      content: 'first',
      postedAt: 1,
      network: 'mvc',
    });
    recordSimpleQaAnswer(METABOT_ID, 'qi0', {
      answerPinId: 'a2i0',
      content: 'second',
      postedAt: 2,
      network: 'mvc',
    });
    const listed = listSimpleQaAnswers(METABOT_ID, 'qi0');
    assert.deepEqual(listed.map((entry) => entry.answerPinId), ['a1i0', 'a2i0']);
    // Other bots and other questions are independent.
    assert.deepEqual(listSimpleQaAnswers(METABOT_ID + 1, 'qi0'), []);
    assert.deepEqual(listSimpleQaAnswers(METABOT_ID, 'other'), []);
    // Malformed stored data degrades to empty, never throws.
    kv._map.set('simpleqa:answers:v1:42:junk', 'not-json{{{');
    assert.deepEqual(listSimpleQaAnswers(METABOT_ID, 'junk'), []);
    kv._map.set('simpleqa:answers:v1:42:junk2', JSON.stringify([{ nope: 1 }, 'str', null]));
    assert.deepEqual(listSimpleQaAnswers(METABOT_ID, 'junk2'), []);
  } finally {
    setSimpleQaAnswerLedgerStore(null);
  }
});

test('ledger without a store or with a failing store never breaks posting flows', () => {
  setSimpleQaAnswerLedgerStore(null);
  try {
    assert.deepEqual(listSimpleQaAnswers(METABOT_ID, 'qi0'), []);
    // Best-effort write with no store: silent no-op.
    recordSimpleQaAnswer(METABOT_ID, 'qi0', {
      answerPinId: 'a1i0',
      content: 'first',
      postedAt: 1,
      network: 'mvc',
    });
  } finally {
    setSimpleQaAnswerLedgerStore(null);
  }
  const throwing = {
    get: () => {
      throw new Error('db locked');
    },
    set: () => {
      throw new Error('db locked');
    },
  };
  setSimpleQaAnswerLedgerStore(throwing);
  try {
    assert.deepEqual(listSimpleQaAnswers(METABOT_ID, 'qi0'), []);
    recordSimpleQaAnswer(METABOT_ID, 'qi0', {
      answerPinId: 'a1i0',
      content: 'first',
      postedAt: 1,
      network: 'mvc',
    });
  } finally {
    setSimpleQaAnswerLedgerStore(null);
  }
});
