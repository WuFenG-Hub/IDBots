import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import CoworkPermissionPanel, {
  parseQuestions,
} from '../src/renderer/components/cowork/CoworkPermissionPanel';
import { i18nService } from '../src/renderer/services/i18n';

/**
 * F-17a component coverage for the permission panel's payload handling:
 * (1) the standard permission card, (2) the structured question wizard (real
 * incident payload shape), (3) the unknown/undecodable fallback card which
 * must keep BOTH Allow and Deny available — never a deny-only dead end.
 */

const requestId = 'req-f17a';

function panel(toolName: string, toolInput: Record<string, unknown>): JSX.Element {
  return (
    <CoworkPermissionPanel
      permission={{ requestId, toolName, toolInput, perQuestionTimeoutMs: null } as never}
      onRespond={() => undefined}
    />
  );
}

test('standard permission payload renders the action card with Allow and Deny', () => {
  const markup = renderToStaticMarkup(panel('Bash', {
    command: 'npm install lodash',
    description: 'Install dependency',
  }));
  assert.ok(markup.includes(i18nService.t('coworkApprovalAllowOnce')), 'allow rendered');
  assert.ok(markup.includes(i18nService.t('coworkDeny')), 'deny rendered');
  assert.ok(markup.includes('npm install lodash'), 'input summary rendered');
});

test('structured question (real 迁轎 incident shape: id + multi_select aliases) keeps the wizard', () => {
  const toolInput = {
    questions: [{
      id: 'confirm_create',
      header: '确认入职',
      question: '这张卡可以照着建吗？',
      multi_select: false,
      detail: '建完他会是一个独立的本地 Worker Bot。',
      options: [
        { label: '就这个（推荐）', description: '按现在的名字、人格、火箭头像创建。' },
        { label: '名字换一个', description: '保留人格和头像。' },
      ],
    }],
  };
  const parsed = parseQuestions({ toolName: 'AskUserQuestion', toolInput } as never);
  assert.equal(parsed.length, 1, 'the incident payload parses to one question');
  assert.equal(parsed[0].multiSelect, false);
  const markup = renderToStaticMarkup(panel('AskUserQuestion', toolInput));
  assert.ok(markup.includes('这张卡可以照着建吗？'), 'question text rendered');
  assert.ok(markup.includes('就这个（推荐）'), 'first option rendered');
  assert.ok(markup.includes('名字换一个'), 'second option rendered');
  assert.ok(markup.includes(i18nService.t('coworkApprovalUnavailableTitle')) === false, 'no malformed fallback');
});

test('string-only option entries still produce a question instead of the malformed card', () => {
  const parsed = parseQuestions({
    toolName: 'AskUserQuestion',
    toolInput: { questions: [{ question: 'Pick a lane?', options: ['Fast path', 'Slow path'] }] },
  } as never);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].options.map((option) => option.label), ['Fast path', 'Slow path']);
});

test('unknown/malformed AskUserQuestion falls back to readable payload with Allow AND Deny', () => {
  // Byte-level outcome of the old gateway depth crush: every option object
  // arrives as the string '[truncated-depth]' so no question survives parsing.
  const crushed = {
    questions: [{
      id: 'confirm_create',
      question: '这张卡可以照着建吗？',
      options: ['[truncated-depth]', '[truncated-depth]', '[truncated-depth]'],
    }],
  };
  const markup = renderToStaticMarkup(panel('AskUserQuestion', crushed));
  assert.ok(markup.includes(i18nService.t('coworkApprovalUnavailableTitle')), 'fallback title rendered');
  assert.ok(markup.includes('options'), 'raw payload keys are readable, not just a red banner');
  assert.ok(markup.includes('[truncated-depth]'), 'the crushed payload is shown verbatim');
  assert.ok(markup.includes(i18nService.t('coworkApprovalAllowOnce')), 'Allow is still available');
  assert.ok(markup.includes(i18nService.t('coworkDeny')), 'Deny is still available');
});

test('questions with no usable options drop into the fallback, empty questions never break the card', () => {
  const zero = parseQuestions({ toolName: 'AskUserQuestion', toolInput: { questions: [] } } as never);
  assert.deepEqual(zero, []);
  const markup = renderToStaticMarkup(panel('AskUserQuestion', { questions: [] }));
  assert.ok(markup.includes(i18nService.t('coworkApprovalUnavailableTitle')));
  assert.ok(markup.includes(i18nService.t('coworkApprovalAllowOnce')));
});
