// Static wiring check for the group-task composer keyboard contract: Enter
// sends, Shift+Enter inserts a newline, and Enter during IME composition
// confirms the candidate instead of sending — same as the new-task composer
// (CoworkPromptInput). The old handler only sent on Cmd/Ctrl+Enter.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '../src/renderer/components/groupTasks/GroupTaskDetailView.tsx'), 'utf8');

test('group-task composer sends on Enter and keeps Shift+Enter / IME composition safe', () => {
  // Plain Enter sends — the Cmd/Ctrl-only requirement is gone.
  assert.ok(
    source.includes("e.key === 'Enter' && !e.shiftKey && !isComposing"),
    'Enter (no Shift, not composing) must trigger handleSend',
  );
  assert.ok(
    !source.includes("e.key === 'Enter' && (e.metaKey || e.ctrlKey)"),
    'the Cmd/Ctrl+Enter-only handler must be replaced',
  );
  // IME guard mirrors CoworkPromptInput: isComposing flag plus the 229 keyCode.
  assert.ok(
    source.includes('e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229'),
    'composition guard must match the new-task composer',
  );
  assert.ok(
    source.includes('void handleSend();'),
    'the Enter path must call handleSend',
  );
});
