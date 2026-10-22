// Unit tests for buildTurnNavigatorItems — the pure builder behind the turn
// navigator rail. The rail itself is a hover/scroll surface, but its item
// list is a pure projection of the conversation turns, so the contract is
// pinned here without mounting anything.
//
// TurnNavigator.tsx is a .tsx module (JSX + a service import), so it cannot
// be imported directly from plain `node --test`. Following the
// coworkStreamFlushCoalescing.test.mjs pattern: bundle an entry point that
// re-exports the builder with esbuild into a temp .mjs, stubbing the i18n
// service the component (not the builder) uses.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const loadTurnNavigator = async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-navigator-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const outputFile = path.join(tempDir, 'turnNavigator.mjs');

  await build({
    absWorkingDir: projectRoot,
    stdin: {
      contents: "export { buildTurnNavigatorItems } from './src/renderer/components/cowork/TurnNavigator.tsx';",
      resolveDir: projectRoot,
      sourcefile: 'turn-navigator-entry.ts',
      loader: 'ts',
    },
    outfile: outputFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    plugins: [
      {
        // buildTurnNavigatorItems never touches i18n; the component does.
        // Stub the service so its config/electron import chain stays out of
        // the bundle.
        name: 'stub-renderer-i18n',
        setup(esbuild) {
          esbuild.onResolve({ filter: /services[\\/]i18n/ }, () => ({
            path: 'i18n-stub',
            namespace: 'turn-navigator-test',
          }));
          esbuild.onLoad(
            { filter: /^i18n-stub$/, namespace: 'turn-navigator-test' },
            () => ({
              loader: 'js',
              contents: 'export const i18nService = { t: (key) => key };',
            }),
          );
        },
      },
    ],
  });

  return import(pathToFileURL(outputFile).href);
};

// buildTurnNavigatorItems only reads the fields it uses (verified against the
// implementation): turn.userMessage (truthiness, .content, .id) and
// turn.assistantItems entries' .type / .message.content. Minimal structural
// objects are enough; no CoworkMessage shape is needed.
const identity = (content) => content;

const turn = (id, prompt, assistantItems) => ({
  id,
  userMessage: { id, content: prompt },
  assistantItems,
});

const assistantItem = (content) => ({ type: 'assistant', message: { content } });

test('orphan turns (userMessage:null) are skipped', async (t) => {
  const { buildTurnNavigatorItems } = await loadTurnNavigator(t);

  const items = buildTurnNavigatorItems(
    [
      {
        id: 'orphan-0',
        userMessage: null,
        assistantItems: [assistantItem('stray resumed answer')],
      },
      turn('u1', 'one', [assistantItem('first answer')]),
    ],
    identity,
  );

  assert.equal(items.length, 1, 'the orphan turn yields no rail item');
  assert.equal(items[0].anchorId, 'u1');
});

test('numbering is 1..n over the kept turns only', async (t) => {
  const { buildTurnNavigatorItems } = await loadTurnNavigator(t);

  const items = buildTurnNavigatorItems(
    [
      turn('u1', 'one', [assistantItem('a1')]),
      { id: 'orphan-0', userMessage: null, assistantItems: [assistantItem('stray')] },
      turn('u2', 'two', [assistantItem('a2')]),
      { id: 'orphan-1', userMessage: null, assistantItems: [] },
      turn('u3', 'three', [assistantItem('a3')]),
    ],
    identity,
  );

  assert.deepEqual(
    items.map((item) => item.turn),
    [1, 2, 3],
    'kept turns are renumbered 1..n with orphans removed from the count',
  );
  assert.deepEqual(
    items.map((item) => item.anchorId),
    ['u1', 'u2', 'u3'],
  );
  assert.ok(items.every((item) => item.navigable));
});

test('response is the text of the FIRST type-assistant item', async (t) => {
  const { buildTurnNavigatorItems } = await loadTurnNavigator(t);

  const items = buildTurnNavigatorItems(
    [
      turn('u1', 'one', [
        { type: 'system', message: { content: 'system notice' } },
        { type: 'tool_group', group: {} },
        assistantItem('first answer'),
        assistantItem('second answer'),
      ]),
    ],
    identity,
  );

  assert.equal(items[0].prompt, 'one');
  assert.equal(items[0].response, 'first answer', 'later assistant items are ignored');
});

test('a turn with no assistant text yields an empty response', async (t) => {
  const { buildTurnNavigatorItems } = await loadTurnNavigator(t);

  const items = buildTurnNavigatorItems(
    [
      turn('u1', 'one', []),
      turn('u2', 'two', [
        { type: 'system', message: { content: 'notice' } },
        { type: 'tool_group', group: {} },
      ]),
    ],
    identity,
  );

  assert.equal(items[0].response, '', 'empty assistantItems');
  assert.equal(items[1].response, '', 'no assistant-typed item among the rest');
});
