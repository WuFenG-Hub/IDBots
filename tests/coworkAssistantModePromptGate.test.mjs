// Static wiring checks for the assistant-mode system-prompt gate: the
// ASSISTANT_MODE_PROMPT section may mount only for regular interactive owner
// chats while the global chat experience mode is 'assistant' — group tasks,
// A2A/IM sessions, Bot Browser pages, long-term sessions, and auto-created
// orchestration runs keep the professional prompt.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const coworkRunnerSource = readFileSync(join(here, '../src/main/libs/coworkRunner.ts'), 'utf8');

test('the assistant-mode prompt section mounts only behind the per-turn gate', () => {
  // The composer mounts the section only when its assistantMode argument is
  // on — professional mode never carries the section.
  assert.ok(
    coworkRunnerSource.includes("assistantMode\n        ? [{ name: 'idbots:assistant-mode'"),
    'composeEffectiveSystemPrompt must mount the section only when its assistantMode argument is on',
  );
  // Both call sites (session start and continue) must resolve the gate
  // per turn — never a value cached at session start.
  const gateCalls = coworkRunnerSource.match(/this\.isAssistantModeOwnerChatSession\(sessionId\)/g) ?? [];
  assert.ok(
    gateCalls.length >= 2,
    'composeEffectiveSystemPrompt call sites must evaluate the gate per turn (start + continue)',
  );
});

test('the gate reads the persisted mode fresh and restricts to interactive owner chats', () => {
  const gate = coworkRunnerSource.match(
    /private isAssistantModeOwnerChatSession\(sessionId: string\): boolean \{[\s\S]*?\n  \}/,
  );
  assert.ok(gate, 'isAssistantModeOwnerChatSession must exist');
  const body = gate[0];
  assert.ok(
    body.includes("getPersistedChatExperienceMode() !== 'assistant'"),
    'the gate must read the persisted mode on every call, so a mid-session flip to professional takes effect on the next turn',
  );
  assert.ok(
    body.includes("sessionType ?? 'standard') !== 'standard'"),
    'the gate must exclude non-standard session types (A2A/group/browser)',
  );
  assert.ok(
    body.includes('session.autoOrigin'),
    'the gate must exclude auto-created sessions (orchestration/schedule runs)',
  );
  assert.ok(
    body.includes("sourceChannel === 'cowork_ui'"),
    'the gate must restrict to sessions created from the cowork UI',
  );
});

// 2026-10-20 double-acknowledgment report (session 2c70849f): the host-side
// LLM turn-ack bubble (coworkRunner emitTurnAckReplyBubble) landed in ~1s,
// then the model's prompt-mandated opening line opened with "收到" again.
// The host ack owns the instant acknowledgment now; the model's opener must
// carry substance instead, while the structural rules stay.
test('the opening line bans bare-acknowledgment openers — the host ack owns the echo', () => {
  const promptSource = readFileSync(join(here, '../src/main/libs/assistantModePrompt.ts'), 'utf8');
  assert.ok(
    promptSource.includes('NEVER open with a bare acknowledgment'),
    'the opening line must ban bare acknowledgments (the host ack bubble already delivers one)',
  );
  assert.ok(
    promptSource.includes('"收到"'),
    'the ban must name the observed Chinese opener',
  );
  assert.ok(
    !promptSource.includes('fast first response'),
    'the obsolete speed rationale is gone — the host ack owns first-response latency now',
  );
  assert.ok(
    promptSource.includes('never start a task with tool calls alone'),
    'the structural rules stay: no silent tool-call starts',
  );
  assert.ok(
    promptSource.includes('never end a turn with only a promise'),
    'the structural rules stay: no promise-only endings',
  );
});

// 2026-10-13 DeepSeek acceptance findings: with reasoning off, the model
// leaked English internal monologue as narration ("Good. Now let me build…")
// and emitted one bubble per tool round. The prompt must carry the three
// fixes as explicit prohibitions, not soft suggestions.
test('the assistant-mode prompt hard-pins narration language, sparseness, and tone', () => {
  const promptSource = readFileSync(join(here, '../src/main/libs/assistantModePrompt.ts'), 'utf8');
  assert.ok(
    promptSource.includes('NEVER narrate in English'),
    'the language rule must be a hard prohibition (English narration only when the user writes English)',
  );
  assert.ok(
    promptSource.includes('中文 →'),
    'the language rule must carry an explicit Chinese example',
  );
  assert.ok(
    promptSource.includes('NEVER write one line per tool call'),
    'narration must be sparse milestone-only, never one bubble per tool call',
  );
  assert.ok(
    promptSource.includes('2-4 narrations'),
    'the prompt must state the expected total narration budget',
  );
  assert.ok(
    promptSource.includes('NEVER self-talk'),
    'the tone rule must ban internal monologue ("let me check", "I miscounted")',
  );
  assert.ok(
    promptSource.includes('已找到中文版的文件'),
    'the tone rule must carry the user-facing status example',
  );
});

// 2026-10-22 English-install regression (first-run Twin greeting in Chinese on
// a fully English machine, free-relay deepseek-4.1-flash): the old language
// rule made Chinese mandatory ("every narration and the final reply are in
// Chinese") while English was only permitted ("only if the user writes English
// may they be English"). The greeting turn carries no user-authored text, so
// the model followed the only mandatory direction and greeted in Chinese.
// The rule must stay symmetric: BOTH languages mandatory in their own
// conversations, prohibited in the other's.
test('the language rule is symmetric — English is as mandatory as 中文', () => {
  const promptSource = readFileSync(join(here, '../src/main/libs/assistantModePrompt.ts'), 'utf8');
  assert.ok(
    !promptSource.includes('only if the user writes English may they be English'),
    'the permissive English phrasing regressed once and flipped English installs to Chinese output; English must be mandatory, not permitted',
  );
  assert.ok(
    promptSource.includes('The user writes English → every narration and the final reply are in English'),
    'the rule must state the English direction as mandatory, mirroring the 中文 direction',
  );
  assert.ok(
    promptSource.includes('NEVER write 中文 in an English conversation'),
    'the rule must prohibit Chinese output in English conversations just as it prohibits English narration in non-English ones',
  );
  assert.ok(
    promptSource.includes('Found the Chinese edition of the file'),
    'the narration example must not be Chinese-only — a Chinese-only "Good" example pulls flash models toward Chinese even in English chats',
  );
});
