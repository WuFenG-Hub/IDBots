import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildSurfAgentTools, formatSurfRunList } = require('../dist-electron/main/libs/surfAgentTools.js');

const SESSION_ID = 'sess-surf-1';
const METABOT_ID = 7;

const makeRun = (overrides = {}) => ({
  id: 'run-1',
  metabotId: METABOT_ID,
  trigger: 'manual-chat',
  status: 'done',
  stats: {
    fetched: 12, deepRead: 5, savedToKb: 3, knowledgePoints: 2, liked: 2,
    commented: 1, answered: 0, posted: 0, challenged: 0, inboxHandled: 1, discoveredProtocols: 0,
  },
  reportMarkdown: '# Surf report\n\nLearned grid systems and liked two posts.',
  reportJson: null,
  error: null,
  startedAt: '2026-09-13T01:00:00.000Z',
  finishedAt: '2026-09-13T01:20:00.000Z',
  createdAt: '2026-09-13T01:00:00.000Z',
  updatedAt: '2026-09-13T01:20:00.000Z',
  ...overrides,
});

function makeHarness(overrides = {}) {
  const calls = { start: [] };
  const metawebSurf = {
    startSurfForMetabot: (metabotId) => {
      calls.start.push(metabotId);
      if (overrides.startError) throw overrides.startError;
      return { runId: 'run-1' };
    },
    isSurfRunning: (metabotId) => overrides.running ?? false,
    listSurfRuns: (metabotId, limit) => overrides.runs ?? [makeRun()],
  };
  const tools = buildSurfAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    metawebSurf,
    sessionId: SESSION_ID,
    resolveMetabotId: (sessionId) => ('metabotId' in overrides ? overrides.metabotId : METABOT_ID),
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName };
}

test('registers metaweb_surf_start and metaweb_surf_status', () => {
  const { byName } = makeHarness();
  assert.deepEqual(Object.keys(byName), ['metaweb_surf_start', 'metaweb_surf_status']);
});

test('start kicks a background run and returns its id', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.metaweb_surf_start.handler({});
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.start, [METABOT_ID]);
  assert.match(result.content[0].text, /Surf started/);
  assert.match(result.content[0].text, /run id: run-1/);
});

test('start refuses while a run is already in progress', async () => {
  const { calls, byName } = makeHarness({ running: true });
  const result = await byName.metaweb_surf_start.handler({});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /already in progress/);
  assert.equal(calls.start.length, 0);
});

test('start surfaces service errors as tool errors', async () => {
  const { byName } = makeHarness({ startError: new Error('MetaBot 7 not found') });
  const result = await byName.metaweb_surf_start.handler({});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Could not start the surf run: MetaBot 7 not found/);
});

test('both tools refuse unattributed sessions without guessing a bot', async () => {
  const { byName } = makeHarness({ metabotId: undefined });
  const start = await byName.metaweb_surf_start.handler({});
  const status = await byName.metaweb_surf_status.handler({});
  assert.equal(start.isError, true);
  assert.equal(status.isError, true);
});

test('status renders the running banner plus formatted run list', async () => {
  const { byName } = makeHarness({ running: true });
  const result = await byName.metaweb_surf_status.handler({ limit: 5 });
  const text = result.content[0].text;
  assert.match(text, /IN PROGRESS/);
  assert.match(text, /fetched 12 new · deep-read 5 · 3 saved, 2 liked, 1 commented/);
  assert.match(text, /Learned grid systems/);
});

test('formatSurfRunList handles the empty history', () => {
  assert.match(formatSurfRunList([]), /No surf runs yet/);
});
