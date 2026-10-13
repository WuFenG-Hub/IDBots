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
