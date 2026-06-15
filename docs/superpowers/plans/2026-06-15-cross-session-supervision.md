# Cross-Session Supervision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build local cross-session supervision so Cowork sessions can read any local Cowork/A2A session by `IDBots://{sessionId}`, and can insert source-prefixed user messages only into Cowork sessions while automatically queueing the target Cowork run.

**Architecture:** Keep UI behavior in the renderer session item, put direct session read/write semantics in a focused main-process cross-session service, and expose that service through the existing Cowork Runner host-tool MCP path. Add a per-target continuation queue inside `CoworkRunner` so cross-session writes do not interrupt active runs and do not duplicate the persisted user message.

**Tech Stack:** Electron main process, React renderer, TypeScript, existing `CoworkStore`, Claude Agent SDK MCP tools, sandbox host-tool bridge, `node:test`, `npm run compile:electron`.

**Repository note:** Current `.gitignore` ignores `docs/*` and `tests/*`. Any task that adds plan/test files must use `git add -f` for those files, otherwise verification can pass locally while the commit omits the plan or tests.

---

## File Structure

- Create `src/main/services/coworkCrossSession.ts`
  - Owns `IDBots://` parsing, result shapes, message length validation, direct read helpers, and source-prefixed Cowork-only writes.
  - Depends on `CoworkStore` only through `getSession()` and `addMessage()`.

- Modify `src/main/coworkStore.ts`
  - Add one public `getSessionLatestMessage(sessionId: string): CoworkMessage | null` helper using the same logical order as `getSessionMessages()`.

- Modify `src/main/libs/coworkRunner.ts`
  - Registers the new host tools for local SDK execution.
  - Handles sandbox host-tool requests asynchronously.
  - Adds a source-session-aware write tool and a per-target continuation queue.
  - Updates the memory/history prompt block to mention `IDBots://{sessionId}` tool use.

- Modify `sandbox/agent-runner/index.js`
  - Mirrors the new host tools inside the sandbox MCP server and delegates calls back to the host via `host_tool_request`.

- Create `src/renderer/components/cowork/coworkSessionLink.js`
  - Small renderer-safe helper for building and copying `IDBots://{sessionId}` links.

- Modify `src/renderer/components/cowork/CoworkSessionItem.tsx`
  - Adds the `复制Session ID` menu item.
  - Calls the renderer helper and closes the menu.

- Modify `src/renderer/services/i18n.ts`
  - Adds Chinese and English menu labels for copying session IDs.

- Create tests:
  - `tests/coworkCrossSessionService.test.mjs`
  - `tests/coworkCrossSessionRunner.test.mjs`
  - `tests/coworkSessionLink.test.mjs`
  - `tests/coworkSessionItemCopyMenu.test.mjs`

---

## Task 1: Main Cross-Session Service

**Files:**
- Create: `src/main/services/coworkCrossSession.ts`
- Modify: `src/main/coworkStore.ts`
- Test: `tests/coworkCrossSessionService.test.mjs`

- [ ] **Step 1: Write failing service tests**

Create `tests/coworkCrossSessionService.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  CROSS_SESSION_INSERT_MAX_CHARS,
  CoworkCrossSessionService,
  formatIdbotsSessionLink,
  normalizeIdbotsSessionId,
} = await import('../dist-electron/services/coworkCrossSession.js');

function message(id, type, content, timestamp, metadata = undefined) {
  return { id, type, content, timestamp, metadata };
}

function makeStore() {
  const sessions = new Map();
  const inserted = [];
  return {
    sessions,
    inserted,
    getSession(id) {
      return sessions.get(id) ?? null;
    },
    getSessionLatestMessage(id) {
      const session = sessions.get(id);
      return session?.messages?.at(-1) ?? null;
    },
    addMessage(sessionId, input) {
      const session = sessions.get(sessionId);
      assert.ok(session, `session should exist: ${sessionId}`);
      const record = {
        id: `inserted-${inserted.length + 1}`,
        timestamp: 1_800_000_000_000 + inserted.length,
        ...input,
      };
      session.messages.push(record);
      inserted.push({ sessionId, input, record });
      return record;
    },
  };
}

test('normalizes raw session ids and IDBots links', () => {
  assert.deepEqual(normalizeIdbotsSessionId('session-abc_123'), {
    ok: true,
    sessionId: 'session-abc_123',
  });
  assert.deepEqual(normalizeIdbotsSessionId('IDBots://session-abc_123'), {
    ok: true,
    sessionId: 'session-abc_123',
  });
  assert.deepEqual(normalizeIdbotsSessionId('idbots://session-abc_123'), {
    ok: true,
    sessionId: 'session-abc_123',
  });
  assert.equal(formatIdbotsSessionLink(' session-abc_123 '), 'IDBots://session-abc_123');
  assert.equal(normalizeIdbotsSessionId('IDBots://').code, 'INVALID_SESSION_ID');
  assert.equal(normalizeIdbotsSessionId('IDBots://bad/id').code, 'INVALID_SESSION_ID');
  assert.equal(normalizeIdbotsSessionId('bad id').code, 'INVALID_SESSION_ID');
});

test('reads full Cowork and A2A sessions by explicit session id', () => {
  const store = makeStore();
  store.sessions.set('cowork-1', {
    id: 'cowork-1',
    title: 'Cowork One',
    status: 'completed',
    sessionType: 'standard',
    createdAt: 1,
    updatedAt: 2,
    messages: [
      message('m1', 'user', 'hello', 10),
      message('m2', 'assistant', 'world', 11),
    ],
  });
  store.sessions.set('a2a-1', {
    id: 'a2a-1',
    title: 'A2A One',
    status: 'completed',
    sessionType: 'a2a',
    peerName: 'Remote Bot',
    createdAt: 3,
    updatedAt: 4,
    messages: [message('a1', 'assistant', 'remote state', 12)],
  });

  const service = new CoworkCrossSessionService(store);
  const cowork = service.readAll({ sessionId: 'IDBots://cowork-1' });
  assert.equal(cowork.ok, true);
  assert.equal(cowork.session.id, 'cowork-1');
  assert.equal(cowork.session.sessionType, 'standard');
  assert.deepEqual(cowork.messages.map((item) => item.content), ['hello', 'world']);

  const a2a = service.readAll({ sessionId: 'a2a-1' });
  assert.equal(a2a.ok, true);
  assert.equal(a2a.session.sessionType, 'a2a');
  assert.equal(a2a.messages[0].content, 'remote state');
});

test('reads the latest persisted message', () => {
  const store = makeStore();
  store.sessions.set('cowork-1', {
    id: 'cowork-1',
    title: 'Cowork One',
    status: 'completed',
    sessionType: 'standard',
    createdAt: 1,
    updatedAt: 2,
    messages: [
      message('m1', 'user', 'first', 10),
      message('m2', 'assistant', 'latest', 11, { toolName: 'x' }),
    ],
  });

  const service = new CoworkCrossSessionService(store);
  const latest = service.readLatest({ sessionId: 'cowork-1' });
  assert.equal(latest.ok, true);
  assert.equal(latest.message.content, 'latest');
  assert.deepEqual(latest.message.metadata, { toolName: 'x' });
});

test('returns SESSION_NOT_FOUND instead of empty history', () => {
  const service = new CoworkCrossSessionService(makeStore());
  const result = service.readAll({ sessionId: 'missing-session' });
  assert.deepEqual(result, {
    ok: false,
    code: 'SESSION_NOT_FOUND',
    message: 'No Cowork/A2A session found for the given session ID.',
  });
});

test('inserts source-prefixed user messages only into Cowork sessions', () => {
  const store = makeStore();
  store.sessions.set('source-1', {
    id: 'source-1',
    title: 'Source',
    status: 'completed',
    sessionType: 'standard',
    messages: [],
  });
  store.sessions.set('target-1', {
    id: 'target-1',
    title: 'Target',
    status: 'idle',
    sessionType: 'standard',
    messages: [],
  });
  store.sessions.set('a2a-1', {
    id: 'a2a-1',
    title: 'A2A',
    status: 'idle',
    sessionType: 'a2a',
    messages: [],
  });

  const service = new CoworkCrossSessionService(store);
  const inserted = service.insertUserMessage({
    sourceSessionId: 'source-1',
    targetSessionId: 'target-1',
    message: '  请检查最新状态  ',
  });

  assert.equal(inserted.ok, true);
  assert.equal(inserted.inserted, true);
  assert.equal(inserted.targetSession.id, 'target-1');
  assert.equal(inserted.message.content, '来自source-1 的信息：请检查最新状态');
  assert.equal(store.inserted[0].input.type, 'user');
  assert.equal(store.inserted[0].input.metadata.sourceChannel, 'idbots_cross_session');
  assert.equal(store.inserted[0].input.metadata.sourceSessionId, 'source-1');

  const a2aRejected = service.insertUserMessage({
    sourceSessionId: 'source-1',
    targetSessionId: 'a2a-1',
    message: 'must fail',
  });
  assert.equal(a2aRejected.ok, false);
  assert.equal(a2aRejected.code, 'WRITE_NOT_ALLOWED_FOR_A2A');
});

test('rejects empty and over-limit inserted messages', () => {
  const store = makeStore();
  store.sessions.set('target-1', {
    id: 'target-1',
    title: 'Target',
    status: 'idle',
    sessionType: 'standard',
    messages: [],
  });
  const service = new CoworkCrossSessionService(store);

  assert.equal(service.insertUserMessage({
    sourceSessionId: 'source-1',
    targetSessionId: 'target-1',
    message: '   ',
  }).code, 'EMPTY_MESSAGE');

  assert.equal(service.insertUserMessage({
    sourceSessionId: 'source-1',
    targetSessionId: 'target-1',
    message: 'x'.repeat(CROSS_SESSION_INSERT_MAX_CHARS + 1),
  }).code, 'MESSAGE_TOO_LONG');
});

test('warns when source and target are the same session', () => {
  const store = makeStore();
  store.sessions.set('same-1', {
    id: 'same-1',
    title: 'Same',
    status: 'idle',
    sessionType: 'standard',
    messages: [],
  });
  const service = new CoworkCrossSessionService(store);
  const result = service.insertUserMessage({
    sourceSessionId: 'same-1',
    targetSessionId: 'same-1',
    message: 'self instruction',
  });
  assert.equal(result.ok, true);
  assert.equal(result.warning, 'SOURCE_AND_TARGET_SESSION_ARE_THE_SAME');
});
```

- [ ] **Step 2: Run service tests to verify they fail**

Run:

```bash
npm run compile:electron && node --test tests/coworkCrossSessionService.test.mjs
```

Expected: FAIL because `dist-electron/services/coworkCrossSession.js` does not exist and `CoworkStore.getSessionLatestMessage` is not implemented.

- [ ] **Step 3: Add `getSessionLatestMessage` to `CoworkStore`**

In `src/main/coworkStore.ts`, add this public method immediately after the private `getSessionMessages()` method:

```ts
  getSessionLatestMessage(sessionId: string): CoworkMessage | null {
    const rows = this.getAll<CoworkMessageRow>(`
      SELECT id, type, content, metadata, created_at, sequence
      FROM cowork_messages
      WHERE session_id = ?
      ORDER BY
        created_at DESC,
        COALESCE(sequence, 0) DESC,
        ROWID DESC
      LIMIT 1
    `, [sessionId]);

    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      type: row.type as CoworkMessageType,
      content: row.content,
      timestamp: row.created_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }
```

- [ ] **Step 4: Add the cross-session service**

Create `src/main/services/coworkCrossSession.ts`:

```ts
import type { CoworkMessage, CoworkSession } from '../coworkStore';

export const IDBOTS_SESSION_LINK_SCHEME = 'IDBots://';
export const CROSS_SESSION_INSERT_MAX_CHARS = 8000;

export type CrossSessionErrorCode =
  | 'INVALID_SESSION_ID'
  | 'SESSION_NOT_FOUND'
  | 'WRITE_NOT_ALLOWED_FOR_A2A'
  | 'EMPTY_MESSAGE'
  | 'MESSAGE_TOO_LONG';

export type CrossSessionErrorResult = {
  ok: false;
  code: CrossSessionErrorCode;
  message: string;
};

export type CrossSessionSessionSummary = {
  id: string;
  title: string;
  status: string;
  sessionType: 'standard' | 'a2a';
  createdAt?: number;
  updatedAt?: number;
  hiddenFromSessionList?: boolean;
  peerName?: string | null;
  peerGlobalMetaId?: string | null;
};

export type CrossSessionMessageSummary = {
  id: string;
  type: CoworkMessage['type'];
  content: string;
  timestamp: number;
  metadata?: CoworkMessage['metadata'];
};

type StoreLike = {
  getSession(id: string): CoworkSession | null;
  getSessionLatestMessage?(id: string): CoworkMessage | null;
  addMessage(sessionId: string, message: Omit<CoworkMessage, 'id' | 'timestamp'>): CoworkMessage;
};

export function formatIdbotsSessionLink(sessionId: string): string {
  return `${IDBOTS_SESSION_LINK_SCHEME}${String(sessionId ?? '').trim()}`;
}

export function normalizeIdbotsSessionId(input: unknown): { ok: true; sessionId: string } | CrossSessionErrorResult {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) {
    return invalidSessionId();
  }

  const linkMatch = raw.match(/^idbots:\/\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/i);
  const sessionId = linkMatch ? linkMatch[1] : raw;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) {
    return invalidSessionId();
  }

  return { ok: true, sessionId };
}

function invalidSessionId(): CrossSessionErrorResult {
  return {
    ok: false,
    code: 'INVALID_SESSION_ID',
    message: 'Session ID is missing or invalid.',
  };
}

function sessionNotFound(): CrossSessionErrorResult {
  return {
    ok: false,
    code: 'SESSION_NOT_FOUND',
    message: 'No Cowork/A2A session found for the given session ID.',
  };
}

function summarizeSession(session: CoworkSession): CrossSessionSessionSummary {
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    sessionType: session.sessionType === 'a2a' ? 'a2a' : 'standard',
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    hiddenFromSessionList: session.hiddenFromSessionList,
    peerName: session.peerName ?? null,
    peerGlobalMetaId: session.peerGlobalMetaId ?? null,
  };
}

function summarizeMessage(message: CoworkMessage): CrossSessionMessageSummary {
  return {
    id: message.id,
    type: message.type,
    content: message.content,
    timestamp: message.timestamp,
    metadata: message.metadata,
  };
}

export class CoworkCrossSessionService {
  constructor(private readonly store: StoreLike) {}

  readAll(input: { sessionId: unknown }): (
    | CrossSessionErrorResult
    | {
        ok: true;
        session: CrossSessionSessionSummary;
        messages: CrossSessionMessageSummary[];
      }
  ) {
    const normalized = normalizeIdbotsSessionId(input.sessionId);
    if (!normalized.ok) return normalized;

    const session = this.store.getSession(normalized.sessionId);
    if (!session) return sessionNotFound();

    return {
      ok: true,
      session: summarizeSession(session),
      messages: session.messages.map(summarizeMessage),
    };
  }

  readLatest(input: { sessionId: unknown }): (
    | CrossSessionErrorResult
    | {
        ok: true;
        session: CrossSessionSessionSummary;
        message: CrossSessionMessageSummary | null;
      }
  ) {
    const normalized = normalizeIdbotsSessionId(input.sessionId);
    if (!normalized.ok) return normalized;

    const session = this.store.getSession(normalized.sessionId);
    if (!session) return sessionNotFound();

    const latest = this.store.getSessionLatestMessage
      ? this.store.getSessionLatestMessage(session.id)
      : session.messages.at(-1) ?? null;

    return {
      ok: true,
      session: summarizeSession(session),
      message: latest ? summarizeMessage(latest) : null,
    };
  }

  insertUserMessage(input: {
    sourceSessionId: unknown;
    targetSessionId: unknown;
    message: unknown;
  }): (
    | CrossSessionErrorResult
    | {
        ok: true;
        inserted: true;
        targetSession: CrossSessionSessionSummary;
        message: CrossSessionMessageSummary;
        warning?: 'SOURCE_AND_TARGET_SESSION_ARE_THE_SAME';
      }
  ) {
    const source = normalizeIdbotsSessionId(input.sourceSessionId);
    if (!source.ok) return source;
    const target = normalizeIdbotsSessionId(input.targetSessionId);
    if (!target.ok) return target;

    const rawMessage = typeof input.message === 'string' ? input.message.trim() : '';
    if (!rawMessage) {
      return {
        ok: false,
        code: 'EMPTY_MESSAGE',
        message: 'Message is empty after trimming.',
      };
    }
    if (rawMessage.length > CROSS_SESSION_INSERT_MAX_CHARS) {
      return {
        ok: false,
        code: 'MESSAGE_TOO_LONG',
        message: 'Message exceeds the cross-session insert limit.',
      };
    }

    const targetSession = this.store.getSession(target.sessionId);
    if (!targetSession) return sessionNotFound();
    if (targetSession.sessionType === 'a2a') {
      return {
        ok: false,
        code: 'WRITE_NOT_ALLOWED_FOR_A2A',
        message: 'A2A sessions are read-only for cross-session tools.',
      };
    }

    const inserted = this.store.addMessage(targetSession.id, {
      type: 'user',
      content: `来自${source.sessionId} 的信息：${rawMessage}`,
      metadata: {
        sourceChannel: 'idbots_cross_session',
        sourceSessionId: source.sessionId,
      },
    });

    return {
      ok: true,
      inserted: true,
      targetSession: summarizeSession(targetSession),
      message: summarizeMessage(inserted),
      ...(source.sessionId === targetSession.id
        ? { warning: 'SOURCE_AND_TARGET_SESSION_ARE_THE_SAME' as const }
        : {}),
    };
  }
}
```

- [ ] **Step 5: Run service tests to verify they pass**

Run:

```bash
npm run compile:electron && node --test tests/coworkCrossSessionService.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit service unit**

```bash
git add -f src/main/services/coworkCrossSession.ts src/main/coworkStore.ts tests/coworkCrossSessionService.test.mjs
git commit -m "feat: add cross-session service"
```

After the commit, publish a development journal with Codex's `metabot-post-buzz` skill describing the service, parser, read/write constraints, and tests.

---

## Task 2: Runner Host Tools and Continuation Queue

**Files:**
- Modify: `src/main/libs/coworkRunner.ts`
- Test: `tests/coworkCrossSessionRunner.test.mjs`

- [ ] **Step 1: Write failing Runner tests**

Create `tests/coworkCrossSessionRunner.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { EventEmitter } from 'node:events';

const require = Module.createRequire(import.meta.url);

function loadCoworkRunner() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => process.cwd(),
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return require('../dist-electron/libs/coworkRunner.js');
  } finally {
    Module._load = originalLoad;
  }
}

function makeSession(id, patch = {}) {
  return {
    id,
    title: id,
    claudeSessionId: null,
    status: 'idle',
    pinned: false,
    cwd: process.cwd(),
    systemPrompt: '',
    executionMode: 'local',
    activeSkillIds: [],
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    sessionType: 'standard',
    ...patch,
  };
}

function makeStore() {
  const sessions = new Map();
  const store = {
    sessions,
    updates: [],
    getMemoryBackend() {
      return {
        getEffectiveMemoryPolicyForSession() {
          return {
            memoryEnabled: false,
            memoryImplicitUpdateEnabled: false,
            memoryLlmJudgeEnabled: false,
            memoryGuardLevel: 'strict',
            memoryUserMemoriesMaxItems: 12,
          };
        },
        resolveMetabotIdForMemory() {
          return null;
        },
      };
    },
    getConfig() {
      return { executionMode: 'local', systemPrompt: '', workingDirectory: process.cwd() };
    },
    getSession(id) {
      return sessions.get(id) ?? null;
    },
    getSessionLatestMessage(id) {
      return sessions.get(id)?.messages?.at(-1) ?? null;
    },
    getConversationSourceContextBySession() {
      return { sourceChannel: 'cowork_ui', externalConversationId: null };
    },
    updateSession(id, patch) {
      const session = sessions.get(id);
      if (session) Object.assign(session, patch);
      store.updates.push({ id, patch });
    },
    addMessage(id, input) {
      const session = sessions.get(id);
      assert.ok(session, `session exists: ${id}`);
      const record = {
        id: `${id}-message-${session.messages.length + 1}`,
        timestamp: 1_800_000_000_000 + session.messages.length,
        ...input,
      };
      session.messages.push(record);
      return record;
    },
    conversationSearch() {
      return [];
    },
    recentChats() {
      return [];
    },
  };
  return store;
}

function parseToolText(text) {
  return JSON.parse(text);
}

test('host tools read sessions through handleHostToolExecution', async () => {
  const { CoworkRunner } = loadCoworkRunner();
  const store = makeStore();
  store.sessions.set('source-1', makeSession('source-1'));
  store.sessions.set('target-1', makeSession('target-1', {
    messages: [
      { id: 'm1', type: 'user', content: 'first', timestamp: 10 },
      { id: 'm2', type: 'assistant', content: 'latest', timestamp: 11 },
    ],
  }));

  const runner = new CoworkRunner(store);
  const all = await runner.handleHostToolExecution({
    toolName: 'idbots_session_read_all',
    toolInput: { sessionId: 'IDBots://target-1' },
  }, 'source-1');
  assert.equal(all.success, true);
  assert.deepEqual(parseToolText(all.text).messages.map((item) => item.content), ['first', 'latest']);

  const latest = await runner.handleHostToolExecution({
    toolName: 'idbots_session_read_latest',
    toolInput: { sessionId: 'target-1' },
  }, 'source-1');
  assert.equal(latest.success, true);
  assert.equal(parseToolText(latest.text).message.content, 'latest');
});

test('write tool inserts source-prefixed message and queues target continuation without duplicate user messages', async () => {
  const { CoworkRunner } = loadCoworkRunner();
  const store = makeStore();
  store.sessions.set('source-1', makeSession('source-1'));
  store.sessions.set('target-1', makeSession('target-1'));

  const runner = new CoworkRunner(store);
  const runCalls = [];
  runner.runClaudeCode = async (activeSession, prompt) => {
    runCalls.push({ sessionId: activeSession.sessionId, prompt });
    runner.emit('complete', activeSession.sessionId, activeSession.claudeSessionId);
  };

  const seenMessages = [];
  runner.on('message', (sessionId, msg) => {
    seenMessages.push({ sessionId, msg });
  });

  const result = await runner.handleHostToolExecution({
    toolName: 'idbots_session_insert_user_message',
    toolInput: { targetSessionId: 'target-1', sourceSessionId: 'spoofed-source', message: '检查状态' },
  }, 'source-1');

  assert.equal(result.success, true);
  const payload = parseToolText(result.text);
  assert.equal(payload.ok, true);
  assert.equal(payload.inserted, true);
  assert.equal(payload.runQueued, true);
  assert.equal(store.sessions.get('target-1').messages.length, 1);
  assert.equal(store.sessions.get('target-1').messages[0].content, '来自source-1 的信息：检查状态');
  assert.doesNotMatch(store.sessions.get('target-1').messages[0].content, /spoofed-source/);
  assert.equal(seenMessages[0].sessionId, 'target-1');

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(runCalls, [
    { sessionId: 'target-1', prompt: '来自source-1 的信息：检查状态' },
  ]);
  assert.equal(
    store.sessions.get('target-1').messages.filter((item) => item.type === 'user').length,
    1,
    'queued continuation must not add a duplicate user message'
  );
});

test('write tool rejects A2A targets and does not queue a run', async () => {
  const { CoworkRunner } = loadCoworkRunner();
  const store = makeStore();
  store.sessions.set('source-1', makeSession('source-1'));
  store.sessions.set('a2a-1', makeSession('a2a-1', { sessionType: 'a2a' }));
  const runner = new CoworkRunner(store);
  const runCalls = [];
  runner.runClaudeCode = async (activeSession, prompt) => {
    runCalls.push({ sessionId: activeSession.sessionId, prompt });
  };

  const result = await runner.handleHostToolExecution({
    toolName: 'idbots_session_insert_user_message',
    toolInput: { targetSessionId: 'a2a-1', message: 'must not write' },
  }, 'source-1');

  assert.equal(result.success, false);
  assert.equal(parseToolText(result.text).code, 'WRITE_NOT_ALLOWED_FOR_A2A');
  assert.equal(runCalls.length, 0);
  assert.equal(store.sessions.get('a2a-1').messages.length, 0);
});

test('write tool reports partial success if queue acceptance fails after insert', async () => {
  const { CoworkRunner } = loadCoworkRunner();
  const store = makeStore();
  store.sessions.set('source-1', makeSession('source-1'));
  store.sessions.set('target-1', makeSession('target-1'));
  const runner = new CoworkRunner(store);
  runner.enqueueCrossSessionContinuation = () => {
    throw new Error('queue unavailable');
  };

  const result = await runner.handleHostToolExecution({
    toolName: 'idbots_session_insert_user_message',
    toolInput: { targetSessionId: 'target-1', message: 'still insert' },
  }, 'source-1');

  assert.equal(result.success, true);
  const payload = parseToolText(result.text);
  assert.equal(payload.ok, true);
  assert.equal(payload.inserted, true);
  assert.equal(payload.runQueued, false);
  assert.equal(payload.warning, 'MESSAGE_INSERTED_BUT_RUN_NOT_QUEUED');
  assert.equal(store.sessions.get('target-1').messages[0].content, '来自source-1 的信息：still insert');
});

test('active target sessions process queued cross-session continuations in order', async () => {
  const { CoworkRunner } = loadCoworkRunner();
  const store = makeStore();
  store.sessions.set('source-1', makeSession('source-1'));
  store.sessions.set('target-1', makeSession('target-1'));
  const runner = new CoworkRunner(store);

  const releases = [];
  const runCalls = [];
  runner.runClaudeCode = async (activeSession, prompt) => {
    runCalls.push({ sessionId: activeSession.sessionId, prompt });
    await new Promise((resolve) => releases.push(resolve));
    runner.emit('complete', activeSession.sessionId, activeSession.claudeSessionId);
  };

  const firstRun = runner.startSession('target-1', 'initial run');
  await new Promise((resolve) => setImmediate(resolve));

  const firstQueued = await runner.handleHostToolExecution({
    toolName: 'idbots_session_insert_user_message',
    toolInput: { targetSessionId: 'target-1', message: 'first queued' },
  }, 'source-1');
  const secondQueued = await runner.handleHostToolExecution({
    toolName: 'idbots_session_insert_user_message',
    toolInput: { targetSessionId: 'target-1', message: 'second queued' },
  }, 'source-1');

  assert.equal(parseToolText(firstQueued.text).runQueued, true);
  assert.equal(parseToolText(secondQueued.text).runQueued, true);
  assert.deepEqual(runCalls.map((item) => item.prompt), ['initial run']);

  releases.shift()();
  await firstRun;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runner.activeSessions.has('target-1'), true, 'retained sandbox-like active session must not block queued runs');
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(runCalls.map((item) => item.prompt), [
    'initial run',
    '来自source-1 的信息：first queued',
    '来自source-1 的信息：second queued',
  ]);
});
```

- [ ] **Step 2: Run Runner tests to verify they fail**

Run:

```bash
npm run compile:electron && node --test tests/coworkCrossSessionRunner.test.mjs
```

Expected: FAIL because the new host tools and queue do not exist.

- [ ] **Step 3: Import cross-session service and add queue types**

In `src/main/libs/coworkRunner.ts`, add the import near other service imports:

```ts
import { CoworkCrossSessionService } from '../services/coworkCrossSession';
```

Add these types near `QueuedTurnMemoryUpdate`:

```ts
interface QueuedCrossSessionContinuation {
  targetSessionId: string;
  prompt: string;
  enqueuedAt: number;
}
```

Add these fields to `CoworkRunner`:

```ts
  private crossSessionContinuationQueues: Map<string, QueuedCrossSessionContinuation[]> = new Map();
  private crossSessionContinuationDraining: Set<string> = new Set();
  private crossSessionRunningTurns: Set<string> = new Set();
  private crossSessionService: CoworkCrossSessionService | null = null;
```

Add this helper near `getMemoryBackend()`:

```ts
  private getCrossSessionService(): CoworkCrossSessionService {
    if (!this.crossSessionService) {
      this.crossSessionService = new CoworkCrossSessionService(this.store);
    }
    return this.crossSessionService;
  }
```

- [ ] **Step 4: Add queue helpers**

Add these private methods before `startSession()`:

```ts
  private markCrossSessionTurnRunning(sessionId: string): void {
    this.crossSessionRunningTurns.add(sessionId);
  }

  private markCrossSessionTurnSettled(sessionId: string): void {
    this.crossSessionRunningTurns.delete(sessionId);
    this.scheduleCrossSessionContinuationDrain(sessionId);
  }

  private isCrossSessionTurnRunning(sessionId: string): boolean {
    return this.crossSessionRunningTurns.has(sessionId);
  }

  private scheduleCrossSessionContinuationDrain(sessionId: string): void {
    if (this.isCrossSessionTurnRunning(sessionId)) {
      return;
    }
    const queue = this.crossSessionContinuationQueues.get(sessionId);
    if (!queue || queue.length === 0) {
      return;
    }
    void this.drainCrossSessionContinuationQueue(sessionId);
  }

  private async drainCrossSessionContinuationQueue(sessionId: string): Promise<void> {
    if (this.crossSessionContinuationDraining.has(sessionId)) {
      return;
    }
    if (this.isCrossSessionTurnRunning(sessionId)) {
      return;
    }

    this.crossSessionContinuationDraining.add(sessionId);
    try {
      while (!this.isCrossSessionTurnRunning(sessionId)) {
        const queue = this.crossSessionContinuationQueues.get(sessionId);
        const next = queue?.shift();
        if (!next) {
          this.crossSessionContinuationQueues.delete(sessionId);
          return;
        }
        if (queue.length === 0) {
          this.crossSessionContinuationQueues.delete(sessionId);
        }
        await this.continueSession(next.targetSessionId, next.prompt, {
          skipUserMessage: true,
        });
      }
    } finally {
      this.crossSessionContinuationDraining.delete(sessionId);
      if (!this.isCrossSessionTurnRunning(sessionId)) {
        const queue = this.crossSessionContinuationQueues.get(sessionId);
        if (queue && queue.length > 0) {
          void this.drainCrossSessionContinuationQueue(sessionId);
        }
      }
    }
  }

  private enqueueCrossSessionContinuation(targetSessionId: string, prompt: string): {
    runQueued: true;
    queueDepth: number;
  } {
    const queue = this.crossSessionContinuationQueues.get(targetSessionId) ?? [];
    queue.push({
      targetSessionId,
      prompt,
      enqueuedAt: Date.now(),
    });
    this.crossSessionContinuationQueues.set(targetSessionId, queue);
    this.scheduleCrossSessionContinuationDrain(targetSessionId);
    return {
      runQueued: true,
      queueDepth: queue.length,
    };
  }
```

Important: do not use `activeSessions.has(sessionId)` as the drain guard. Sandbox sessions may keep an `activeSession` alive after a turn completes so a later continuation can reuse the VM; the queue guard must represent an in-flight LLM turn only.

- [ ] **Step 5: Add `skipUserMessage` to continuation options**

Change the `continueSession` signature:

```ts
  async continueSession(
    sessionId: string,
    prompt: string,
    options: { systemPrompt?: string; skillIds?: string[]; skipUserMessage?: boolean } = {}
  ): Promise<void> {
```

Change the inactive branch:

```ts
      await this.startSession(sessionId, prompt, {
        skillIds: options.skillIds,
        systemPrompt: options.systemPrompt,
        skipInitialUserMessage: options.skipUserMessage,
      });
```

Wrap the user-message insertion:

```ts
    if (!options.skipUserMessage) {
      const userMessage = this.store.addMessage(sessionId, {
        type: 'user',
        content: prompt,
        metadata: options.skillIds?.length ? { skillIds: options.skillIds } : undefined,
      });
      this.emit('message', sessionId, userMessage);
    }
```

At the end of the `startSession()` `try/catch` around `runClaudeCode`, add a `finally`:

```ts
    this.markCrossSessionTurnRunning(sessionId);
    try {
      await this.runClaudeCode(activeSession, prompt, sessionCwd, effectiveSystemPrompt);
    } catch (error) {
      console.error('Cowork session error:', error);
    } finally {
      this.markCrossSessionTurnSettled(sessionId);
    }
```

At the end of the `continueSession()` `try/catch` around `runClaudeCode`, add a `finally`:

```ts
    this.markCrossSessionTurnRunning(sessionId);
    try {
      await this.runClaudeCode(activeSession, prompt, sessionCwd, effectiveSystemPrompt);
    } catch (error) {
      console.error('Cowork continue error:', error);
    } finally {
      this.markCrossSessionTurnSettled(sessionId);
    }
```

- [ ] **Step 6: Add host tool implementations**

Change `handleHostToolExecution` to async:

```ts
  async handleHostToolExecution(payload: Record<string, unknown>, sessionId: string): Promise<{ success: boolean; text: string }> {
```

Add these helpers near `runRecentChatsTool()`:

```ts
  private formatCrossSessionToolOutput(result: unknown): string {
    return JSON.stringify(result, null, 2);
  }

  private runIdbotsSessionReadAllTool(args: { sessionId?: unknown }): { success: boolean; text: string } {
    const result = this.getCrossSessionService().readAll({ sessionId: args.sessionId });
    return {
      success: Boolean((result as { ok?: boolean }).ok),
      text: this.formatCrossSessionToolOutput(result),
    };
  }

  private runIdbotsSessionReadLatestTool(args: { sessionId?: unknown }): { success: boolean; text: string } {
    const result = this.getCrossSessionService().readLatest({ sessionId: args.sessionId });
    return {
      success: Boolean((result as { ok?: boolean }).ok),
      text: this.formatCrossSessionToolOutput(result),
    };
  }

  private async runIdbotsSessionInsertUserMessageTool(
    args: { targetSessionId?: unknown; message?: unknown },
    sourceSessionId: string
  ): Promise<{ success: boolean; text: string }> {
    const result = this.getCrossSessionService().insertUserMessage({
      sourceSessionId,
      targetSessionId: args.targetSessionId,
      message: args.message,
    });
    if (!result.ok) {
      return {
        success: false,
        text: this.formatCrossSessionToolOutput(result),
      };
    }

    this.emit('message', result.targetSession.id, result.message);

    try {
      const queued = this.enqueueCrossSessionContinuation(result.targetSession.id, result.message.content);
      return {
        success: true,
        text: this.formatCrossSessionToolOutput({
          ...result,
          runQueued: queued.runQueued,
          queueDepth: queued.queueDepth,
        }),
      };
    } catch (error) {
      return {
        success: true,
        text: this.formatCrossSessionToolOutput({
          ...result,
          runQueued: false,
          warning: 'MESSAGE_INSERTED_BUT_RUN_NOT_QUEUED',
          scheduleError: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  }
```

`runQueued: true` means the continuation was accepted by the runner queue. The actual LLM turn runs asynchronously; if that later turn fails, the failure should be recorded on the target Cowork session through the existing runner error path. `MESSAGE_INSERTED_BUT_RUN_NOT_QUEUED` is only for failures before queue acceptance, after the user message has already been persisted.

Add cases inside `handleHostToolExecution()` before the unsupported-tool branch:

```ts
      if (toolName === 'idbots_session_read_all') {
        return this.runIdbotsSessionReadAllTool({
          sessionId: toolInput.sessionId,
        });
      }

      if (toolName === 'idbots_session_read_latest') {
        return this.runIdbotsSessionReadLatestTool({
          sessionId: toolInput.sessionId,
        });
      }

      if (toolName === 'idbots_session_insert_user_message') {
        return await this.runIdbotsSessionInsertUserMessageTool({
          targetSessionId: toolInput.targetSessionId,
          message: toolInput.message,
        }, sessionId);
      }
```

- [ ] **Step 7: Await host-tool execution in sandbox bridge handlers**

In both `host_tool_request` handlers in `src/main/libs/coworkRunner.ts`, replace the sync call with an async IIFE.

For the first handler:

```ts
          void (async () => {
            const result = await this.handleHostToolExecution(payload, sessionId);
            this.writeSandboxHostToolResponse(activeSession, paths.responsesDir, requestId, {
              type: 'host_tool_response',
              requestId,
              success: result.success,
              text: result.text,
              error: result.success ? undefined : result.text,
            });
          })().catch((error) => {
            this.writeSandboxHostToolResponse(activeSession, paths.responsesDir, requestId, {
              type: 'host_tool_response',
              requestId,
              success: false,
              text: error instanceof Error ? error.message : String(error),
              error: error instanceof Error ? error.message : String(error),
            });
          });
```

For the second handler, use the same block and replace `requestId` with `reqId`.

- [ ] **Step 8: Register local SDK MCP tools**

In the `memoryTools` array inside `CoworkRunner`, add these tool definitions after `recent_chats`:

```ts
        tool(
          'idbots_session_read_all',
          'Read all persisted messages from a local IDBots Cowork or A2A session by raw session id or IDBots:// session link.',
          {
            sessionId: z.string().min(1),
          },
          async (args: { sessionId: string }) => {
            const result = this.runIdbotsSessionReadAllTool(args);
            return {
              content: [{ type: 'text', text: result.text }],
              isError: !result.success,
            } as any;
          }
        ),
        tool(
          'idbots_session_read_latest',
          'Read the latest persisted message from a local IDBots Cowork or A2A session by raw session id or IDBots:// session link.',
          {
            sessionId: z.string().min(1),
          },
          async (args: { sessionId: string }) => {
            const result = this.runIdbotsSessionReadLatestTool(args);
            return {
              content: [{ type: 'text', text: result.text }],
              isError: !result.success,
            } as any;
          }
        ),
        tool(
          'idbots_session_insert_user_message',
          'Insert a user-side instruction into a local Cowork session and automatically queue that Cowork session to continue. A2A targets are read-only and rejected.',
          {
            targetSessionId: z.string().min(1),
            message: z.string().min(1),
          },
          async (args: { targetSessionId: string; message: string }) => {
            const result = await this.runIdbotsSessionInsertUserMessageTool(args, sessionId);
            return {
              content: [{ type: 'text', text: result.text }],
              isError: !result.success,
            } as any;
          }
        ),
```

- [ ] **Step 9: Update the prompt strategy**

In `buildMemoryStrategyPrompt()`, append these lines to `memoryRecallPrompt`:

```ts
      '- When the user or conversation includes `IDBots://{sessionId}`, extract the session id and use `idbots_session_read_all` or `idbots_session_read_latest` before relying on memory or asking the user to paste history.',
      '- Use `idbots_session_insert_user_message` only when you need to send an instruction into another Cowork session. The tool derives your source session id automatically. A2A sessions are read-only targets for this tool family.',
```

- [ ] **Step 10: Run Runner tests**

Run:

```bash
npm run compile:electron && node --test tests/coworkCrossSessionRunner.test.mjs
```

Expected: PASS.

- [ ] **Step 11: Commit Runner unit**

```bash
git add -f src/main/libs/coworkRunner.ts tests/coworkCrossSessionRunner.test.mjs
git commit -m "feat: add cross-session runner tools"
```

After the commit, publish a development journal with Codex's `metabot-post-buzz` skill describing host tools, source-session derivation, A2A write rejection, and continuation queue behavior.

---

## Task 3: Sandbox Host Tool Mirror

**Files:**
- Modify: `sandbox/agent-runner/index.js`
- Test: `tests/runtimeDependencyContract.test.mjs`

- [ ] **Step 1: Add failing sandbox contract tests**

Append these tests to `tests/runtimeDependencyContract.test.mjs`:

```js
test('sandbox runner mirrors IDBots cross-session host tools', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'sandbox/agent-runner/index.js'), 'utf8');

  assert.match(source, /idbots_session_read_all/);
  assert.match(source, /idbots_session_read_latest/);
  assert.match(source, /idbots_session_insert_user_message/);
  assert.match(source, /callHostTool\('idbots_session_read_all'/);
  assert.match(source, /callHostTool\('idbots_session_read_latest'/);
  assert.match(source, /callHostTool\('idbots_session_insert_user_message'/);
});

test('CoworkRunner prompt teaches IDBots session links and write boundary', () => {
  const source = fs.readFileSync(coworkRunnerPath, 'utf8');

  assert.match(source, /IDBots:\/\/\{sessionId\}/);
  assert.match(source, /idbots_session_read_all/);
  assert.match(source, /idbots_session_read_latest/);
  assert.match(source, /idbots_session_insert_user_message/);
  assert.match(source, /A2A sessions are read-only/);
});
```

- [ ] **Step 2: Run contract tests to verify they fail**

Run:

```bash
node --test tests/runtimeDependencyContract.test.mjs
```

Expected: FAIL because sandbox tool names are missing.

- [ ] **Step 3: Mirror the sandbox tools**

In `sandbox/agent-runner/index.js`, add these definitions to the `memoryTools` array after `recent_chats`:

```js
        tool(
          'idbots_session_read_all',
          'Read all persisted messages from a local IDBots Cowork or A2A session by raw session id or IDBots:// session link.',
          {
            sessionId: z.string().min(1),
          },
          async (args, { signal }) => {
            const response = await callHostTool('idbots_session_read_all', args, signal);
            const text = typeof response?.text === 'string'
              ? response.text
              : typeof response?.error === 'string'
                ? response.error
                : '';
            return {
              content: [{ type: 'text', text }],
              isError: response?.success === false,
            };
          }
        ),
        tool(
          'idbots_session_read_latest',
          'Read the latest persisted message from a local IDBots Cowork or A2A session by raw session id or IDBots:// session link.',
          {
            sessionId: z.string().min(1),
          },
          async (args, { signal }) => {
            const response = await callHostTool('idbots_session_read_latest', args, signal);
            const text = typeof response?.text === 'string'
              ? response.text
              : typeof response?.error === 'string'
                ? response.error
                : '';
            return {
              content: [{ type: 'text', text }],
              isError: response?.success === false,
            };
          }
        ),
        tool(
          'idbots_session_insert_user_message',
          'Insert a user-side instruction into a local Cowork session and automatically queue that Cowork session to continue. A2A targets are read-only and rejected.',
          {
            targetSessionId: z.string().min(1),
            message: z.string().min(1),
          },
          async (args, { signal }) => {
            const response = await callHostTool('idbots_session_insert_user_message', args, signal);
            const text = typeof response?.text === 'string'
              ? response.text
              : typeof response?.error === 'string'
                ? response.error
                : '';
            return {
              content: [{ type: 'text', text }],
              isError: response?.success === false,
            };
          }
        ),
```

- [ ] **Step 4: Run sandbox contract tests**

Run:

```bash
node --test tests/runtimeDependencyContract.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit sandbox mirror**

```bash
git add -f sandbox/agent-runner/index.js tests/runtimeDependencyContract.test.mjs
git commit -m "feat: mirror cross-session tools in sandbox"
```

After the commit, publish a development journal with Codex's `metabot-post-buzz` skill describing sandbox host-tool parity.

---

## Task 4: Sidebar Copy Session ID

**Files:**
- Create: `src/renderer/components/cowork/coworkSessionLink.js`
- Modify: `src/renderer/components/cowork/CoworkSessionItem.tsx`
- Modify: `src/renderer/services/i18n.ts`
- Test: `tests/coworkSessionLink.test.mjs`
- Test: `tests/coworkSessionItemCopyMenu.test.mjs`

- [ ] **Step 1: Write failing renderer helper and menu tests**

Create `tests/coworkSessionLink.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  buildCoworkSessionLink,
  copyCoworkSessionLinkToClipboard,
} = await import('../src/renderer/components/cowork/coworkSessionLink.js');

test('buildCoworkSessionLink formats local IDBots session links', () => {
  assert.equal(buildCoworkSessionLink(' session-123 '), 'IDBots://session-123');
  assert.equal(buildCoworkSessionLink(''), '');
  assert.equal(buildCoworkSessionLink(null), '');
});

test('copyCoworkSessionLinkToClipboard writes formatted links', async () => {
  const writes = [];
  const clipboard = {
    async writeText(value) {
      writes.push(value);
    },
  };

  assert.equal(await copyCoworkSessionLinkToClipboard('session-123', clipboard), true);
  assert.deepEqual(writes, ['IDBots://session-123']);
  assert.equal(await copyCoworkSessionLinkToClipboard('   ', clipboard), false);
  assert.equal(await copyCoworkSessionLinkToClipboard('session-456', null), false);
});
```

Create `tests/coworkSessionItemCopyMenu.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const itemPath = path.join(repoRoot, 'src/renderer/components/cowork/CoworkSessionItem.tsx');
const i18nPath = path.join(repoRoot, 'src/renderer/services/i18n.ts');

test('CoworkSessionItem menu includes copy session id action', () => {
  const source = fs.readFileSync(itemPath, 'utf8');

  assert.match(source, /copyCoworkSessionLinkToClipboard/);
  assert.match(source, /coworkCopySessionId/);
  assert.match(source, /ClipboardDocumentIcon/);
  assert.match(source, /key:\s*'copy-session-id'/);
});

test('i18n includes copy session id labels in zh and en', () => {
  const source = fs.readFileSync(i18nPath, 'utf8');

  assert.match(source, /coworkCopySessionId:\s*'复制Session ID'/);
  assert.match(source, /coworkCopySessionId:\s*'Copy Session ID'/);
});
```

- [ ] **Step 2: Run renderer tests to verify they fail**

Run:

```bash
node --test tests/coworkSessionLink.test.mjs tests/coworkSessionItemCopyMenu.test.mjs
```

Expected: FAIL because the helper and menu item do not exist.

- [ ] **Step 3: Add renderer session-link helper**

Create `src/renderer/components/cowork/coworkSessionLink.js`:

```js
export function buildCoworkSessionLink(sessionId) {
  const normalized = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalized) return '';
  return `IDBots://${normalized}`;
}

export async function copyCoworkSessionLinkToClipboard(sessionId, clipboard) {
  const link = buildCoworkSessionLink(sessionId);
  if (!link || !clipboard?.writeText) {
    return false;
  }
  await clipboard.writeText(link);
  return true;
}
```

- [ ] **Step 4: Add i18n labels**

In `src/renderer/services/i18n.ts`, add these keys in the Chinese chat/cowork area:

```ts
    coworkCopySessionId: '复制Session ID',
```

Add these keys in the English chat/cowork area:

```ts
    coworkCopySessionId: 'Copy Session ID',
```

- [ ] **Step 5: Add menu item to `CoworkSessionItem`**

Update the imports in `src/renderer/components/cowork/CoworkSessionItem.tsx`:

```ts
import { ClipboardDocumentIcon, EllipsisHorizontalIcon, ExclamationTriangleIcon, PencilSquareIcon, TrashIcon } from '@heroicons/react/24/outline';
import { copyCoworkSessionLinkToClipboard } from './coworkSessionLink.js';
```

Add the handler before `handleDeleteClick`:

```ts
  const handleCopySessionIdClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const clipboard = typeof navigator === 'undefined' ? null : navigator.clipboard;
    void copyCoworkSessionLinkToClipboard(session.id, clipboard).catch(() => {});
    closeMenu();
  };
```

Change `menuHeight` from `120` to `160` in `openMenu()`, and from `120` to `160` in the repositioning effect when `showConfirmDelete` is false.

Add labels:

```ts
  const copySessionIdLabel = i18nService.t('coworkCopySessionId');
```

Add the menu item before rename:

```ts
      { key: 'copy-session-id', label: copySessionIdLabel, onClick: handleCopySessionIdClick, tone: 'neutral' as const },
```

Add `copySessionIdLabel` and `handleCopySessionIdClick` to the `useMemo` dependency list.

Add the icon in the rendered menu:

```tsx
              {item.key === 'copy-session-id' && <ClipboardDocumentIcon className="h-4 w-4" />}
```

- [ ] **Step 6: Run renderer tests and type check**

Run:

```bash
node --test tests/coworkSessionLink.test.mjs tests/coworkSessionItemCopyMenu.test.mjs
npm run build
```

Expected: PASS.

- [ ] **Step 7: Commit sidebar copy UI**

```bash
git add -f src/renderer/components/cowork/coworkSessionLink.js src/renderer/components/cowork/CoworkSessionItem.tsx src/renderer/services/i18n.ts tests/coworkSessionLink.test.mjs tests/coworkSessionItemCopyMenu.test.mjs
git commit -m "feat: copy cowork session links"
```

After the commit, publish a development journal with Codex's `metabot-post-buzz` skill describing the sidebar copy action and clipboard link format.

---

## Task 5: Final Verification

**Files:**
- No planned source edits.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
npm run compile:electron
node --test tests/coworkCrossSessionService.test.mjs tests/coworkCrossSessionRunner.test.mjs tests/runtimeDependencyContract.test.mjs
node --test tests/coworkSessionLink.test.mjs tests/coworkSessionItemCopyMenu.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 3: Run lint if the build is green**

Run:

```bash
npm run lint
```

Expected: PASS. If lint fails on unrelated pre-existing files, capture exact output and inspect whether any failure comes from files changed by this plan.

- [ ] **Step 4: Manual acceptance in Electron**

Run:

```bash
npm run electron:dev
```

Use the app to verify:

1. Cowork and A2A sidebar rows both show `复制Session ID` in the three-dot menu.
2. Clicking the item copies `IDBots://{cowork_sessions.id}`.
3. Cowork A can read Cowork B's all messages with `IDBots://...`.
4. Cowork A can read Cowork B's latest message.
5. Cowork A can write into Cowork B, and Cowork B automatically continues.
6. If Cowork B is running, two writes from Cowork A are processed in order after the current run.
7. Cowork A can read an A2A session.
8. Cowork A cannot write into an A2A session and receives `WRITE_NOT_ALLOWED_FOR_A2A`.

- [ ] **Step 5: Report final status**

Before final handoff, report:

```text
Implemented commits:
- <commit> feat: add cross-session service
- <commit> feat: add cross-session runner tools
- <commit> feat: mirror cross-session tools in sandbox
- <commit> feat: copy cowork session links

Verification:
- npm run compile:electron
- node --test ...
- npm run build
- npm run lint
- manual Electron acceptance

Known remaining state:
- unrelated pre-existing METAAPPs/metaapps.config.json remains untouched
```

---

## Execution Notes

- Do not create or switch branches in the main working directory.
- Ask for explicit user confirmation before creating a branch or worktree.
- If a branch is created for implementation, create it together with a dedicated local worktree and branch directly from `main`.
- Keep every edit inside `/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots`.
- Stage and commit only files touched by the current task.
- After every commit, publish a detailed development journal with Codex's `metabot-post-buzz` skill.
- Do not push unless the user explicitly asks.
- Leave existing unrelated `METAAPPs/metaapps.config.json` changes untouched.
