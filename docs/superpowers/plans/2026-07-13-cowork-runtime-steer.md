# Co-Worker Runtime Steer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users send ordered, text-only corrective guidance into one running local Co-Worker SDK query without cancelling tools or starting a second runner.

**Architecture:** A dedicated pushable `AsyncIterable<SDKUserMessage>` owns live input delivery. A main-process submission controller persists each UUID-keyed user message, atomically chooses live steer or ordinary continuation, and reports the actual mode to the renderer. The existing System Prompt remains fixed for each query; steer text receives only a transient user-message envelope.

**Tech Stack:** Electron IPC, React 18, Redux Toolkit, TypeScript, Node `node:test`, sql.js SQLite, `@anthropic-ai/claude-agent-sdk` 0.2.12.

---

## File Map

- Create `src/main/libs/coworkSteerChannel.ts`: pushable SDK user-message channel, delivery acknowledgement, FIFO, close, and abort.
- Create `src/main/services/coworkTurnSubmission.ts`: idempotent persistence and atomic steer-versus-continue routing.
- Modify `src/main/libs/coworkRunner.ts`: own one live channel/query, accept steer, settle inputs from SDK result events, expose turn settlement, and close on Stop.
- Modify `src/main/coworkStore.ts`: insert a Cowork message with a caller-supplied UUID and recover unresolved steer metadata.
- Modify `src/main/main.ts`: wire the submission controller and one `cowork:session:submitInput` IPC handler.
- Modify `src/main/preload.ts`: expose typed `submitInput` to the renderer.
- Modify `src/renderer/types/cowork.ts`: define steer request, result, metadata, and delivery status.
- Modify `src/renderer/types/electron.d.ts`: mirror the Electron boundary contract.
- Modify `src/renderer/services/cowork.ts`: submit input, apply returned mode, and keep failed steer state visible.
- Modify `src/renderer/components/cowork/CoworkPromptInput.tsx`: enable text while streaming and derive Stop versus Send Steer from text presence.
- Modify `src/renderer/components/cowork/CoworkView.tsx`: replace renderer-side continue guessing with unified submission.
- Modify `src/renderer/components/cowork/CoworkSessionDetail.tsx`: show steer labels/status and local-only capability copy.
- Modify `src/renderer/services/i18n.ts`: add Chinese and English UI strings.
- Create focused tests under `tests/` for every boundary below.

## Task 1: Pushable SDK Input Channel

**Files:**
- Create: `tests/coworkSteerChannel.test.mjs`
- Create: `src/main/libs/coworkSteerChannel.ts`

- [ ] **Step 1: Write the failing FIFO and delivery tests**

Create `tests/coworkSteerChannel.test.mjs` with these cases:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CoworkSteerChannel,
  buildCoworkSteerSdkMessage,
} from '../dist-electron/main/libs/coworkSteerChannel.js';

test('delivers SDK user messages in FIFO order and acknowledges after consumer progress', async () => {
  const channel = new CoworkSteerChannel();
  const first = channel.enqueue(buildCoworkSteerSdkMessage('first'));
  const second = channel.enqueue(buildCoworkSteerSdkMessage('second'));
  const iterator = channel[Symbol.asyncIterator]();

  assert.equal((await iterator.next()).value.message.content[0].text.includes('first'), true);
  const nextPromise = iterator.next();
  await first.delivered;
  assert.equal((await nextPromise).value.message.content[0].text.includes('second'), true);

  channel.close();
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  await second.delivered;
});

test('abort rejects queued delivery and ends the iterator', async () => {
  const channel = new CoworkSteerChannel();
  const queued = channel.enqueue(buildCoworkSteerSdkMessage('never delivered'));
  channel.abort(new Error('stopped'));

  await assert.rejects(queued.delivered, /stopped/);
  await assert.rejects(channel[Symbol.asyncIterator]().next(), /stopped/);
});

test('runtime envelope does not alter the visible user text', () => {
  const message = buildCoworkSteerSdkMessage('只修改查询逻辑');
  const runtimeText = message.message.content[0].text;
  assert.match(runtimeText, /<operator_steer>/);
  assert.match(runtimeText, /只修改查询逻辑/);
  assert.match(runtimeText, /earliest safe boundary/i);
});
```

- [ ] **Step 2: Run the test and verify the module is missing**

Run:

```bash
npm run compile:electron && node --test tests/coworkSteerChannel.test.mjs
```

Expected: FAIL because `coworkSteerChannel.js` does not exist.

- [ ] **Step 3: Implement the channel and runtime-only envelope**

Create `src/main/libs/coworkSteerChannel.ts` with these public contracts:

```ts
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

type PendingInput = {
  message: SDKUserMessage;
  resolve: () => void;
  reject: (error: Error) => void;
};

export type CoworkSteerEnqueueResult = {
  delivered: Promise<void>;
};

export function buildCoworkSdkUserMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    session_id: '',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

export function buildCoworkSteerSdkMessage(text: string): SDKUserMessage {
  const escaped = text.trim();
  return buildCoworkSdkUserMessage([
    '<operator_steer>',
    'This is a new correction from the human user for the task currently in progress.',
    'Incorporate it at the earliest safe boundary. Preserve completed work that remains valid,',
    'and adjust pending plans and future actions. Do not claim an in-flight side effect was rolled back.',
    '',
    escaped,
    '</operator_steer>',
  ].join('\n'));
}
```

Implement `CoworkSteerChannel implements AsyncIterable<SDKUserMessage>` with `enqueue`, `close`, `abort`, `isOpen`, `acceptedCount`, and `deliveredCount`. Its iterator must acknowledge the previously yielded item when the SDK requests the next item; SDK 0.2.12 requests the next item only after awaiting its transport write.

- [ ] **Step 4: Run the focused test**

Run:

```bash
npm run compile:electron && node --test tests/coworkSteerChannel.test.mjs
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit the channel**

```bash
git add src/main/libs/coworkSteerChannel.ts tests/coworkSteerChannel.test.mjs
git commit -m "feat: add cowork steer input channel"
```

After the commit, use the Codex `metabot-post-buzz` skill to publish a development journal describing the FIFO channel, SDK transport acknowledgement, tests, and commit hash. Do not push.

## Task 2: Idempotent Steer Persistence

**Files:**
- Modify: `src/main/coworkStore.ts` near `CoworkMessageMetadata` and `addMessage()`
- Modify: `src/renderer/types/cowork.ts` near `CoworkMessageMetadata`
- Create: `tests/coworkSteerPersistence.test.mjs`

- [ ] **Step 1: Write failing persistence tests**

Add tests which create a temporary sql.js database through the same store construction pattern used by existing CoworkStore tests:

```js
test('addMessageWithId is idempotent for one steer submission UUID', () => {
  const store = createTestCoworkStore();
  const session = store.createSession('steer', process.cwd());
  const id = '11111111-1111-4111-8111-111111111111';
  const input = {
    type: 'user',
    content: 'only change the query',
    metadata: { interactionKind: 'steer', steerStatus: 'queued', submissionId: id },
  };

  const first = store.addMessageWithId(session.id, id, input);
  const second = store.addMessageWithId(session.id, id, input);

  assert.equal(first.id, id);
  assert.equal(second.id, id);
  assert.equal(store.getSession(session.id).messages.filter((item) => item.id === id).length, 1);
});

test('updates steer delivery metadata without changing visible content', () => {
  const store = createTestCoworkStore();
  const session = store.createSession('steer', process.cwd());
  const message = store.addMessageWithId(session.id, crypto.randomUUID(), {
    type: 'user',
    content: 'keep this raw',
    metadata: { interactionKind: 'steer', steerStatus: 'queued' },
  });
  store.updateMessage(session.id, message.id, {
    metadata: { ...message.metadata, steerStatus: 'delivered', steerDeliveredAt: 123 },
  });
  const updated = store.getMessageById(session.id, message.id);
  assert.equal(updated.content, 'keep this raw');
  assert.equal(updated.metadata.steerStatus, 'delivered');
});
```

- [ ] **Step 2: Verify failure**

Run:

```bash
npm run compile:electron && node --test tests/coworkSteerPersistence.test.mjs
```

Expected: FAIL because `addMessageWithId` and `getMessageById` are missing.

- [ ] **Step 3: Add shared steer metadata types**

Add the same explicit fields to main and renderer metadata types:

```ts
export type CoworkSteerStatus = 'queued' | 'delivered' | 'settled' | 'failed' | 'cancelled';

export interface CoworkMessageMetadata {
  interactionKind?: 'steer';
  submissionId?: string;
  submissionMode?: 'steer' | 'continue';
  steerStatus?: CoworkSteerStatus;
  steerDeliveredAt?: number;
  steerSettledAt?: number;
  steerFailedAt?: number;
  steerErrorCode?: string;
  // existing fields remain unchanged
}
```

- [ ] **Step 4: Implement caller-supplied IDs without a migration**

Refactor store insertion into:

```ts
addMessage(sessionId: string, message: Omit<CoworkMessage, 'id' | 'timestamp'>): CoworkMessage {
  return this.addMessageWithId(sessionId, uuidv4(), message);
}

addMessageWithId(
  sessionId: string,
  id: string,
  message: Omit<CoworkMessage, 'id' | 'timestamp'>
): CoworkMessage {
  const existing = this.getMessageById(sessionId, id);
  if (existing) return existing;
  const now = Date.now();
  const result = this.db.exec(
    'SELECT COALESCE(MAX(sequence), 0) + 1 FROM cowork_messages WHERE session_id = ?',
    [sessionId]
  );
  const sequence = Number(result[0]?.values[0]?.[0] ?? 1);
  this.db.run(
    `INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, sessionId, message.type, message.content,
      message.metadata ? JSON.stringify(message.metadata) : null, now, sequence]
  );
  this.db.run('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?', [now, sessionId]);
  this.saveDb();
  const created = { ...message, id, timestamp: now } as CoworkMessage;
  this.enqueueExplicitMemoryUpdate(sessionId, created);
  return created;
}

getMessageById(sessionId: string, messageId: string): CoworkMessage | null {
  const result = this.db.exec(
    `SELECT id, type, content, metadata, created_at
     FROM cowork_messages WHERE session_id = ? AND id = ? LIMIT 1`,
    [sessionId, messageId]
  );
  const row = result[0]?.values[0];
  if (!row) return null;
  return {
    id: String(row[0]),
    type: String(row[1]) as CoworkMessage['type'],
    content: String(row[2] ?? ''),
    metadata: row[3] ? JSON.parse(String(row[3])) as CoworkMessageMetadata : undefined,
    timestamp: Number(row[4]),
  };
}
```

No table, column, index, or default changes are allowed in this task.

- [ ] **Step 5: Run persistence and existing store tests**

Run:

```bash
npm run compile:electron && node --test tests/coworkSteerPersistence.test.mjs tests/serviceOrderStore.test.mjs
```

Expected: all selected tests pass and the second UUID insertion creates no duplicate.

- [ ] **Step 6: Commit persistence**

```bash
git add src/main/coworkStore.ts src/renderer/types/cowork.ts tests/coworkSteerPersistence.test.mjs
git commit -m "feat: persist cowork steer delivery state"
```

Post the required detailed development-journal buzz with the Codex skill. Mention that no SQLite migration was introduced. Do not push.

## Task 3: One-Query CoworkRunner Integration

**Files:**
- Modify: `src/main/libs/coworkRunner.ts` at `ActiveSession`, `startSession`, `continueSession`, `runClaudeCodeLocal`, and `stopSession`
- Create: `tests/coworkRunnerSteer.test.mjs`

- [ ] **Step 1: Write the failing runner contract tests**

Build a fake SDK query that consumes the supplied async iterable, records user messages, emits one `result` for each consumed input, and stays open until the channel closes. Assert:

```js
test('initial input and steer share one SDK query', async () => {
  const { runner, sdk, sessionId } = createRunnerHarness();
  const run = runner.startSession(sessionId, 'initial task');
  await sdk.waitForInputCount(1);

  const steer = runner.trySubmitSteer(sessionId, 'steer-1', 'change direction');
  assert.equal(steer.accepted, true);
  await steer.delivered;
  await sdk.waitForInputCount(2);
  sdk.finishAllResults();
  await run;

  assert.equal(sdk.queryCalls, 1);
  assert.match(sdk.inputs[0], /initial task/);
  assert.match(sdk.inputs[1], /<operator_steer>/);
  assert.match(sdk.inputs[1], /change direction/);
});

test('continueSession refuses to start a concurrent runner while live input is open', async () => {
  const { runner, sdk, sessionId } = createRunnerHarness();
  const run = runner.startSession(sessionId, 'initial task');
  await sdk.waitForInputCount(1);
  await assert.rejects(runner.continueSession(sessionId, 'unsafe second run'), /active local turn/i);
  runner.stopSession(sessionId);
  await run;
});

test('stop aborts the live channel and query', async () => {
  const { runner, sdk, sessionId } = createRunnerHarness();
  const run = runner.startSession(sessionId, 'initial task');
  await sdk.waitForInputCount(1);
  runner.stopSession(sessionId);
  await run;
  assert.equal(sdk.abortObserved, true);
});
```

The harness may add a `loadClaudeSdk` dependency to `CoworkRunnerOptions`; production defaults to the existing `loadClaudeSdk` function.

- [ ] **Step 2: Verify failure**

Run:

```bash
npm run compile:electron && node --test tests/coworkRunnerSteer.test.mjs
```

Expected: FAIL because the runner has no live channel or `trySubmitSteer` method.

- [ ] **Step 3: Extend ActiveSession with explicit local-turn state**

Add these fields:

```ts
localInputChannel?: CoworkSteerChannel;
localAcceptedInputs: number;
localSettledInputs: number;
localPendingSteerIds: string[];
localTurnState: 'none' | 'open' | 'closing';
turnSettled: Promise<void>;
resolveTurnSettled: () => void;
```

Initialize the deferred settlement promise once when `ActiveSession` is created. Resolve it exactly once from the same cleanup path that removes the active session.

- [ ] **Step 4: Start local SDK queries in streaming-input mode**

In `runClaudeCodeLocal`, replace the string query prompt with a channel for the top-level local run:

```ts
const channel = new CoworkSteerChannel();
activeSession.localInputChannel = channel;
activeSession.localTurnState = 'open';
const initial = channel.enqueue(buildCoworkSdkUserMessage(promptForQuery));
activeSession.localAcceptedInputs = channel.acceptedCount;

const result = await query({ prompt: channel, options } as any);
await initial.delivered;
for await (const event of result as AsyncIterable<unknown>) {
  if (this.isSessionStopRequested(sessionId, activeSession)) break;
  this.handleClaudeEvent(sessionId, event);
  if (isSdkResultEvent(event)) {
    activeSession.localSettledInputs += 1;
    if (activeSession.localSettledInputs > 1) {
      const settledSubmissionId = activeSession.localPendingSteerIds.shift();
      if (settledSubmissionId) this.emit('steerSettled', sessionId, settledSubmissionId);
    }
    if (
      activeSession.localSettledInputs >= channel.acceptedCount
      && channel.deliveredCount >= channel.acceptedCount
    ) {
      activeSession.localTurnState = 'closing';
      channel.close();
    }
  }
}
```

Use a small exported `isSdkResultEvent()` type guard so the test does not reproduce event-shape guessing.

- [ ] **Step 5: Add synchronous steer admission**

Add:

```ts
trySubmitSteer(
  sessionId: string,
  submissionId: string,
  text: string
): { accepted: true; delivered: Promise<void> } | { accepted: false; reason: 'inactive' | 'closing' | 'sandbox' } {
  const active = this.activeSessions.get(sessionId);
  if (!active) return { accepted: false, reason: 'inactive' };
  if (active.executionMode !== 'local') return { accepted: false, reason: 'sandbox' };
  if (!active.localInputChannel?.isOpen || active.localTurnState !== 'open') {
    return { accepted: false, reason: 'closing' };
  }
  const queued = active.localInputChannel.enqueue(buildCoworkSteerSdkMessage(text));
  active.localPendingSteerIds.push(submissionId);
  active.localAcceptedInputs = active.localInputChannel.acceptedCount;
  return { accepted: true, delivered: queued.delivered };
}
```

Also add:

```ts
getSteerCapability(sessionId: string): 'open-local' | 'closing-local' | 'sandbox' | 'inactive' {
  const active = this.activeSessions.get(sessionId);
  if (!active) return 'inactive';
  if (active.executionMode !== 'local') return 'sandbox';
  return active.localTurnState === 'open' && active.localInputChannel?.isOpen
    ? 'open-local'
    : 'closing-local';
}
```

Add `waitForActiveTurnSettlement(sessionId)` which returns the current deferred promise or an already-resolved promise. Extend `CoworkRunnerEvents` with `steerSettled(sessionId, submissionId)` and cover FIFO settlement order in the fake-SDK test.

- [ ] **Step 6: Make Stop and cleanup close both controls**

Before aborting the existing controller in `stopSession`, call:

```ts
activeSession.localTurnState = 'closing';
activeSession.localInputChannel?.abort(new Error('Cowork session stopped'));
activeSession.abortController.abort();
```

The normal `finally` path resolves `turnSettled`; it must not leave a rejected delivery promise unobserved.

- [ ] **Step 7: Run focused and existing runner tests**

Run:

```bash
npm run compile:electron && node --test tests/coworkSteerChannel.test.mjs tests/coworkRunnerSteer.test.mjs tests/coworkCrossSessionRunner.test.mjs tests/privateChatScopedMemory.test.mjs
```

Expected: all selected tests pass; the fake SDK reports one query call.

- [ ] **Step 8: Commit runner integration**

```bash
git add src/main/libs/coworkRunner.ts tests/coworkRunnerSteer.test.mjs
git commit -m "feat: stream steer into active cowork query"
```

Post the required buzz describing the one-query invariant, Stop behavior, result accounting, and test evidence. Do not push.

## Task 4: Atomic Turn Submission Controller

**Files:**
- Create: `src/main/services/coworkTurnSubmission.ts`
- Create: `tests/coworkTurnSubmission.test.mjs`
- Modify: `src/main/libs/coworkRunner.ts` only if the tests require a narrower public settlement method

- [ ] **Step 1: Write failing controller tests**

Cover live steer, inactive continue, completion race, duplicate UUID, A2A rejection, and sandbox rejection:

```js
test('persists once and submits live steer', async () => {
  const harness = createSubmissionHarness({ runnerMode: 'open-local' });
  const input = { sessionId: harness.sessionId, submissionId: crypto.randomUUID(), text: 'steer now' };
  const result = await harness.controller.submit(input);
  assert.equal(result.mode, 'steer');
  assert.equal(harness.runner.steerCalls.length, 1);
  assert.equal(harness.store.getSession(harness.sessionId).messages.at(-1).metadata.steerStatus, 'delivered');
});

test('waits for a closing turn then continues exactly once', async () => {
  const harness = createSubmissionHarness({ runnerMode: 'closing-local' });
  const submissionId = crypto.randomUUID();
  const pending = harness.controller.submit({ sessionId: harness.sessionId, submissionId, text: 'next direction' });
  harness.runner.settleCurrentTurn();
  const result = await pending;
  assert.equal(result.mode, 'continue');
  assert.equal(harness.runner.continueCalls.length, 1);
  assert.equal(harness.store.getSession(harness.sessionId).messages.filter((m) => m.id === submissionId).length, 1);
});

test('repeating a submission UUID does not duplicate execution', async () => {
  const harness = createSubmissionHarness({ runnerMode: 'open-local' });
  const request = { sessionId: harness.sessionId, submissionId: crypto.randomUUID(), text: 'once' };
  const first = await harness.controller.submit(request);
  const second = await harness.controller.submit(request);
  assert.deepEqual(second, first);
  assert.equal(harness.runner.steerCalls.length, 1);
});
```

- [ ] **Step 2: Verify failure**

Run:

```bash
npm run compile:electron && node --test tests/coworkTurnSubmission.test.mjs
```

Expected: FAIL because `coworkTurnSubmission.js` is missing.

- [ ] **Step 3: Define the controller contract**

```ts
export type CoworkSubmitInput = {
  sessionId: string;
  submissionId: string;
  text: string;
  systemPrompt?: string;
  activeSkillIds?: string[];
};

export type CoworkSubmitInputResult = {
  success: true;
  mode: 'steer' | 'continue';
  message: CoworkMessage;
} | {
  success: false;
  error: string;
  code: 'invalid_input' | 'session_not_found' | 'unsupported_session' | 'unsupported_execution' | 'delivery_failed';
};
```

The controller receives store, runner, `emitMessage`, and `emitMessageUpdate` dependencies. It trims but does not otherwise rewrite visible text. Optional System Prompt and skill fields are used only when the authoritative result is an ordinary continuation; a live steer never mutates the running query configuration.

- [ ] **Step 4: Implement the atomic decision**

The implementation order is:

```ts
const existing = store.getMessageById(sessionId, submissionId);
if (existing && completedSubmission(existing)) return resultFromExisting(existing);
validateStandardSession(session);

const capability = runner.getSteerCapability(sessionId);
if (capability === 'sandbox') {
  return { success: false, code: 'unsupported_execution', error: 'Runtime steer currently supports local execution only' };
}

const interactionKind = capability === 'open-local' || capability === 'closing-local'
  ? 'steer'
  : undefined;
const message = existing ?? store.addMessageWithId(sessionId, submissionId, {
  type: 'user',
  content: text,
  metadata: interactionKind
    ? { interactionKind, submissionId, steerStatus: 'queued' }
    : { submissionId, submissionMode: 'continue' },
});
if (!existing) emitMessage(sessionId, message);

if (capability === 'open-local') {
  const admission = runner.trySubmitSteer(sessionId, submissionId, text);
  if (!admission.accepted) {
    await runner.waitForActiveTurnSettlement(sessionId);
  } else {
    await admission.delivered;
    return markDeliveredAndReturnSteer(message);
  }
}
if (capability === 'closing-local') {
  await runner.waitForActiveTurnSettlement(sessionId);
}

await runner.continueSession(sessionId, text, {
  skipUserMessage: true,
  systemPrompt,
  skillIds: activeSkillIds,
});
return markAsOrdinaryContinueAndReturn(message);
```

`getSteerCapability()` and `trySubmitSteer()` are synchronous; no event-loop yield occurs between capability check, SQLite persistence, and enqueue. Before fallback Continue, re-read the session and reject deleted/A2A sessions. Record `submissionMode: 'steer' | 'continue'` plus the final result in metadata so a duplicate UUID returns without a second execution. A non-running sandbox session remains valid for an ordinary continuation; only an active sandbox turn rejects runtime steer.

- [ ] **Step 5: Run controller and persistence tests**

Run:

```bash
npm run compile:electron && node --test tests/coworkTurnSubmission.test.mjs tests/coworkSteerPersistence.test.mjs tests/coworkRunnerSteer.test.mjs
```

Expected: all selected tests pass.

- [ ] **Step 6: Commit the controller**

```bash
git add src/main/services/coworkTurnSubmission.ts src/main/libs/coworkRunner.ts tests/coworkTurnSubmission.test.mjs
git commit -m "feat: route cowork input atomically"
```

Post the required development-journal buzz with completion-race and idempotency evidence. Do not push.

## Task 5: Typed IPC and Renderer Service

**Files:**
- Modify: `src/main/main.ts` near existing Cowork IPC handlers
- Modify: `src/main/preload.ts` in `window.electron.cowork`
- Modify: `src/renderer/types/cowork.ts`
- Modify: `src/renderer/types/electron.d.ts`
- Modify: `src/renderer/services/cowork.ts`
- Create: `tests/coworkSubmitInputIpc.test.mjs`

- [ ] **Step 1: Write the failing IPC contract test**

Use the repository's existing static IPC contract style to assert one consistent channel name and type surface:

```js
test('wires cowork submitInput across main, preload, types, and renderer service', () => {
  assert.match(mainSource, /ipcMain\.handle\('cowork:session:submitInput'/);
  assert.match(preloadSource, /submitInput:.*cowork:session:submitInput/s);
  assert.match(electronTypes, /submitInput\(input: CoworkSubmitInput\)/);
  assert.match(serviceSource, /async submitInput\(input: CoworkSubmitInput\)/);
});
```

Add behavior assertions with a mocked `window.electron.cowork.submitInput` for returned `steer`, returned `continue`, and failure.

- [ ] **Step 2: Verify failure**

Run:

```bash
node --test tests/coworkSubmitInputIpc.test.mjs
```

Expected: FAIL because no unified IPC exists.

- [ ] **Step 3: Add the IPC handler**

Register exactly one new main handler:

```ts
ipcMain.handle('cowork:session:submitInput', async (_event, input: CoworkSubmitInput) =>
  withSqliteRecovery('cowork:session:submitInput', async () =>
    getCoworkTurnSubmissionController().submit(input)
  )
);
```

Reuse the existing stream emitters when constructing the controller. Wire the runner settlement event to persisted metadata and the existing message-update stream:

```ts
function emitCoworkStreamMessageUpdate(
  sessionId: string,
  messageId: string,
  content: string,
  metadata: CoworkMessageMetadata
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('cowork:stream:messageUpdate', { sessionId, messageId, content, metadata });
    }
  }
}

coworkRunner.on('steerSettled', (sessionId: string, submissionId: string) => {
  const store = getCoworkStore();
  const message = store.getMessageById(sessionId, submissionId);
  if (!message || message.metadata?.interactionKind !== 'steer') return;
  const metadata = { ...message.metadata, steerStatus: 'settled', steerSettledAt: Date.now() };
  store.updateMessage(sessionId, submissionId, { metadata });
  emitCoworkStreamMessageUpdate(sessionId, submissionId, message.content, metadata);
});
```

Do not remove `cowork:session:continue`; IM, scheduler, and other internal callers still depend on it.

- [ ] **Step 4: Mirror the typed boundary**

Expose:

```ts
submitInput: (input: CoworkSubmitInput): Promise<CoworkSubmitInputResult> =>
  ipcRenderer.invoke('cowork:session:submitInput', input),
```

Mirror the exact request/result unions in `cowork.ts` and `electron.d.ts`; do not use `any` for this method.

- [ ] **Step 5: Add the renderer service method**

```ts
async submitInput(input: CoworkSubmitInput): Promise<CoworkSubmitInputResult> {
  const cowork = window.electron?.cowork;
  if (!cowork?.submitInput) {
    return { success: false, code: 'delivery_failed', error: 'Cowork submit API not available' };
  }
  const result = await cowork.submitInput(input);
  if (result.success) {
    store.dispatch(updateSessionStatus({ sessionId: input.sessionId, status: 'running' }));
  }
  return result;
}
```

The stream event remains the source of the persisted message; the renderer service must not optimistically insert a second copy.

- [ ] **Step 6: Run IPC tests and builds**

Run:

```bash
node --test tests/coworkSubmitInputIpc.test.mjs
npm run compile:electron
npm run build
```

Expected: IPC tests pass and both builds exit 0.

- [ ] **Step 7: Commit IPC wiring**

```bash
git add src/main/main.ts src/main/preload.ts src/renderer/types/cowork.ts src/renderer/types/electron.d.ts src/renderer/services/cowork.ts tests/coworkSubmitInputIpc.test.mjs
git commit -m "feat: expose cowork steer submission"
```

Post the required buzz describing the stable IPC contract and build evidence. Do not push.

## Task 6: Composer and Timeline UI

**Files:**
- Modify: `src/renderer/components/cowork/CoworkPromptInput.tsx`
- Modify: `src/renderer/components/cowork/CoworkView.tsx`
- Modify: `src/renderer/components/cowork/CoworkSessionDetail.tsx`
- Modify: `src/renderer/services/i18n.ts`
- Create: `tests/coworkSteerUi.test.mjs`

- [ ] **Step 1: Write failing UI behavior tests**

Following the current source-contract test style, assert:

```js
test('streaming composer sends text and stops only when empty', () => {
  assert.doesNotMatch(inputSource, /\|\| isStreaming \|\| disabled\) return/);
  assert.match(inputSource, /const hasTextInput = Boolean\(value\.trim\(\)\)/);
  assert.match(inputSource, /isStreaming && !hasTextInput/);
  assert.match(inputSource, /isStreaming && hasTextInput/);
});

test('running controls keep dynamic configuration disabled', () => {
  assert.match(inputSource, /disabled=\{disabled \|\| isStreaming\}/);
  assert.match(inputSource, /coworkSteerPlaceholder/);
});

test('CoworkView submits one UUID through unified submitInput', () => {
  assert.match(viewSource, /submissionId:\s*crypto\.randomUUID\(\)/);
  assert.match(viewSource, /coworkService\.submitInput/);
});

test('timeline labels visible steer states without claiming compliance', () => {
  assert.match(detailSource, /interactionKind.*steer/s);
  assert.match(i18nSource, /coworkSteerStatusDelivered/);
  assert.doesNotMatch(i18nSource, /MetaBot 已遵循|MetaBot followed/);
});
```

- [ ] **Step 2: Verify failure**

Run:

```bash
node --test tests/coworkSteerUi.test.mjs
```

Expected: FAIL on missing steer behavior and copy.

- [ ] **Step 3: Make submit eligibility text-aware**

In `CoworkPromptInput` derive:

```ts
const hasTextInput = Boolean(value.trim());
const isSteerSubmit = isStreaming && hasTextInput;
const showStopButton = isStreaming && !hasTextInput;
const canSubmit = !disabled && !isStreaming
  ? hasTextInput || attachments.length > 0
  : !disabled && isSteerSubmit;
```

Remove `isStreaming` from the textarea submit guard and Enter guard, but keep it on attachment, skill, model, folder, paste-file, and drop-file controls. When streaming, `handleSubmit` must ignore attachments and pass only trimmed text.

Render Stop only for `showStopButton`; otherwise render Send. Use an accessible label that distinguishes Send Steer while running.

- [ ] **Step 4: Route existing-session text through unified submit**

Replace the existing `handleContinueSession` body with:

```ts
const [submitError, setSubmitError] = useState<string | null>(null);

const handleContinueSession = async (prompt: string, skillPrompt?: string) => {
  if (!currentSession) return;
  const sessionSkillIds = isStreaming ? [] : [...activeSkillIds];
  const systemPrompt = isStreaming ? undefined : await buildCombinedSystemPrompt(skillPrompt);
  if (!isStreaming && sessionSkillIds.length > 0) dispatch(clearActiveSkills());
  const result = await coworkService.submitInput({
    sessionId: currentSession.id,
    submissionId: crypto.randomUUID(),
    text: prompt,
    systemPrompt,
    activeSkillIds: sessionSkillIds.length > 0 ? sessionSkillIds : undefined,
  });
  if (!result.success) {
    dispatch(setDraftPrompt(prompt));
    setSubmitError(i18nService.t(`coworkSubmitError.${result.code}`));
  }
};
```

Render `submitError` directly below the composer and clear it on success:

```tsx
{submitError && (
  <div className="mt-2 text-xs text-red-500 dark:text-red-400" role="alert">
    {submitError}
  </div>
)}
```

Do not build or send a new skill/System Prompt for the running-input path. Preserve current skill selection for ordinary non-running continuations. The main-process controller ignores optional configuration if renderer state was stale and the authoritative mode is live steer.

- [ ] **Step 5: Render steer label and verified status**

When `message.metadata?.interactionKind === 'steer'`, render a small localized label and map statuses:

```ts
const steerStatusKey = {
  queued: 'coworkSteerStatusQueued',
  delivered: 'coworkSteerStatusDelivered',
  failed: 'coworkSteerStatusFailed',
  cancelled: 'coworkSteerStatusCancelled',
}[String(message.metadata?.steerStatus)] ?? null;
```

Add Chinese and English strings for placeholder, Send Steer, local-only limitation, Waiting for delivery, Sent to MetaBot, Send failed, and Cancelled.

- [ ] **Step 6: Run UI tests and build**

Run:

```bash
node --test tests/coworkSteerUi.test.mjs tests/coworkSubmitInputIpc.test.mjs
npm run build
```

Expected: tests pass and Vite/TypeScript build exits 0.

- [ ] **Step 7: Commit the UI**

```bash
git add src/renderer/components/cowork/CoworkPromptInput.tsx src/renderer/components/cowork/CoworkView.tsx src/renderer/components/cowork/CoworkSessionDetail.tsx src/renderer/services/i18n.ts tests/coworkSteerUi.test.mjs
git commit -m "feat: add cowork runtime steer controls"
```

Post the required buzz with the composer state table, status vocabulary, and test evidence. Do not push.

## Task 7: Restart Recovery and Regression Hardening

**Files:**
- Modify: `src/main/coworkStore.ts`
- Modify: `src/main/main.ts` during CoworkStore initialization
- Modify: `src/main/services/coworkTurnSubmission.ts`
- Create: `tests/coworkSteerRecovery.test.mjs`

- [ ] **Step 1: Write failing recovery tests**

```js
test('startup marks unresolved steer as failed without replaying it', () => {
  const store = createStoreWithSteers(['queued', 'delivered', 'settled']);
  const changed = store.markInterruptedSteersAfterRestart(5000);
  assert.equal(changed, 2);
  assert.equal(store.getMessageById(sessionId, queuedId).metadata.steerStatus, 'failed');
  assert.equal(store.getMessageById(sessionId, deliveredId).metadata.steerErrorCode, 'app_restarted');
  assert.equal(store.getMessageById(sessionId, settledId).metadata.steerStatus, 'settled');
  assert.equal(fakeRunner.continueCalls.length, 0);
});

test('retry reuses the failed submission id and one timeline row', async () => {
  const harness = createFailedSteerHarness();
  const result = await harness.controller.submit({
    sessionId: harness.sessionId,
    submissionId: harness.failedMessageId,
    text: harness.failedText,
  });
  assert.equal(result.success, true);
  assert.equal(harness.store.getSession(harness.sessionId).messages.filter((m) => m.id === harness.failedMessageId).length, 1);
});
```

- [ ] **Step 2: Verify failure**

Run:

```bash
npm run compile:electron && node --test tests/coworkSteerRecovery.test.mjs
```

Expected: FAIL because restart recovery is missing.

- [ ] **Step 3: Implement non-replaying recovery**

Add a store transaction that selects user messages whose metadata has `interactionKind=steer` and `steerStatus` of `queued` or `delivered`, then updates metadata to:

```ts
{
  ...metadata,
  steerStatus: 'failed',
  steerFailedAt: now,
  steerErrorCode: 'app_restarted',
}
```

Call it once after CoworkStore construction. Emit no runner action and do not create a new turn.

- [ ] **Step 4: Allow explicit retry only for matching failed content**

In the submission controller, a duplicate UUID may retry when the existing message is failed and its `content` exactly equals the new trimmed text. Reject UUID reuse with different session or content as `invalid_input`.

- [ ] **Step 5: Run recovery and full focused suite**

Run:

```bash
npm run compile:electron && node --test \
  tests/coworkSteerChannel.test.mjs \
  tests/coworkSteerPersistence.test.mjs \
  tests/coworkRunnerSteer.test.mjs \
  tests/coworkTurnSubmission.test.mjs \
  tests/coworkSubmitInputIpc.test.mjs \
  tests/coworkSteerUi.test.mjs \
  tests/coworkSteerRecovery.test.mjs \
  tests/coworkCrossSessionRunner.test.mjs \
  tests/coworkSessionDetailA2AEndUi.test.mjs
```

Expected: all tests pass, with zero unhandled rejections.

- [ ] **Step 6: Commit recovery**

```bash
git add src/main/coworkStore.ts src/main/main.ts src/main/services/coworkTurnSubmission.ts tests/coworkSteerRecovery.test.mjs
git commit -m "fix: recover interrupted cowork steer safely"
```

Post the required buzz explaining non-replay safety, retry idempotency, and regression results. Do not push.

## Task 8: Full Verification and Acceptance

**Files:**
- Modify only if verification exposes a scoped defect; every such fix must receive its own test and commit.

- [ ] **Step 1: Run whitespace and repository checks**

```bash
git diff --check
git status --short --branch
```

Expected: no whitespace errors; only understood task changes are present.

- [ ] **Step 2: Run Electron compilation and production frontend build**

```bash
npm run compile:electron
npm run build
```

Expected: both commands exit 0.

- [ ] **Step 3: Run the complete focused steer suite**

Run the exact multi-file `node --test` command from Task 7 Step 5.

Expected: zero failures and zero cancelled tests.

- [ ] **Step 4: Run adjacent regression suites**

```bash
node --test \
  tests/privateChatScopedMemory.test.mjs \
  tests/coworkCrossSessionRunner.test.mjs \
  tests/coworkSessionDetailA2AEndUi.test.mjs \
  tests/imCoworkHandlerSessionReset.test.mjs \
  tests/runtimeDependencyContract.test.mjs
```

Expected: all selected tests pass.

- [ ] **Step 5: Perform local-mode manual acceptance**

Start the development app using the repository's Node 24 environment and `npm run electron:dev`. In one standard local Co-Worker session:

1. Ask the MetaBot to perform a multi-step task containing a harmless long-running read-only command.
2. While that tool is active, type a correction and verify Stop changes to Send Steer.
3. Send two more corrections quickly.
4. Verify all three timeline entries appear in order with delivery status.
5. Verify the in-flight tool was not cancelled.
6. Verify subsequent Agent actions reflect the ordered guidance.
7. Clear the composer and verify Stop still hard-terminates a separate test run.
8. Send at the exact end of a turn and verify one ordinary continuation appears.
9. Open a sandbox session and verify unsupported steer is not offered.

- [ ] **Step 6: Record final evidence**

Capture in the handoff:

- compile and build exit status;
- focused and adjacent test counts;
- one-query evidence from the fake SDK test;
- manual FIFO, tool-preservation, Stop, completion-race, and sandbox results;
- final `git status --short --branch`, branch inventory, and worktree inventory.

If verification required no code changes, do not create an empty commit. If it required a scoped fix, add a failing regression test, commit using an allowed `<type>: <description>` message, and post the required development-journal buzz. Never push without explicit user instruction.
