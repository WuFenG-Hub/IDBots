// src/main/libs/followUpTurnEndExtract.ts — turn-end input extraction for the
// Follow-Up Tasks (待跟进任务) cerebellum gate.
//
// Regression guard for the 2026-10-23 miss: CoworkStore.getSessionMessagesPage
// hands pages over OLDEST-FIRST, so an Array.find() for the "last" assistant
// message actually picked the OLDEST one of the window — long-lived scheduled
// sessions were classified on a stale benign intermediate instead of the
// final CRITICAL report and never landed in Follow-Up.

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractTurnEndFollowUpInput } from '../src/main/libs/followUpTurnEndExtract.ts';

test('picks the LAST assistant message of an oldest-first page, not the first', () => {
  const messages = [
    { type: 'user', content: '开始巡检', metadata: { origin: 'schedule', originLabel: '每日巡检' } },
    { type: 'assistant', content: '收到，开始检查各服务器状态。' },
    { type: 'assistant', content: '中间过程：已检查 3/5 台。' },
    { type: 'assistant', content: 'CRITICAL（需人工处置）\nMetaFS uploader 服务整体故障……' },
  ];
  const input = extractTurnEndFollowUpInput(messages);
  assert.ok(input);
  assert.match(input.lastAssistantText, /CRITICAL/);
  assert.equal(input.taskName, '每日巡检');
});

test('skips thinking blocks and empty assistant messages when scanning from the end', () => {
  const messages = [
    { type: 'assistant', content: '真正的最终报告：一切正常。' },
    { type: 'assistant', content: '思考中……', metadata: { isThinking: true } },
    { type: 'assistant', content: '   ' },
  ];
  const input = extractTurnEndFollowUpInput(messages);
  assert.ok(input);
  assert.equal(input.lastAssistantText, '真正的最终报告：一切正常。');
});

test('taskName comes from the LAST user message only, and only for schedule origin', () => {
  const messages = [
    { type: 'user', content: '旧任务', metadata: { origin: 'schedule', originLabel: '旧定时任务' } },
    { type: 'assistant', content: '旧的回复。' },
    { type: 'user', content: '手动追问一下进展' },
    { type: 'assistant', content: '进展如下……' },
  ];
  const input = extractTurnEndFollowUpInput(messages);
  assert.ok(input);
  assert.equal('taskName' in input, false, 'latest user message is manual — no task name');
});

test('returns null when no usable assistant message exists', () => {
  assert.equal(extractTurnEndFollowUpInput([]), null);
  assert.equal(
    extractTurnEndFollowUpInput([
      { type: 'user', content: 'hi' },
      { type: 'assistant', content: '', metadata: { isThinking: true } },
    ]),
    null,
  );
});
