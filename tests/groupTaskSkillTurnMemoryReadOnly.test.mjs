/**
 * Group-task skill turns run the cowork session in memoryReadOnly mode
 * (orchestratorCoworkBridge + main.ts binding) instead of the legacy
 * disableMemoryUpdates blackout. These tests drive the REAL compiled
 * CoworkRunner against an in-memory sql.js store with a session shaped like a
 * group-task worker session (sessionType group_task + the metaweb_group_task
 * conversation mapping) and cover:
 *   1. volatile READ injection is restored — conversation-scope memories and
 *      external_safe owner operational preferences ride the turn, while owner
 *      profile facts stay behind the external-channel privacy filter;
 *   2. the system-prompt profile keeps memory blocks but drops the Memory
 *      STRATEGY section (write invitations) for a memory-read-only session;
 *   3. the turn-end WRITE path never enqueues under memoryReadOnly.
 *
 * Run: pnpm run compile:electron && node --test tests/groupTaskSkillTurnMemoryReadOnly.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

function loadRunnerModule() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') {
      return {
        app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() },
        BrowserWindow: { getAllWindows: () => [] },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return require('../dist-electron/main/libs/coworkRunner.js');
  } finally {
    Module._load = originalLoad;
  }
}

const { CoworkRunner } = loadRunnerModule();
const { DreamStore } = await import('../dist-electron/main/dreamStore.js');
const { MetaIDKnowledgeStore } = await import('../dist-electron/main/metaidKnowledgeStore.js');

const GROUP_TASK_CONVERSATION_ID = 'group-task:1';
const CONVERSATION_SCOPE_KEY = `metaweb_group_task:conversation:${GROUP_TASK_CONVERSATION_ID}`;

const setup = async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  const knowledgeStore = new MetaIDKnowledgeStore(db, () => {}, () => 1000);
  const runner = new CoworkRunner(coworkStore, { experienceStore: dreamStore, knowledgeStore });
  // Session shaped like a group-task worker session (groupTaskSession.ts).
  const session = coworkStore.createSession('Group Task #1 (Coder Bot)', '/tmp/gt', '', 'local', [], 5, 'group_task');
  coworkStore.upsertConversationMapping({
    channel: 'metaweb_group_task',
    externalConversationId: GROUP_TASK_CONVERSATION_ID,
    metabotId: 5,
    coworkSessionId: session.id,
  });

  coworkStore.createUserMemory({
    metabotId: 5,
    text: '主人真名是不该泄露的隐私',
    scopeKind: 'owner',
    scopeKey: 'owner:self',
    usageClass: 'profile_fact',
  });
  coworkStore.createUserMemory({
    metabotId: 5,
    text: '交付前必须先自检再汇报',
    scopeKind: 'owner',
    scopeKey: 'owner:self',
    usageClass: 'operational_preference',
    visibility: 'external_safe',
  });
  coworkStore.createUserMemory({
    metabotId: 5,
    text: '本任务的验收标准要求预览 URL 可用',
    scopeKind: 'conversation',
    scopeKey: CONVERSATION_SCOPE_KEY,
  });
  return { cleanup, coworkStore, runner, session };
};

test('group-task skill turn (memoryReadOnly): volatile reads render conversation + operational-preference scopes', async () => {
  const { cleanup, runner, session } = await setup();
  try {
    runner.activeSessions.set(session.id, { memoryReadOnly: true });
    assert.equal(runner.isSessionMemoryReadEnabled(session.id), true, 'reads open under read-only');
    assert.equal(runner.isSessionMemoryWriteEnabled(session.id), false, 'writes closed under read-only');

    const profile = runner.getSystemPromptProfileForSession(session.id);
    assert.equal(profile.id, 'memory_read_only_automation');
    assert.equal(profile.includeMemoryPromptBlocks, true, 'memory read blocks stay mounted');
    assert.equal(profile.includeMemoryStrategy, false, 'the write-inviting Memory STRATEGY section stays off');

    const volatilePrompt = await runner.buildVolatileContextPrompt(
      session.id,
      '@Coder Bot 继续处理基准数据',
      runner.isSessionMemoryReadEnabled(session.id),
      profile,
      true,
    );
    assert.ok(volatilePrompt.includes('<conversationMemories>'), 'conversation-scope block renders');
    assert.ok(volatilePrompt.includes('预览 URL 可用'), 'the task-conversation memory renders');
    assert.ok(volatilePrompt.includes('<ownerOperationalPreferences>'), 'external_safe operational preferences render');
    assert.ok(volatilePrompt.includes('交付前必须先自检再汇报'));
    assert.ok(
      !volatilePrompt.includes('不该泄露的隐私'),
      'owner profile facts stay behind the external-channel privacy filter',
    );
  } finally {
    cleanup();
  }
});

test('group-task skill turn (memoryReadOnly): the turn-end memory write never enqueues', async () => {
  const { cleanup, coworkStore, runner, session } = await setup();
  try {
    coworkStore.addMessage(session.id, { type: 'user', content: '@Coder Bot 继续' });
    coworkStore.addMessage(session.id, { type: 'assistant', content: '[WORKING] 已接单' });

    runner.activeSessions.set(session.id, { memoryReadOnly: true });
    runner.applyTurnMemoryUpdatesForSession(session.id);
    assert.equal(runner.turnMemoryQueue.length, 0, 'no write job enqueued under read-only');
    assert.equal(runner.turnMemoryQueueKeys.size, 0);
  } finally {
    cleanup();
  }
});

test('control: a plain group-task session (no flags) keeps the default profile', async () => {
  const { cleanup, runner, session } = await setup();
  try {
    runner.activeSessions.set(session.id, {});
    const profile = runner.getSystemPromptProfileForSession(session.id);
    assert.equal(profile.id, 'default');
    assert.equal(profile.includeMemoryStrategy, true);
  } finally {
    cleanup();
  }
});
