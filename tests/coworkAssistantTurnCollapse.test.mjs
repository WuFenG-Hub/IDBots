import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const detailSourcePath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'cowork',
  'CoworkSessionDetail.tsx'
);

const { isAssistantTurnComplete } = await import(
  '../src/renderer/components/cowork/assistantTurnPresentation.js'
);

test('a live session keeps its active turn expanded across inter-round gaps', () => {
  // glm-5.3 tool round: reasoning row and visible ride text both finalized,
  // tool executing, next model roundtrip pending — nothing carries
  // isStreaming, yet the turn is still running and must not collapse.
  assert.equal(
    isAssistantTurnComplete({ sessionLive: true, isActiveTurn: true, hasStreamingItem: false }),
    false,
  );
  // Streaming chunks live: also expanded (unchanged legacy behavior).
  assert.equal(
    isAssistantTurnComplete({ sessionLive: true, isActiveTurn: true, hasStreamingItem: true }),
    false,
  );
});

test('earlier turns of a live session collapse once settled', () => {
  assert.equal(
    isAssistantTurnComplete({ sessionLive: true, isActiveTurn: false, hasStreamingItem: false }),
    true,
  );
});

test('a turn with a stuck streaming flag never collapses', () => {
  assert.equal(
    isAssistantTurnComplete({ sessionLive: true, isActiveTurn: false, hasStreamingItem: true }),
    false,
  );
});

test('dead sessions collapse regardless of flags (legacy completion semantics)', () => {
  assert.equal(
    isAssistantTurnComplete({ sessionLive: false, isActiveTurn: false, hasStreamingItem: false }),
    true,
  );
  assert.equal(
    isAssistantTurnComplete({ sessionLive: false, isActiveTurn: true, hasStreamingItem: true }),
    true,
  );
});

test('CoworkSessionDetail routes turn completeness through the helper with an active-turn flag', () => {
  const source = fs.readFileSync(detailSourcePath, 'utf8');

  assert.match(source, /isAssistantTurnComplete\(\{ sessionLive, isActiveTurn, hasStreamingItem \}\)/);
  // The active turn is the last turn of a session whose own runner status is
  // running (not the global isStreaming flag, which other sessions' turns
  // can flip while this one is being viewed).
  assert.match(source, /isActiveTurn=\{currentSession\?\.status === 'running' && isLastTurn\}/);
  assert.match(source, /isActiveTurn=\{currentSession\?\.status === 'running'\}/);
});
