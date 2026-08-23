import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commandToken,
  parseLeadingCommand,
  slashQueryOf,
  filterComposerCommands,
  parseGoalCommandArgs,
  isValidCommandName,
  type ComposerCommand,
} from '../src/renderer/components/cowork/composerCommands';

const planCommand: ComposerCommand = {
  name: 'plan',
  description: 'Enter or leave plan mode',
  hint: 'describe your task',
  run: () => undefined,
};
const compactCommand: ComposerCommand = {
  name: 'compact',
  description: 'Compact older conversation history',
  run: () => undefined,
};
const catalog = [planCommand, compactCommand];

test('commandToken builds the claim token with a trailing space', () => {
  assert.equal(commandToken(planCommand), '/plan ');
});

test('parseLeadingCommand recognizes bare names, claimed tokens, and unknowns', () => {
  assert.deepEqual(parseLeadingCommand('/compact', catalog), {
    command: compactCommand,
    args: '',
  });
  assert.deepEqual(parseLeadingCommand('/plan fix the bug', catalog), {
    command: planCommand,
    args: 'fix the bug',
  });
  // Leading whitespace is tolerated like the DSH trimmed-draft adjudication.
  assert.deepEqual(parseLeadingCommand('  /plan  multi\nline', catalog), {
    command: planCommand,
    args: 'multi\nline',
  });
  assert.equal(parseLeadingCommand('/unknown thing', catalog), null);
  assert.equal(parseLeadingCommand('plain text', catalog), null);
  assert.equal(parseLeadingCommand('', catalog), null);
});

test('slashQueryOf extracts the in-progress token after the leading slash', () => {
  assert.equal(slashQueryOf('/'), '');
  assert.equal(slashQueryOf('/pl'), 'pl');
  assert.equal(slashQueryOf('/plan'), 'plan');
  // Trailing separator or leading text ends the trigger shape.
  assert.equal(slashQueryOf('/plan '), null);
  assert.equal(slashQueryOf('hi /plan'), null);
  assert.equal(slashQueryOf('/Plan'), null, 'uppercase is not a command token');
});

test('filterComposerCommands ranks prefix over substring over description', () => {
  const goalCommand: ComposerCommand = {
    name: 'goal',
    description: 'set or view the goal for a long-running task',
    hint: 'objective',
    run: () => undefined,
  };
  const all = [compactCommand, goalCommand, planCommand];
  assert.deepEqual(
    filterComposerCommands(all, '').map((command) => command.name),
    ['compact', 'goal', 'plan'],
    'empty query lists all in name order',
  );
  // 'pl' prefix-matches plan only ('compact' holds it in the description... no:
  // description 'Compact older...' does not contain 'pl'; goal description does not either.
  assert.deepEqual(
    filterComposerCommands(all, 'pl').map((command) => command.name),
    ['plan'],
  );
  const compCommand: ComposerCommand = {
    name: 'exp',
    description: 'run compaction',
    run: () => undefined,
  };
  // 'co' prefix-matches compact; 'exp' contains it only in the description.
  assert.deepEqual(
    filterComposerCommands([compCommand, compactCommand], 'co').map((command) => command.name),
    ['compact', 'exp'],
    'prefix (compact) outranks description match (exp)',
  );
});

test('parseGoalCommandArgs follows the DSH goal grammar', () => {
  assert.deepEqual(parseGoalCommandArgs(''), { kind: 'show' });
  assert.deepEqual(parseGoalCommandArgs('   '), { kind: 'show' });
  assert.deepEqual(parseGoalCommandArgs('clear'), { kind: 'clear' });
  assert.deepEqual(parseGoalCommandArgs('pause'), { kind: 'pause' });
  assert.deepEqual(parseGoalCommandArgs('resume'), { kind: 'resume' });
  assert.deepEqual(parseGoalCommandArgs('edit new objective'), {
    kind: 'edit',
    text: 'new objective',
  });
  assert.deepEqual(parseGoalCommandArgs('make all tests green'), {
    kind: 'create',
    text: 'make all tests green',
  });
});

test('bare edit without an objective never becomes a create', () => {
  assert.deepEqual(parseGoalCommandArgs('edit'), { kind: 'edit-missing-text' });
  assert.deepEqual(parseGoalCommandArgs('  edit   '), { kind: 'edit-missing-text' });
  // Prefixed words that merely start with "edit" stay creates.
  assert.deepEqual(parseGoalCommandArgs('editx this'), { kind: 'create', text: 'editx this' });
  assert.deepEqual(parseGoalCommandArgs('editorial pass'), {
    kind: 'create',
    text: 'editorial pass',
  });
});

test('isValidCommandName mirrors the DSH registry rule', () => {
  assert.equal(isValidCommandName('plan'), true);
  assert.equal(isValidCommandName('accept-edits'), true);
  assert.equal(isValidCommandName('Plan'), false);
  assert.equal(isValidCommandName('2fast'), false);
  assert.equal(isValidCommandName(''), false);
});
