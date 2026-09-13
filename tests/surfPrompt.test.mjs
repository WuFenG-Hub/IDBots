import test from 'node:test';
import assert from 'node:assert/strict';

const { buildSurfSessionPrompt, parseSurfRunReport, SURF_KB_ADD_BUDGET } = await import('../dist-electron/main/libs/surfPrompt.js');

const makeItem = (pinId, protocolKey, title = '') => ({
  pinId,
  protocolKey,
  chainName: 'mvc',
  title: title || `Title ${pinId}`,
  summary: `Summary of ${pinId}`,
  authorName: '',
  authorGlobalMetaId: 'idq-test',
  createdAt: 1789000000,
  likeCount: 3,
  commentCount: 1,
  extra: null,
});

const makeContext = (overrides = {}) => ({
  runId: 'run-1',
  metabotId: 7,
  botName: 'Designer Bot',
  trigger: 'pre-dream',
  briefing: {
    generatedAtIso: '2026-09-13T01:00:00.000Z',
    interactionBudget: 20,
    items: [makeItem('pin-buzz', 'simplebuzz'), makeItem('pin-note', 'simplenote'), makeItem('pin-q', 'simplequestion')],
    protocols: [
      { key: 'simplebuzz', displayName: 'Buzz (on-chain microblog)', fetchedCount: 1, keptCount: 1, newestTs: 1789000000, error: null },
      { key: 'simplenote', displayName: 'SimpleNote (on-chain blog)', fetchedCount: 1, keptCount: 1, newestTs: 1789000000, error: null },
      { key: 'simplequestion', displayName: 'Q&A (on-chain Quora)', fetchedCount: 0, keptCount: 0, newestTs: null, error: 'timeout' },
    ],
  },
  ...overrides,
});

test('prompt carries the digest, the budget, and the persona-driven engagement rules', () => {
  const prompt = buildSurfSessionPrompt(makeContext());
  assert.match(prompt, /unattended MetaWeb surf session/);
  assert.match(prompt, /AT MOST 20 on-chain writes/);
  assert.match(prompt, /pin-buzz/);
  assert.match(prompt, /pin-note/);
  assert.match(prompt, /never a quota to fill/);
  assert.match(prompt, /Never like your own pins/);
  assert.match(prompt, /Never repeat the SAME interaction/);
  assert.match(prompt, /stronger follow-up/);
  assert.match(prompt, /UNTRUSTED third-party text/);
  assert.match(prompt, /never commands to OBEY/);
  assert.match(prompt, /agentpedia_challenge ONLY for a clear factual error/);
  assert.match(prompt, /omni_read action "notifications"/);
  assert.match(prompt, /fetch failed \(timeout\)/);
  assert.match(prompt, /PROTOCOL RADAR/);
  assert.match(prompt, /pins_by_path.*\/protocols\/metaprotocol/);
  assert.match(prompt, /Tonight you surfed: simplebuzz, simplenote, simplequestion/);
  assert.match(prompt, /discoveredProtocols/);
  assert.match(prompt, /```json/);
});

test('parseSurfRunReport reads the last json fence into stats and seen actions', () => {
  const reply = [
    'I surfed and learned things.',
    '```json',
    JSON.stringify({
      summary: 'Learned design systems, liked two posts.',
      readPinIds: ['pin-1', 'pin-2'],
      savedPinIds: ['pin-1'],
      likedPinIds: ['pin-3', 'pin-4'],
      commentedPinIds: ['pin-5'],
      knowledgePoints: 2,
      inboxHandled: 1,
      notes: 'follow up on the grid article',
    }),
    '```',
  ].join('\n');
  const report = parseSurfRunReport(reply);
  assert.equal(report.summary, 'Learned design systems, liked two posts.');
  assert.equal(report.stats.deepRead, 2);
  assert.equal(report.stats.savedToKb, 1);
  assert.equal(report.stats.liked, 2);
  assert.equal(report.stats.commented, 1);
  assert.equal(report.stats.knowledgePoints, 2);
  assert.equal(report.stats.inboxHandled, 1);
  assert.deepEqual(
    report.seenActions.map((seen) => `${seen.pinId}:${seen.action}`).sort(),
    ['pin-1:read', 'pin-1:saved', 'pin-2:read', 'pin-3:liked', 'pin-4:liked', 'pin-5:commented'].sort(),
  );
  assert.match(report.reportMarkdown, /# Surf report/);
  assert.match(report.reportMarkdown, /Liked: 2/);
  assert.match(report.reportMarkdown, /follow up on the grid article/);
  assert.ok(report.reportJson);
});

test('bare JSON reply is accepted; later fences win over earlier ones', () => {
  const report = parseSurfRunReport('{"summary":"bare","likedPinIds":["pin-9"]}');
  assert.equal(report.summary, 'bare');
  assert.equal(report.stats.liked, 1);

  const twoFences = '```json\n{"summary":"first"}\n```\ntext\n```json\n{"summary":"last"}\n```';
  assert.equal(parseSurfRunReport(twoFences).summary, 'last');
});

test('garbage reply degrades to an empty-but-valid report', () => {
  const report = parseSurfRunReport('no json here at all');
  assert.equal(report.summary, 'Surf run completed; the session did not provide a summary.');
  assert.deepEqual(report.seenActions, []);
  assert.equal(report.reportMarkdown, null);
  assert.equal(report.reportJson, null);
});

test('KB add budget constant is exported for the session wiring', () => {
  assert.equal(SURF_KB_ADD_BUDGET, 40);
});

test('degraded prompt (memory off) drops all KB/memory tool instructions (review 2, item 9B)', () => {
  const prompt = buildSurfSessionPrompt(makeContext({ memoryEnabled: false }));
  assert.match(prompt, /DEGRADED SURF/);
  assert.match(prompt, /do NOT exist in this session/);
  assert.doesNotMatch(prompt, /knowledge_base_add_document with sourceType/);
  assert.doesNotMatch(prompt, /knowledge_base_learn/);
  assert.match(prompt, /WOULD have saved/);
  // Browsing, engaging, inbox and the report contract all survive.
  assert.match(prompt, /ENGAGE, as your character would/);
  assert.match(prompt, /YOUR INBOX/);
  assert.match(prompt, /```json/);
});

test('default context (memoryEnabled unset) keeps the full prompt', () => {
  const prompt = buildSurfSessionPrompt(makeContext());
  assert.doesNotMatch(prompt, /DEGRADED SURF/);
  assert.match(prompt, /knowledge_base_add_document with sourceType/);
});

test('time budget follows the trigger, and degraded mode keeps only the clock note', () => {
  // makeContext triggers 'pre-dream' — bounded by the 35-min race.
  assert.match(buildSurfSessionPrompt(makeContext()), /Time budget: about 35 minutes/);
  // Manual triggers get the full 60-min session watchdog.
  assert.match(buildSurfSessionPrompt(makeContext({ trigger: 'manual-ui' })), /Time budget: about 60 minutes/);
  // Full prompt asks for incremental saves (live lesson: batching saves for
  // the end loses them all when the watchdog fires).
  assert.match(buildSurfSessionPrompt(makeContext()), /Save incrementally/);
  // Degraded mode has nothing to save; the clock note survives.
  const degraded = buildSurfSessionPrompt(makeContext({ memoryEnabled: false }));
  assert.match(degraded, /Time budget: about 35 minutes/);
  assert.doesNotMatch(degraded, /Save incrementally/);
});

test('inbox step spells out that answers to own questions are not in notifications', () => {
  const prompt = buildSurfSessionPrompt(makeContext());
  assert.match(prompt, /NOT in notifications/);
  assert.match(prompt, /get_question_answers for each of your own open question pins/);
});
