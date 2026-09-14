// Regression coverage for the 2026-09-14 silent-stall: GLM-5.3-flash sessions
// (e6af1710, 572751a8, 10b02949, …) burned the 8K output ceiling on thinking,
// auto-continued once with thinking still ON, burned it again, then settled
// idle with an empty `replyTruncatedTurn` system message that the renderer
// filtered out — thinking vanished, no error, no continue, no prompt.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...segments) => fs.readFileSync(path.join(projectRoot, ...segments), 'utf8');

const runnerSource = readSource('src', 'main', 'libs', 'coworkRunner.ts');
const replySource = readSource('src', 'main', 'libs', 'coworkAssistantReply.ts');
const limitsSource = readSource('src', 'main', 'libs', 'coworkModelLimits.ts');
const sessionDetailSource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkSessionDetail.tsx');

test('truncated and empty-terminal auto-continues disable thinking so the recovery turn can emit tools or text', () => {
  assert.ok(
    replySource.includes("export const CONTINUE_TURN_REASONING_EFFORT = 'off'"),
    'coworkAssistantReply must export CONTINUE_TURN_REASONING_EFFORT = off',
  );
  assert.ok(
    runnerSource.includes('CONTINUE_TURN_REASONING_EFFORT'),
    'coworkRunner must import and use CONTINUE_TURN_REASONING_EFFORT',
  );
  const emptyIdx = runnerSource.lastIndexOf('EMPTY_TERMINAL_TURN_CONTINUE_PROMPT');
  const truncatedIdx = runnerSource.lastIndexOf('TRUNCATED_TURN_CONTINUE_PROMPT');
  assert.ok(emptyIdx > 0 && truncatedIdx > 0, 'runner must reference both continue prompts');
  const emptyWindow = runnerSource.slice(emptyIdx, emptyIdx + 280);
  const truncatedWindow = runnerSource.slice(truncatedIdx, truncatedIdx + 280);
  assert.ok(
    emptyWindow.includes('CONTINUE_TURN_REASONING_EFFORT'),
    `empty-terminal continue must pin effort off: ${emptyWindow}`,
  );
  assert.ok(
    truncatedWindow.includes('CONTINUE_TURN_REASONING_EFFORT'),
    `truncated continue must pin effort off: ${truncatedWindow}`,
  );
});

test('CoworkSessionDetail renders empty diagnostic flags via the shared visibility helper', () => {
  assert.ok(sessionDetailSource.includes("from '../../utils/coworkMessageVisibility'"));
  assert.ok(sessionDetailSource.includes('isRenderableAssistantOrSystemMessage'));
  assert.equal(
    sessionDetailSource.includes('const isRenderableAssistantOrSystemMessage'),
    false,
    'CoworkSessionDetail must use the shared helper, not a local copy that hides empty diagnostics',
  );
  assert.ok(sessionDetailSource.includes('dshTurnInterrupted'));
  assert.ok(sessionDetailSource.includes('coworkDshTurnInterrupted'));
  assert.ok(
    sessionDetailSource.includes('sessionLive'),
    'idle leftover isStreaming thinking must not keep the turn looking live',
  );
});

test('GLM-5 thinking models declare a 32K output ceiling in KNOWN_MODEL_LIMITS', () => {
  assert.ok(limitsSource.includes('GLM_MAX_OUTPUT_TOKENS = 32_768'));
  assert.ok(limitsSource.includes("'glm-5.3-flash':"));
  assert.ok(limitsSource.includes("'z-ai/glm-5.3-flash':"));
  const flashEntry = limitsSource.slice(
    limitsSource.indexOf("'glm-5.3-flash':"),
    limitsSource.indexOf("'glm-5.3-flash':") + 160,
  );
  const zaiEntry = limitsSource.slice(
    limitsSource.indexOf("'z-ai/glm-5.3-flash':"),
    limitsSource.indexOf("'z-ai/glm-5.3-flash':") + 160,
  );
  assert.ok(flashEntry.includes('GLM_MAX_OUTPUT_TOKENS'), `glm-5.3-flash entry: ${flashEntry}`);
  assert.ok(zaiEntry.includes('GLM_MAX_OUTPUT_TOKENS'), `z-ai/glm-5.3-flash entry: ${zaiEntry}`);
});
