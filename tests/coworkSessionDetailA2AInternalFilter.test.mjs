import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'cowork',
  'CoworkSessionDetail.tsx'
);

test('CoworkSessionDetail hides non-order internal states in A2A sessions', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');

  assert.match(source, /import \{ shouldHideA2AInternalMessage \} from '\.\/a2aInternalMessageFilter'/);
  assert.match(
    source,
    /visibleA2AMessages[\s\S]*?!shouldHideControlMessage\(message\) && !shouldHideA2AInternalMessage\(message\)/,
  );
});

test('a2aInternalMessageFilter keeps order flows while hiding tool calls and reasoning', () => {
  const filterSource = fs.readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'components', 'cowork', 'a2aInternalMessageFilter.ts'),
    'utf8',
  );

  // Internal states that are hidden for non-order messages.
  assert.match(filterSource, /message\.type === 'tool_use' \|\| message\.type === 'tool_result'/);
  assert.match(filterSource, /message\.type === 'system'/);
  assert.match(filterSource, /message\.metadata\?\.isThinking === true/);

  // Order-related markers that keep internal states visible.
  assert.match(filterSource, /orderMappingExternalConversationId/);
  assert.match(filterSource, /orderExecutionTrace === true/);
  assert.match(filterSource, /simplemsgKind === 'order_protocol'/);
  assert.match(filterSource, /serviceOrderEvent/);
});
