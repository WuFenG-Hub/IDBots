// Static wiring test for the ask-context fixes (session f3ec66dc incident):
//
// 1. The Memory Strategy prompt section must tell the bot that memory-tracked
//    pending items are surfaced to the user with background and an
//    IDBots://{sessionId} link, not as bare internal shorthand ("S5 免额差值
//    WARN" means nothing to the user without the project context behind it).
// 2. The dsh-tool-ask-user kernel patch must exist and carry both halves of
//    the panel-context fix: the never-fire-cold description and the `detail`
//    schema + execute passthrough that renders context inside the modal.
//
// The runtime passthrough itself is covered by
// dsh-runtime/test/ask-bridge.test.mjs ("detail context survives the bridge").

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('memory strategy prompt requires background + session links for pending items', () => {
  const source = readFileSync(new URL('../src/main/libs/coworkRunner.ts', import.meta.url), 'utf8');
  // The bullet lives in the memoryEnabled branch of buildMemoryStrategyPrompt.
  const strategyIdx = source.indexOf('## Memory Strategy');
  assert.ok(strategyIdx !== -1, 'Memory Strategy section not found in coworkRunner.ts');
  const strategyBlock = source.slice(strategyIdx, strategyIdx + 4000);
  assert.match(
    strategyBlock,
    /memory-tracked pending item/,
    'pending-item surfacing bullet must exist in the Memory Strategy list',
  );
  assert.match(
    strategyBlock,
    /IDBots:\/\/\{sessionId\}/,
    'pending-item bullet must link the related conversation',
  );
});

test('dsh-tool-ask-user kernel patch carries the ask-context fix', () => {
  const patch = readFileSync(
    new URL('../scripts/dsh-kernel-patches/@deepseek-ai+dsh-tool-ask-user+0.1.5-rc.2.patch', import.meta.url),
    'utf8',
  );
  // Description: the model must explain before asking, never fire a bare question.
  assert.match(patch, /never fire a bare question/, 'patch must extend the tool description');
  // Schema: the detail property is declared so the model can attach context.
  assert.match(patch, /\+\t{5}detail: \{/, 'patch must declare the detail schema property');
  // Execute: detail is forwarded into the userQuestions.ask payload.
  assert.match(
    patch,
    /\+\t{5}\.\.\.question\.detail !== void 0 \? \{ detail: question\.detail \} : \{\},/,
    'patch must forward detail through execute()',
  );
});
