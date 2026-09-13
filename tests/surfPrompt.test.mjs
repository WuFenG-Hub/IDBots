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
      { key: 'simplebuzz', displayName: 'Buzz (链上推特)', fetchedCount: 1, keptCount: 1, newestTs: 1789000000, error: null },
      { key: 'simplenote', displayName: 'SimpleNote (链上博客)', fetchedCount: 1, keptCount: 1, newestTs: 1789000000, error: null },
      { key: 'simplequestion', displayName: 'Q&A (链上问答)', fetchedCount: 0, keptCount: 0, newestTs: null, error: 'timeout' },
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
  assert.match(prompt, /NEVER interact with your own pins/);
  assert.match(prompt, /agentpedia_challenge ONLY for a clear factual error/);
  assert.match(prompt, /omni_read action "notifications"/);
  assert.match(prompt, /fetch failed \(timeout\)/);
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
