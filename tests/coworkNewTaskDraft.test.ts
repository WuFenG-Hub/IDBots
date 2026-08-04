import test from 'node:test';
import assert from 'node:assert/strict';

import reducer, {
  setDraftPrompt,
  setNewTaskMetabotId,
  setPreferredMetabotId,
  clearPreferredMetabotId,
} from '../src/renderer/store/slices/coworkSlice';

test('newTaskMetabotId persists independently from the preferred metabot flow', () => {
  let state = reducer(undefined, setNewTaskMetabotId(42));
  assert.equal(state.newTaskMetabotId, 42);

  // The restore-from-mnemonic preferred metabot flow must not clobber the
  // user's New Task selection.
  state = reducer(state, setPreferredMetabotId(7));
  state = reducer(state, clearPreferredMetabotId());
  assert.equal(state.newTaskMetabotId, 42);

  state = reducer(state, setNewTaskMetabotId(null));
  assert.equal(state.newTaskMetabotId, null);
});

test('draftPrompt is a standalone global draft for the New Task composer', () => {
  let state = reducer(undefined, setDraftPrompt('a long task description'));
  assert.equal(state.draftPrompt, 'a long task description');
  state = reducer(state, setDraftPrompt(''));
  assert.equal(state.draftPrompt, '');
});
