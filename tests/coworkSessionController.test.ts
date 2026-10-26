import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  CoworkMessage,
  CoworkPermissionResult,
  CoworkSession,
  CoworkSessionStatus,
  CoworkStartOptions,
  CoworkSubmitInput,
} from '../src/renderer/types/cowork';
import {
  CoworkSessionController,
  MOBILE_OPEN_SESSION_STORAGE_KEY,
  type CoworkRecoveryStorage,
  type PendingPermissionEntry,
} from '../src/renderer/services/coworkSessionController';

type Listener = (payload: unknown) => void;

function message(
  id: string,
  type: CoworkMessage['type'],
  content: string,
  metadata?: CoworkMessage['metadata'],
): CoworkMessage {
  return { id, type, content, timestamp: 1, ...(metadata ? { metadata } : {}) };
}

function session(
  id: string,
  status: CoworkSessionStatus = 'running',
  messages: CoworkMessage[] = [],
): CoworkSession {
  return {
    id,
    title: id === 'started' ? 'Started session' : 'Existing session',
    claudeSessionId: null,
    status,
    pinned: false,
    cwd: '/data/workspace',
    systemPrompt: '',
    executionMode: 'local',
    activeSkillIds: [],
    messages,
    createdAt: 1,
    updatedAt: 1,
    metabotId: 1,
  };
}

function makeHarness() {
  const listeners = new Map<string, Listener>();
  let current = session('s1');
  const harness = {
    startOptions: null as CoworkStartOptions | null,
    submitCalls: [] as CoworkSubmitInput[],
    permissionResults: [] as CoworkPermissionResult[],
    pending: [] as PendingPermissionEntry[],
    submitHandler: null as ((input: CoworkSubmitInput) => Promise<unknown>) | null,
    getSessionHandler: null as (() => Promise<unknown>) | null,
    get session() { return current; },
    set session(value: CoworkSession) { current = value; },
    emit(name: string, payload: unknown) { listeners.get(name)?.(payload); },
  };
  const on = (name: string) => (listener: Listener) => {
    listeners.set(name, listener);
    return () => listeners.delete(name);
  };
  const electron = {
    cowork: {
      onStreamMessage: on('message'),
      onStreamMessageUpdate: on('update'),
      onStreamPermission: on('permission'),
      onStreamPermissionResolved: on('permissionResolved'),
      onStreamComplete: on('complete'),
      onStreamError: on('error'),
      onStreamSessionTitle: on('title'),
      startSession: async (options: CoworkStartOptions) => {
        harness.startOptions = options;
        current = session('started', 'running', [message('u1', 'user', options.prompt)]);
        const live = message('a1', 'assistant', 'synchronous live', { isStreaming: true });
        current.messages.push(live);
        harness.emit('message', { sessionId: current.id, message: live });
        return { success: true, session: structuredClone(current) };
      },
      submitInput: async (input: CoworkSubmitInput) => {
        harness.submitCalls.push(input);
        if (harness.submitHandler) return harness.submitHandler(input);
        const persisted = message(`server-${harness.submitCalls.length}`, 'user', input.text, {
          submissionId: input.submissionId,
        });
        current.messages.push(persisted);
        return { success: true, mode: 'steer', message: persisted };
      },
      getSession: async () => {
        if (harness.getSessionHandler) return harness.getSessionHandler();
        return { success: true, session: structuredClone(current) };
      },
      listSessions: async () => ({ success: true, sessions: [structuredClone(current)] }),
      getSessionMessagesPage: async () => ({
        success: true,
        page: { messages: [], hasMoreBefore: false, beforeSequence: null },
      }),
      getStreamLiveContent: async ({ messageId }: { messageId: string }) => ({
        success: true,
        content: current.messages.find((entry) => entry.id === messageId)?.content ?? '',
      }),
      stopSession: async () => {
        current.status = 'idle';
        return { success: true };
      },
      respondToPermission: async ({ result }: { result: CoworkPermissionResult }) => {
        harness.permissionResults.push(result);
        return { success: true };
      },
      getConfig: async () => ({ success: true, config: { workingDirectory: '/data/workspace', systemPrompt: '' } }),
    },
    mobile: {
      listPendingPermissions: async () => harness.pending,
    },
  };
  return { harness, electron };
}

function controllerFor(
  electron: unknown,
  storage?: CoworkRecoveryStorage,
): CoworkSessionController {
  return new CoworkSessionController({
    electron: electron as never,
    storage,
    now: () => 100,
    createSubmissionId: () => '11111111-1111-4111-8111-111111111111',
  });
}

describe('cowork session controller', () => {
  it('preserves stream events emitted synchronously before start resolves', async (t) => {
    const { harness, electron } = makeHarness();
    const controller = controllerFor(electron);
    t.after(() => controller.destroy());

    const result = await controller.send('start work', { metabotId: 1, title: 'Start work' });
    assert.equal(result.status, 'accepted');
    assert.equal(harness.startOptions?.metabotId, 1);
    const state = controller.getSnapshot().states.get('started');
    assert.ok(state?.messages.some((entry) => entry.id === 'a1' && entry.content === 'synchronous live'));
    assert.equal(controller.getSnapshot().currentSessionId, 'started');
  });

  it('keeps background messages, completion, and permissions out of the open session', async (t) => {
    const { harness, electron } = makeHarness();
    const controller = controllerFor(electron);
    t.after(() => controller.destroy());
    await controller.openSession('s1');
    harness.emit('message', { sessionId: 's1', message: message('u1', 'user', 'keep running') });
    harness.emit('message', { sessionId: 'bg', message: message('bg-text', 'assistant', 'BACKGROUND') });
    harness.emit('complete', { sessionId: 'bg' });
    harness.emit('permission', {
      sessionId: 'bg',
      request: { sessionId: 'bg', requestId: 'bg-request', toolName: 'Bash', toolInput: {} },
    });

    const visible = controller.getSnapshot().states.get('s1')!;
    assert.equal(visible.status, 'running');
    assert.equal(visible.pendingPermissions.length, 0);
    assert.ok(!visible.messages.some((entry) => entry.id === 'bg-text'));
    const background = controller.getSnapshot().states.get('bg')!;
    assert.equal(background.status, 'completed');
    assert.equal(background.pendingPermissions.length, 1);
    assert.equal(background.unread, true);
  });

  it('rejects a snapshot that was requested before newer stream content arrived', async (t) => {
    const { harness, electron } = makeHarness();
    const controller = controllerFor(electron);
    t.after(() => controller.destroy());
    await controller.openSession('s1');
    const live = message('a1', 'assistant', 'partial', { isStreaming: true });
    harness.session.messages = [live];
    harness.emit('message', { sessionId: 's1', message: live });

    let release!: () => void;
    harness.getSessionHandler = () => new Promise((resolve) => {
      release = () => resolve({ success: true, session: structuredClone(harness.session) });
    });
    const refreshing = controller.refreshSession('s1');
    harness.emit('update', { sessionId: 's1', messageId: 'a1', content: 'newer text' });
    release();
    await refreshing;
    assert.equal(controller.getSnapshot().states.get('s1')?.messages[0]?.content, 'newer text');
  });

  it('uses the same UUID for an existing-session retry and settles only after acceptance', async (t) => {
    const { harness, electron } = makeHarness();
    const controller = controllerFor(electron);
    t.after(() => controller.destroy());
    await controller.openSession('s1');
    let calls = 0;
    harness.submitHandler = async (input) => {
      calls += 1;
      if (calls === 1) throw new Error('connection lost');
      const persisted = message('server-retry', 'user', input.text, { submissionId: input.submissionId });
      harness.session.messages.push(persisted);
      return { success: true, mode: 'steer', message: persisted };
    };

    const first = await controller.send('repeat', { metabotId: 1, title: 'Retry' });
    assert.equal(first.status, 'uncertain');
    const second = await controller.retrySubmission(first.submissionId!);
    assert.equal(second.status, 'accepted');
    assert.equal(harness.submitCalls.length, 2);
    assert.equal(harness.submitCalls[0]?.submissionId, harness.submitCalls[1]?.submissionId);
    assert.equal(controller.getSnapshot().attempts.length, 0);
  });

  it('does not turn an accepted stop into a settled UI when authoritative refresh fails', async (t) => {
    const { harness, electron } = makeHarness();
    const controller = controllerFor(electron);
    t.after(() => controller.destroy());
    await controller.openSession('s1');
    harness.getSessionHandler = async () => { throw new Error('refresh unavailable'); };

    const result = await controller.stop();
    assert.equal(result.status, 'uncertain');
    assert.ok(result.refreshError);
    assert.equal(controller.getSnapshot().states.get('s1')?.status, 'running');
    assert.equal(controller.getSnapshot().stoppingSessionIds.size, 0);
  });

  it('passes the exact permission result and removes remote resolutions without an invented outcome', async (t) => {
    const { harness, electron } = makeHarness();
    const controller = controllerFor(electron);
    t.after(() => controller.destroy());
    await controller.openSession('s1');
    const request = {
      sessionId: 's1', requestId: 'r1', toolName: 'AskUserQuestion',
      toolInput: { questions: [{ question: 'Pick', options: [{ label: 'A' }] }] },
    };
    harness.emit('permission', { sessionId: 's1', request });
    const result: CoworkPermissionResult = {
      behavior: 'allow',
      updatedInput: { ...request.toolInput, answers: { Pick: 'A' } },
    };
    const answered = await controller.respondPermission('r1', result);
    assert.equal(answered.status, 'accepted');
    assert.deepEqual(harness.permissionResults, [result]);
    assert.equal(controller.getSnapshot().states.get('s1')?.pendingPermissions.length, 0);

    harness.emit('permission', { sessionId: 's1', request: { ...request, requestId: 'r2' } });
    harness.emit('permissionResolved', { sessionId: 's1', requestId: 'r2' });
    const state = controller.getSnapshot().states.get('s1')!;
    assert.equal(state.pendingPermissions.length, 0);
    assert.equal('resolved' in state, false);
  });

  it('restores the saved running session and recovers its active stream metadata', async (t) => {
    const { harness, electron } = makeHarness();
    harness.session = session('s1', 'running', [message('a1', 'assistant', 'partial', { isStreaming: true })]);
    const values = new Map<string, string>([[MOBILE_OPEN_SESSION_STORAGE_KEY, 's1']]);
    const storage: CoworkRecoveryStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
    };
    const controller = controllerFor(electron, storage);
    t.after(() => controller.destroy());

    await controller.restore(1);
    assert.equal(controller.getSnapshot().currentSessionId, 's1');
    assert.equal(controller.getSnapshot().states.get('s1')?.status, 'running');
    assert.deepEqual(controller.getStreamingMessage(), { sessionId: 's1', messageId: 'a1' });
    controller.setDraft('preserved draft');
    assert.equal(controller.getDraft(), 'preserved draft');
  });
});
