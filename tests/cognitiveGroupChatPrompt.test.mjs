import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildGroupChatChannelPrompt, buildChatHistoryBlock } = require('../dist-electron/main/services/cognitiveOrchestrator.js');

test('channel prompt frames the group chat without persona facts or history', () => {
  const prompt = buildGroupChatChannelPrompt('Design weekly', 'Collect ideas', null, null);
  assert.match(prompt, /## Group Chat Channel/);
  assert.match(prompt, /You are a MetaBot participating in a group chat on MetaWeb\./);
  assert.match(prompt, /- Background: Design weekly/);
  assert.match(prompt, /- Goal: Collect ideas/);
  // History and persona facts must live elsewhere (user turn / persona block).
  assert.doesNotMatch(prompt, /Chat Context/);
  assert.doesNotMatch(prompt, /<metabot_identity>/);
});

test('channel prompt defaults background and goal when the task carries none', () => {
  const prompt = buildGroupChatChannelPrompt('  ', null, null, null);
  assert.match(prompt, /- Background: Free participation, no specific background\./);
  assert.match(prompt, /- Goal: Participate in the group chat freely/);
});

test('authority block lists Boss and a distinct owner at top priority', () => {
  const prompt = buildGroupChatChannelPrompt(null, null, 'idqboss', 'idqowner');
  assert.match(prompt, /### Authority/);
  assert.match(prompt, /GlobalMetaID idqboss is your Boss/);
  assert.match(prompt, /GlobalMetaID idqowner is your configured owner/);
});

test('owner identical to supervisor is not listed twice', () => {
  const prompt = buildGroupChatChannelPrompt(null, null, 'idqboss', 'idqboss');
  assert.match(prompt, /is your Boss/);
  assert.doesNotMatch(prompt, /is your configured owner/);
});

test('reply protocol has no AI-denial rule and demands reply-language matching', () => {
  const prompt = buildGroupChatChannelPrompt(null, null, null, null);
  assert.match(prompt, /Reply in the language of the recent chat messages/);
  assert.match(prompt, /output ONLY the reply text/);
  // The outdated rule (never admit you are an AI) is deliberately gone.
  assert.doesNotMatch(prompt, /承认自己是 AI|admit.*AI|language model/i);
});

test('chat history block renders messages under a labeled header', () => {
  const block = buildChatHistoryBlock(['alice: hi', 'bob: morning']);
  assert.equal(
    block,
    ['[Chat Context (Recent Messages)]', 'alice: hi', 'bob: morning'].join('\n'),
  );
});

test('chat history block notes when there is no history', () => {
  assert.match(buildChatHistoryBlock([]), /\(No recent messages\)/);
});
