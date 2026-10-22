/**
 * Mobile mock bridge (REQ-E-8).
 *
 * Backs `window.electron` with fixtures and timers so the mobile app and its
 * test suite run without a tenant or gateway. Enabled by VITE_MOBILE_MOCK=1
 * through installMockBridge.ts; tests construct the bridge directly with
 * shrunk delays.
 *
 * The invoke surface mirrors `IElectronAPI` in
 * src/renderer/types/electron.d.ts and the event payloads mirror what the
 * desktop main process sends (consumed by
 * src/renderer/services/cowork.ts and
 * src/renderer/services/coworkStreamReassembly.ts):
 *
 *   - cowork.onStreamMessage        <- 'cowork:stream:message'      { sessionId, message }
 *   - cowork.onStreamMessageUpdate  <- 'cowork:stream:messageUpdate' { sessionId, messageId, content|delta+baseLength, metadata? }
 *   - cowork.onStreamPermission     <- 'cowork:stream:permission'    { sessionId, request: CoworkPermissionRequest }
 *   - cowork.onStreamPermissionResolved <- 'cowork:stream:permissionResolved' { requestId }
 *   - cowork.onStreamComplete       <- 'cowork:stream:complete'      { sessionId, claudeSessionId }
 *   - cowork.onStreamError          <- 'cowork:stream:error'         { sessionId, error }
 *   - scheduledTasks.onRunUpdate    <- 'scheduledTask:runUpdate'     { run }
 *   - scheduledTasks.onStatusUpdate <- 'scheduledTask:statusUpdate'  { taskId, state }
 *
 * Payload simplifications vs the desktop main process (documented per REQ-E-8):
 *   - 'cowork:stream:complete' carries an optional extension field
 *     `metadata.errorCode` for the LLM_QUOTA_EXHAUSTED scenario (WS-A
 *     REQ-A-25); IElectronAPI types it as { sessionId, claudeSessionId } only,
 *     and WS-A will add the metadata field on the server side.
 *   - Stream deltas are emitted on a fixed timer instead of model-paced flush
 *     batches; the { delta, baseLength } wire shape is identical, so the real
 *     CoworkStreamReassembler consumes them unchanged.
 *   - The permission request fixture uses toolName 'write_file' with a fixed
 *     /data/workspace path instead of a live tool call.
 */

import type {
  BundleChannelAPI,
  BundleMeters,
  BundlePlan,
  ConnectionState,
  MobileMockBridge,
  MockBridgeOptions,
  MockBundleOrder,
  MockElectronAPI,
  OfflineError,
  PendingPermissionRequest,
} from './types';

const DEFAULT_STREAM_TOKEN_INTERVAL_MS = 40;
const DEFAULT_ORDER_COMPLETE_DELAY_MS = 10_000;
const DEFAULT_RECONNECT_BLACKOUT_MS = 3_000;
const DEFAULT_SCHEDULED_RUN_DELAY_MS = 15_000;

/** Canned assistant replies (mock model output; not UI copy). */
const REPLY_NORMAL =
  '**Mock bridge online.**\n\nEvery reply in this demo is streamed token by token through the same `cowork:stream:*` events the desktop renderer consumes.\n\nTry typing a message containing `permission` or `quota` to exercise the other scenarios.';
const REPLY_PERMISSION_PART1 =
  'Sure — before I can demonstrate the tool call, this session needs your approval.\n\n';
const REPLY_PERMISSION_PART2 =
  '\n\nApproved — the write completed. This is the tail of the reply after the permission resolved.';
const REPLY_PERMISSION_DENIED =
  '\n\nDenied — the tool call was rejected, so I skipped it and continued without changes.';
const REPLY_QUOTA_PREFIX =
  'Let me check your remaining quota first';

/** Canned replies, exported for the mock-bridge tests. */
export const MOCK_CANNED_REPLIES = {
  normal: REPLY_NORMAL,
  permissionPart1: REPLY_PERMISSION_PART1,
  permissionPart2: REPLY_PERMISSION_PART2,
  permissionDenied: REPLY_PERMISSION_DENIED,
  quotaPrefix: REPLY_QUOTA_PREFIX,
} as const;

const MOCK_WORKSPACE = '/data/workspace';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function makeOfflineError(): OfflineError {
  const error = new Error('mock: connection lost (offline), retry when back online') as OfflineError;
  error.code = 'OFFLINE';
  error.retryable = true;
  return error;
}

interface MockCoworkMessage {
  id: string;
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

interface MockCoworkSession {
  id: string;
  title: string;
  claudeSessionId: string | null;
  status: 'idle' | 'running' | 'completed' | 'error';
  pinned: boolean;
  cwd: string;
  systemPrompt: string;
  executionMode: 'auto' | 'local' | 'sandbox';
  activeSkillIds: string[];
  messages: MockCoworkMessage[];
  createdAt: number;
  updatedAt: number;
  metabotId: number | null;
  sessionType: 'standard';
  autoOrigin: 'schedule' | null;
}

/** Splits text into fixed-size chunks so deltas exercise baseLength accounting. */
function splitChunks(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

class ChannelEmitter {
  private listeners = new Map<string, Set<(...args: never[]) => void>>();

  on(channel: string, callback: (...args: never[]) => void): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(callback);
    return () => {
      set.delete(callback);
      if (set.size === 0) this.listeners.delete(channel);
    };
  }

  emit(channel: string, ...args: unknown[]): void {
    const set = this.listeners.get(channel);
    if (!set) return;
    for (const callback of [...set]) {
      try {
        (callback as (...args: unknown[]) => void)(...args);
      } catch {
        // Listener exceptions must not break the mock's emit loop.
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

/** Returns a rejecting stand-in for every method not explicitly implemented. */
function stubNamespace(name: string, impl: Record<string, unknown>): Record<string, unknown> {
  return new Proxy(impl, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in target) return target[prop];
      return (..._args: unknown[]) => Promise.reject(new Error(`mock: ${name}:${prop} not implemented`));
    },
  });
}

function stubFunction(channel: string): (...args: unknown[]) => Promise<never> {
  return (..._args: unknown[]) => Promise.reject(new Error(`mock: ${channel} not implemented`));
}

export function createMobileMockBridge(options: MockBridgeOptions = {}): MobileMockBridge {
  const streamTokenIntervalMs = options.streamTokenIntervalMs ?? DEFAULT_STREAM_TOKEN_INTERVAL_MS;
  const orderCompleteDelayMs = options.orderCompleteDelayMs ?? DEFAULT_ORDER_COMPLETE_DELAY_MS;
  const reconnectBlackoutMs = options.reconnectBlackoutMs ?? DEFAULT_RECONNECT_BLACKOUT_MS;
  const scheduledRunDelayMs = options.scheduledRunDelayMs ?? DEFAULT_SCHEDULED_RUN_DELAY_MS;

  const emitter = new ChannelEmitter();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  };

  let destroyed = false;
  let connectionState: ConnectionState = 'online';
  const openedUrls: string[] = [];

  /** Invokes made while "disconnected" reject with an offline error (REQ-E-2 semantics). */
  const guardOnline = <T>(fn: () => Promise<T>): Promise<T> =>
    connectionState === 'online' ? fn() : Promise.reject(makeOfflineError());

  const waitWhileOffline = async (): Promise<void> => {
    while (connectionState !== 'online' && !destroyed) {
      await sleep(5);
    }
  };

  // ---------------------------------------------------------------- sessions
  const sessions = new Map<string, MockCoworkSession>();
  const liveMessages = new Map<string, MockCoworkMessage>(); // key: sessionId + messageId
  let sessionSeq = 0;
  let messageSeq = 0;
  const now = () => Date.now();
  const nextSessionId = () => `mock-session-${++sessionSeq}`;
  const nextMessageId = () => `mock-msg-${++messageSeq}`;
  const streamKey = (sessionId: string, messageId: string) => `${sessionId}${messageId}`;

  function summaryOf(session: MockCoworkSession) {
    return {
      id: session.id,
      title: session.title,
      status: session.status,
      pinned: session.pinned,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      metabotId: session.metabotId,
      sessionType: session.sessionType,
      autoOrigin: session.autoOrigin,
    };
  }

  function createSession(input: {
    title: string;
    prompt: string;
    metabotId?: number | null;
    autoOrigin?: MockCoworkSession['autoOrigin'];
  }): MockCoworkSession {
    const ts = now();
    const session: MockCoworkSession = {
      id: nextSessionId(),
      title: input.title,
      claudeSessionId: `claude-${input.title}`,
      status: 'idle',
      pinned: false,
      cwd: MOCK_WORKSPACE,
      systemPrompt: '',
      executionMode: 'auto',
      activeSkillIds: [],
      messages: [],
      createdAt: ts,
      updatedAt: ts,
      metabotId: input.metabotId ?? null,
      sessionType: 'standard',
      autoOrigin: input.autoOrigin ?? null,
    };
    sessions.set(session.id, session);
    return session;
  }

  function pushUserMessage(session: MockCoworkSession, text: string): MockCoworkMessage {
    const message: MockCoworkMessage = {
      id: nextMessageId(),
      type: 'user',
      content: text,
      timestamp: now(),
    };
    session.messages.push(message);
    session.updatedAt = now();
    return message;
  }

  // ------------------------------------------------------------- permissions
  const pendingPermissions = new Map<string, PendingPermissionRequest>();
  const permissionWaiters = new Map<string, (decision: 'allow' | 'deny' | 'destroyed') => void>();
  let requestSeq = 0;

  // ----------------------------------------------------------- chat scenario
  const QUOTA_ERROR_CODE = 'LLM_QUOTA_EXHAUSTED';

  async function streamChunks(
    session: MockCoworkSession,
    message: MockCoworkMessage,
    text: string,
  ): Promise<void> {
    const chunks = splitChunks(text, 4);
    const key = streamKey(session.id, message.id);
    for (let i = 0; i < chunks.length; i += 1) {
      await waitWhileOffline();
      if (destroyed) return;
      await sleep(streamTokenIntervalMs);
      if (destroyed) return;
      const accumulated = (liveMessages.get(key)?.content ?? '');
      if (i === 0) {
        message.content = chunks[0];
        liveMessages.set(key, message);
        emitter.emit('cowork:stream:messageUpdate', {
          sessionId: session.id,
          messageId: message.id,
          content: chunks[0],
        });
      } else {
        message.content = accumulated + chunks[i];
        emitter.emit('cowork:stream:messageUpdate', {
          sessionId: session.id,
          messageId: message.id,
          delta: chunks[i],
          baseLength: accumulated.length,
        });
      }
    }
  }

  async function runAssistantTurn(session: MockCoworkSession, userText: string): Promise<void> {
    const assistantMessage: MockCoworkMessage = {
      id: nextMessageId(),
      type: 'assistant',
      content: '',
      timestamp: now(),
    };
    session.messages.push(assistantMessage);
    session.status = 'running';
    session.updatedAt = now();
    emitter.emit('cowork:stream:message', { sessionId: session.id, message: { ...assistantMessage } });

    const wantsQuota = /quota/i.test(userText);
    const wantsPermission = !wantsQuota && /permission/i.test(userText);

    if (wantsQuota) {
      await streamChunks(session, assistantMessage, REPLY_QUOTA_PREFIX);
    } else if (wantsPermission) {
      await streamChunks(session, assistantMessage, REPLY_PERMISSION_PART1);
    } else {
      await streamChunks(session, assistantMessage, REPLY_NORMAL);
    }
    if (destroyed) return;

    if (wantsPermission) {
      const request = {
        sessionId: session.id,
        toolName: 'write_file',
        toolInput: { path: `${MOCK_WORKSPACE}/mock-demo.txt`, content: 'hello from the mock bridge' },
        requestId: `mock-req-${++requestSeq}`,
        toolUseId: null,
      };
      pendingPermissions.set(request.requestId, {
        sessionId: session.id,
        request,
        createdAt: now(),
      });
      emitter.emit('cowork:stream:permission', { sessionId: session.id, request });
      const decision = await new Promise<'allow' | 'deny' | 'destroyed'>((resolve) => {
        permissionWaiters.set(request.requestId, resolve);
      });
      permissionWaiters.delete(request.requestId);
      pendingPermissions.delete(request.requestId);
      emitter.emit('cowork:stream:permissionResolved', { requestId: request.requestId });
      if (destroyed) return;
      await streamChunks(
        session,
        assistantMessage,
        decision === 'deny' ? REPLY_PERMISSION_DENIED : REPLY_PERMISSION_PART2,
      );
    }

    if (destroyed) return;
    if (wantsQuota) {
      assistantMessage.metadata = { ...(assistantMessage.metadata ?? {}), errorCode: QUOTA_ERROR_CODE };
      session.status = 'error';
      // Extension payload: WS-A REQ-A-25 adds metadata.errorCode to the
      // completion event; IElectronAPI types only { sessionId, claudeSessionId } today.
      emitter.emit('cowork:stream:complete', {
        sessionId: session.id,
        claudeSessionId: session.claudeSessionId,
        metadata: { errorCode: QUOTA_ERROR_CODE },
      });
      return;
    }
    session.status = 'completed';
    session.updatedAt = now();
    emitter.emit('cowork:stream:complete', { sessionId: session.id, claudeSessionId: session.claudeSessionId });
  }

  const coworkImpl: Record<string, unknown> = {
    startSession: (input: { prompt?: string; title?: string; metabotId?: number | null }) =>
      guardOnline(async () => {
        const session = createSession({
          title: input?.title || 'Mock chat',
          prompt: input?.prompt || '',
          metabotId: input?.metabotId ?? null,
        });
        const text = input?.prompt || '';
        if (text) pushUserMessage(session, text);
        void runAssistantTurn(session, text);
        return { success: true, session: { ...session, messages: [...session.messages] } };
      }),
    continueSession: (input: { sessionId: string; prompt: string }) =>
      guardOnline(async () => {
        const session = sessions.get(input.sessionId);
        if (!session) return { success: false, error: 'session_not_found' };
        pushUserMessage(session, input.prompt || '');
        void runAssistantTurn(session, input.prompt || '');
        return { success: true, session: { ...session, messages: [...session.messages] } };
      }),
    submitInput: (input: { sessionId: string; text: string }) =>
      guardOnline(async () => {
        const session = sessions.get(input.sessionId);
        if (!session) {
          return { success: false, code: 'session_not_found', error: 'session not found' };
        }
        const message = pushUserMessage(session, input.text || '');
        void runAssistantTurn(session, input.text || '');
        return { success: true, mode: 'steer', message };
      }),
    getSession: (sessionId: string, options?: { messageLimit?: number }) =>
      guardOnline(async () => {
        const session = sessions.get(sessionId);
        if (!session) return { success: false, error: 'session not found' };
        const limit = options?.messageLimit ?? 200;
        return {
          success: true,
          session: { ...session, messages: session.messages.slice(-limit) },
        };
      }),
    getSessionMessagesPage: (input: { sessionId: string; limit?: number }) =>
      guardOnline(async () => {
        const session = sessions.get(input.sessionId);
        if (!session) return { success: false, error: 'session not found' };
        const limit = input.limit ?? 50;
        return {
          success: true,
          page: {
            messages: session.messages.slice(-limit),
            hasMoreBefore: session.messages.length > limit,
            beforeSequence: null,
          },
        };
      }),
    listSessions: (_options?: { metabotId?: number | null }) =>
      guardOnline(async () => ({
        success: true,
        sessions: [...sessions.values()].map(summaryOf),
      })),
    stopSession: (sessionId: string) =>
      guardOnline(async () => {
        const session = sessions.get(sessionId);
        if (session) session.status = 'idle';
        return { success: true };
      }),
    respondToPermission: (input: { requestId: string; result: { behavior?: string } }) =>
      guardOnline(async () => {
        const waiter = permissionWaiters.get(input.requestId);
        if (!waiter || !pendingPermissions.has(input.requestId)) {
          return { success: false, error: 'unknown or already resolved requestId' };
        }
        waiter(input.result?.behavior === 'deny' ? 'deny' : 'allow');
        return { success: true };
      }),
    getStreamLiveContent: (input: { sessionId: string; messageId: string }) =>
      guardOnline(async () => {
        const message = liveMessages.get(streamKey(input.sessionId, input.messageId));
        return { success: true, content: message?.content ?? '' };
      }),
    onStreamMessage: (callback: (data: unknown) => void) => emitter.on('cowork:stream:message', callback as never),
    onStreamMessageUpdate: (callback: (data: unknown) => void) => emitter.on('cowork:stream:messageUpdate', callback as never),
    onStreamPermission: (callback: (data: unknown) => void) => emitter.on('cowork:stream:permission', callback as never),
    onStreamPermissionResolved: (callback: (data: unknown) => void) => emitter.on('cowork:stream:permissionResolved', callback as never),
    onStreamComplete: (callback: (data: unknown) => void) => emitter.on('cowork:stream:complete', callback as never),
    onStreamError: (callback: (data: unknown) => void) => emitter.on('cowork:stream:error', callback as never),
    onStreamSessionTitle: (callback: (data: unknown) => void) => emitter.on('cowork:stream:sessionTitle', callback as never),
    onSessionProfileRefreshed: (callback: (data: unknown) => void) => emitter.on('cowork:session:profileRefreshed', callback as never),
    onDelegationStateChange: (callback: (data: unknown) => void) => emitter.on('cowork:delegation:stateChange', callback as never),
    getConfig: () =>
      guardOnline(async () => ({
        success: true,
        config: {
          workingDirectory: MOCK_WORKSPACE,
          systemPrompt: '',
          executionMode: 'auto',
          memoryEnabled: true,
          memoryImplicitUpdateEnabled: true,
          memoryLlmJudgeEnabled: false,
          memoryGuardLevel: 'standard',
          memoryUserMemoriesMaxItems: 50,
          memoryPromptMaxChars: 4000,
          lastWorkspaceSelection: null,
        },
      })),
  };

  // -------------------------------------------------------- scheduled tasks
  interface MockScheduledTaskState {
    nextRunAtMs: number | null;
    lastRunAtMs: number | null;
    lastStatus: 'success' | 'error' | 'running' | null;
    lastError: string | null;
    lastDurationMs: number | null;
    runningAtMs: number | null;
    consecutiveErrors: number;
  }

  type MockSchedule =
    | { type: 'interval'; intervalMs: number; unit: 'minutes' | 'hours' | 'days'; value: number }
    | { type: 'cron'; expression: string };

  interface MockScheduledTask {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    schedule: MockSchedule;
    prompt: string;
    workingDirectory: string;
    systemPrompt: string;
    executionMode: 'auto' | 'local' | 'sandbox';
    metabotId: number | null;
    coworkSessionId: string | null;
    targetSessionId: string | null;
    expiresAt: string | null;
    notifyPlatforms: string[];
    state: MockScheduledTaskState;
    createdAt: string;
    updatedAt: string;
  }

  interface MockScheduledTaskRun {
    id: string;
    taskId: string;
    sessionId: string | null;
    status: 'running' | 'success' | 'error' | 'skipped';
    startedAt: string;
    finishedAt: string | null;
    durationMs: number | null;
    error: string | null;
    trigger: 'scheduled' | 'manual';
    skipReason: string | null;
  }

  const bootAt = now();
  const scheduledTasks: MockScheduledTask[] = [
    {
      id: 'mock-task-1',
      name: 'Daily digest',
      description: 'Summarizes activity once a day',
      enabled: true,
      schedule: { type: 'interval', intervalMs: 86_400_000, unit: 'days', value: 1 },
      prompt: 'Write a short digest of the last 24 hours',
      workingDirectory: MOCK_WORKSPACE,
      systemPrompt: '',
      executionMode: 'auto',
      metabotId: 1,
      coworkSessionId: null,
      targetSessionId: null,
      expiresAt: null,
      notifyPlatforms: [],
      state: {
        nextRunAtMs: bootAt + 86_400_000,
        lastRunAtMs: null,
        lastStatus: null,
        lastError: null,
        lastDurationMs: null,
        runningAtMs: null,
        consecutiveErrors: 0,
      },
      createdAt: new Date(bootAt).toISOString(),
      updatedAt: new Date(bootAt).toISOString(),
    },
    {
      id: 'mock-task-2',
      name: 'Weekly wallet report',
      description: 'Drafts a balance report every Monday',
      enabled: false,
      schedule: { type: 'cron', expression: '0 9 * * 1' },
      prompt: 'Draft the weekly wallet report',
      workingDirectory: MOCK_WORKSPACE,
      systemPrompt: '',
      executionMode: 'auto',
      metabotId: 2,
      coworkSessionId: null,
      targetSessionId: null,
      expiresAt: null,
      notifyPlatforms: [],
      state: {
        nextRunAtMs: null,
        lastRunAtMs: bootAt - 604_800_000,
        lastStatus: 'success',
        lastError: null,
        lastDurationMs: 12_000,
        runningAtMs: null,
        consecutiveErrors: 0,
      },
      createdAt: new Date(bootAt).toISOString(),
      updatedAt: new Date(bootAt).toISOString(),
    },
  ];
  const scheduledRuns = new Map<string, MockScheduledTaskRun[]>();
  let runSeq = 0;

  function taskById(id: string): MockScheduledTask | undefined {
    return scheduledTasks.find((task) => task.id === id);
  }

  function fireScheduledRun(): void {
    const task = taskById('mock-task-1');
    if (!task || destroyed) return;
    const runSession = createSession({
      title: 'Scheduled run: Daily digest',
      prompt: task.prompt,
      metabotId: task.metabotId,
      autoOrigin: 'schedule',
    });
    const startedMs = now();
    task.state = {
      ...task.state,
      lastStatus: 'running',
      runningAtMs: startedMs,
    };
    task.updatedAt = new Date(startedMs).toISOString();
    emitter.emit('scheduledTask:statusUpdate', { taskId: task.id, state: { ...task.state } });
    const run: MockScheduledTaskRun = {
      id: `mock-run-${++runSeq}`,
      taskId: task.id,
      sessionId: runSession.id,
      status: 'success',
      startedAt: new Date(startedMs).toISOString(),
      finishedAt: null,
      durationMs: null,
      error: null,
      trigger: 'scheduled',
      skipReason: null,
    };
    const finishRun = () => {
      if (destroyed) return;
      const finishedMs = now();
      run.finishedAt = new Date(finishedMs).toISOString();
      run.durationMs = finishedMs - startedMs;
      task.state = {
        nextRunAtMs: finishedMs + 86_400_000,
        lastRunAtMs: finishedMs,
        lastStatus: 'success',
        lastError: null,
        lastDurationMs: run.durationMs,
        runningAtMs: null,
        consecutiveErrors: 0,
      };
      task.updatedAt = new Date(finishedMs).toISOString();
      runSession.status = 'completed';
      const runs = scheduledRuns.get(task.id) ?? [];
      runs.unshift(run);
      scheduledRuns.set(task.id, runs);
      emitter.emit('scheduledTask:runUpdate', { run: { ...run } });
      emitter.emit('scheduledTask:statusUpdate', { taskId: task.id, state: { ...task.state } });
    };
    later(finishRun, Math.min(200, scheduledRunDelayMs));
  }

  later(fireScheduledRun, scheduledRunDelayMs);

  const scheduledTasksImpl: Record<string, unknown> = {
    list: () => guardOnline(async () => ({ success: true, tasks: scheduledTasks.map((t) => ({ ...t })) })),
    get: (id: string) =>
      guardOnline(async () => {
        const task = taskById(id);
        return task ? { success: true, task: { ...task } } : { success: false, error: 'task not found' };
      }),
    listRuns: (taskId: string, limit = 50, offset = 0) =>
      guardOnline(async () => {
        const runs = scheduledRuns.get(taskId) ?? [];
        return { success: true, runs: runs.slice(offset, offset + limit) };
      }),
    countRuns: (taskId: string) =>
      guardOnline(async () => ({ success: true, count: (scheduledRuns.get(taskId) ?? []).length })),
    listAllRuns: (limit = 50, offset = 0) =>
      guardOnline(async () => {
        const all = [...scheduledRuns.values()].flat();
        return { success: true, runs: all.slice(offset, offset + limit) };
      }),
    onRunUpdate: (callback: (data: unknown) => void) => emitter.on('scheduledTask:runUpdate', callback as never),
    onStatusUpdate: (callback: (data: unknown) => void) => emitter.on('scheduledTask:statusUpdate', callback as never),
  };

  // ----------------------------------------------------- plans and payment
  const plans: BundlePlan[] = [
    {
      planId: 'bundle_basic_cny',
      name: 'Basic bundle',
      nameEn: 'Basic',
      payCurrency: 'CNY',
      payAmount: '129.00',
      trafficBytes: 10 * 1024 * 1024 * 1024,
      llmQuota: 50_000_000,
      llmQuotaUnit: 'tokens',
      status: 1,
      sort: 10,
      remark: '',
    },
    {
      planId: 'bundle_pro_cny',
      name: 'Pro bundle',
      nameEn: 'Pro',
      payCurrency: 'CNY',
      payAmount: '179.00',
      trafficBytes: 50 * 1024 * 1024 * 1024,
      llmQuota: 200_000_000,
      llmQuotaUnit: 'tokens',
      status: 1,
      sort: 20,
      remark: '',
    },
  ];
  const orders = new Map<string, MockBundleOrder>();
  let orderSeq = 0;

  const meters: BundleMeters = {
    traffic: {
      accountId: 'mock-traffic-account',
      identityAddress: 'mock-identity-address',
      balanceBytes: 500 * 1024 * 1024,
      reservedBytes: 0,
      grantedBytesTotal: 1024 * 1024 * 1024,
      spentBytesTotal: 524 * 1024 * 1024,
      status: 1,
    },
    llm: {
      quotaTotal: 2_000_000,
      quotaUsed: 350_000,
      quotaRemaining: 1_650_000,
      quotaFree: 2_000_000,
      quotaPurchased: 0,
      unit: 'tokens',
    },
  };

  const bundleImpl: BundleChannelAPI = {
    getPlans: () =>
      guardOnline(async () => ({
        success: true,
        plans: [...plans].sort((a, b) => a.sort - b.sort),
      })),
    createOrder: (input: { planId: string }) =>
      guardOnline(async () => {
        const plan = plans.find((p) => p.planId === input?.planId && p.status === 1);
        if (!plan) return { success: false, error: 'plan not found or off sale' };
        const createdAt = now();
        const order: MockBundleOrder = {
          orderId: `bo_mock_${++orderSeq}`,
          planId: plan.planId,
          payAmount: plan.payAmount,
          payCurrency: plan.payCurrency,
          trafficBytes: plan.trafficBytes,
          llmQuota: plan.llmQuota,
          status: 1,
          gatewayParams: {
            qrCode: `https://qr.alipay.com/mock?id=${plan.planId}&n=${orderSeq}`,
            alipayOutTradeNo: `mock-out-${orderSeq}`,
          },
          expiresAt: createdAt + 15 * 60 * 1000,
          createdAt,
        };
        orders.set(order.orderId, order);
        // Deterministic payment: the order credits after orderCompleteDelayMs
        // (10 s by default) and the meters rise at that point.
        later(() => {
          if (destroyed) return;
          order.status = 3;
          order.paidAt = order.createdAt + orderCompleteDelayMs;
          order.creditedAt = now();
          meters.traffic.balanceBytes += order.trafficBytes;
          meters.traffic.grantedBytesTotal += order.trafficBytes;
          meters.llm.quotaTotal += order.llmQuota;
          meters.llm.quotaPurchased += order.llmQuota;
          meters.llm.quotaRemaining = meters.llm.quotaTotal - meters.llm.quotaUsed;
        }, orderCompleteDelayMs);
        return { success: true, order: { ...order } };
      }),
    getOrder: (input: { orderId: string }) =>
      guardOnline(async () => {
        const order = orders.get(input?.orderId);
        return order ? { success: true, order: { ...order } } : { success: false, error: 'order not found' };
      }),
    getMeters: () =>
      guardOnline(async () => ({
        success: true,
        meters: {
          traffic: { ...meters.traffic },
          llm: { ...meters.llm },
        },
      })),
  };

  // ------------------------------------------------------------ local tiers
  const appConfigStore = new Map<string, unknown>([
    [
      'app_config',
      {
        language: 'en',
        theme: 'system',
        providers: {},
        memoryEnabled: true,
      },
    ],
  ]);
  const storeListeners = new Set<(payload: { key: string }) => void>();
  const storeGuard = (op: string, key: string): string | null =>
    key === 'app_config' ? null : `mock: store:${op} key '${key}' rejected by R-store (only 'app_config' is allowed)`;

  const storeImpl: Record<string, unknown> = {
    get: (key: string) =>
      guardOnline(async () => {
        const denied = storeGuard('get', key);
        if (denied) throw new Error(denied);
        return appConfigStore.get(key) ?? null;
      }),
    getStrict: (key: string) =>
      guardOnline(async () => {
        const denied = storeGuard('get', key);
        if (denied) throw new Error(denied);
        return appConfigStore.get(key) ?? null;
      }),
    set: (key: string, value: unknown) =>
      guardOnline(async () => {
        const denied = storeGuard('set', key);
        if (denied) throw new Error(denied);
        appConfigStore.set(key, value);
        for (const listener of [...storeListeners]) listener({ key });
      }),
    remove: (_key: string) =>
      guardOnline(async () => {
        // R-store: remove is rejected outright, even for app_config.
        throw new Error('mock: store:remove rejected by R-store (remove is not allowed)');
      }),
    onChanged: (callback: (payload: { key: string }) => void) => {
      storeListeners.add(callback);
      return () => {
        storeListeners.delete(callback);
      };
    },
  };

  const detectedLocale = () => {
    if (typeof navigator !== 'undefined' && typeof navigator.language === 'string' && navigator.language) {
      return navigator.language;
    }
    return 'en';
  };

  const electron: Record<string, unknown> = {
    // REQ-E-3: the server is linux/x64; keep the same values so desktop
    // renderer services that branch on platform never take a desktop path.
    platform: 'linux',
    arch: 'x64',
    getRecentCwds: () => Promise.resolve([]),
    getApiConfig: () => Promise.resolve(null),
    checkApiConfig: () => Promise.resolve({ hasConfig: false, config: null }),
    saveApiConfig: stubFunction('save-api-config'),
    generateSessionTitle: () => Promise.resolve('Mock chat'),
    startup: {
      rendererInitialized: () =>
        guardOnline(async () => ({ success: true, elapsedMs: 15, startedAt: bootAt })),
    },
    window: {
      minimize: () => undefined,
      toggleMaximize: () => undefined,
      close: () => undefined,
      moveBy: () => undefined,
      showSystemMenu: () => undefined,
      isMaximized: () => Promise.resolve(false),
      onStateChanged: () => () => undefined,
    },
    dialog: {
      // Desktop cancelled shapes: success with a null path (main.ts dialog handlers).
      selectDirectory: () => Promise.resolve({ success: true, path: null }),
      selectFile: () => Promise.resolve({ success: true, path: null, paths: [] }),
      saveInlineFile: () => Promise.resolve({ success: true, path: null }),
    },
    shell: {
      openExternal: (url: string) =>
        guardOnline(async () => {
          if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
            openedUrls.push(url);
            if (typeof window !== 'undefined' && typeof window.open === 'function') {
              window.open(url, '_blank', 'noopener,noreferrer');
            }
            return { success: true };
          }
          return { success: false };
        }),
      openPath: () => Promise.resolve({ success: false }),
      showItemInFolder: () => Promise.resolve({ success: false }),
      openWith: () => Promise.resolve({ success: false }),
      getOpenWithApps: () => Promise.resolve({ success: true, apps: [] }),
      chooseOpenWithApp: () => Promise.resolve({ success: false }),
    },
    appInfo: {
      getVersion: () => Promise.resolve('1.0.2-mobile.mock'),
      getSystemLocale: () => Promise.resolve(options.systemLocale ?? detectedLocale()),
    },
    store: storeImpl,
    cowork: coworkImpl,
    scheduledTasks: scheduledTasksImpl,
    bundle: bundleImpl,
    mobile: {
      permission: {
        listPending: () =>
          guardOnline(async () => ({
            success: true,
            pending: [...pendingPermissions.values()].map((p) => ({
              sessionId: p.sessionId,
              request: { ...p.request },
              createdAt: p.createdAt,
            })),
          })),
      },
      bootstrap: {
        status: () =>
          guardOnline(async () => ({
            success: true,
            onboarding: {
              identity: 'done',
              llmProvider: 'done',
              twinMetabot: 'done',
              workspace: 'done',
              trafficAccount: 'done',
              redeemCode: 'skipped',
              globalMetaId: 'mock-globalmetaid',
              twinMetabotId: 1,
            },
          })),
      },
      file: {
        sign: (input: { path: string; disposition?: 'inline' | 'attachment' }) =>
          guardOnline(async () => ({
            success: true,
            url: `/files/mock-${encodeURIComponent(String(input?.path ?? '').slice(-24))}`,
            expiresAt: now() + 10 * 60 * 1000,
            size: 1024,
            mime: 'application/octet-stream',
          })),
      },
    },
    metabot: {
      list: () =>
        guardOnline(async () => ({
          success: true,
          list: [
            {
              id: 1,
              wallet_id: 1,
              name: 'Twin Bot',
              avatar: null,
              enabled: true,
              globalmetaid: 'mock-globalmetaid-twin',
              metabot_type: 'twin',
              role: 'Your twin',
              soul: 'Mock twin soul',
              goal: null,
              bio: 'The mock Twin Bot',
              background: null,
              boss_id: null,
              boss_global_metaid: null,
              llm_id: null,
              tools: [],
              skills: ['web-search'],
              allow_chat_skills: [],
              created_at: bootAt,
              updated_at: bootAt,
            },
            {
              id: 2,
              wallet_id: 2,
              name: 'Researcher',
              avatar: null,
              enabled: true,
              globalmetaid: 'mock-globalmetaid-worker',
              metabot_type: 'worker',
              role: 'Researches the MetaWeb',
              soul: 'Mock worker soul',
              goal: null,
              bio: 'A mock worker Bot',
              background: null,
              boss_id: null,
              boss_global_metaid: null,
              llm_id: null,
              tools: [],
              skills: [],
              allow_chat_skills: [],
              created_at: bootAt,
              updated_at: bootAt,
            },
          ],
        })),
    },
    userIdentity: {
      get: () =>
        guardOnline(async () => ({
          success: true,
          identity: {
            id: 1,
            path: "m/44'/10001'/0'/0/0",
            mvc_address: 'mock-mvc-address',
            btc_address: 'mock-btc-address',
            doge_address: 'mock-doge-address',
            public_key: 'mock-public-key',
            chat_public_key: 'mock-chat-public-key',
            chat_public_key_pin_id: null,
            metaid: 'mock-metaid',
            globalmetaid: 'mock-globalmetaid',
            name: 'Mock User',
            avatar: null,
            subsidy_state: 'claimed',
            subsidy_error: null,
            name_pin_id: null,
            avatar_pin_id: null,
            sync_state: 'synced',
            sync_error: null,
            created_at: bootAt,
            updated_at: bootAt,
          },
        })),
    },
    skills: {
      list: () =>
        guardOnline(async () => ({
          success: true,
          skills: [
            {
              id: 'web-search',
              name: 'web-search',
              description: 'Searches the web',
              enabled: true,
              isOfficial: true,
              isBuiltIn: false,
              updatedAt: bootAt,
              prompt: '',
              skillPath: '/data/appdata/SKILLs/web-search',
            },
            {
              id: 'memory',
              name: 'memory',
              description: 'Long-term memory',
              enabled: true,
              isOfficial: true,
              isBuiltIn: true,
              updatedAt: bootAt,
              prompt: '',
              skillPath: '/data/appdata/SKILLs/memory',
            },
          ],
        })),
      onChanged: (callback: () => void) => emitter.on('skills:changed', callback as never),
    },
    traffic: {
      getBalance: () =>
        guardOnline(async () => ({ success: true, balance: { ...meters.traffic } })),
    },
    llmRelay: {
      getQuota: () =>
        guardOnline(async () => ({
          success: true,
          quota: {
            keyPrefix: 'mock',
            baseUrl: 'https://mock.invalid/relay',
            models: [],
            ...meters.llm,
            quotaCycleResetAt: 0,
            jevQuotaTotal: 0,
            jevQuotaUsed: 0,
            jevQuotaRemaining: 0,
          },
        })),
    },
  };

  // Every remaining namespace from IElectronAPI exists but rejects, so a
  // renderer service touching an unimplemented channel gets a named Error
  // instead of a TypeError on undefined.
  const namespaceNames = [
    'powerGuard', 'metaapps', 'metaappOwner', 'botBrowser', 'agentGame', 'api', 'gigSquare',
    'deepseek', 'appEvents', 'fs', 'autoLaunch', 'experimentalAutomation', 'feeRates',
    'appUpdate', 'im', 'longtermTask', 'metatask', 'preference', 'groupTask', 'openTeamCollab',
    'idbots', 'chainBackup', 'metaWebListener', 'dream', 'knowledgeBase', 'metawebStudy',
    'surf', 'permissions', 'networkStatus', 'mcp', 'projects', 'p2p', 'providerDiscovery',
    'jevRelay',
  ] as const;
  for (const name of namespaceNames) {
    const existing = electron[name];
    electron[name] = stubNamespace(name, (existing as Record<string, unknown>) ?? {});
  }
  // Wrap the implemented namespaces too, so even they reject (never TypeError)
  // on methods the mock did not implement.
  for (const name of ['store', 'cowork', 'scheduledTasks', 'bundle', 'mobile', 'metabot', 'skills', 'traffic', 'llmRelay', 'startup', 'window', 'dialog', 'shell', 'appInfo', 'userIdentity'] as const) {
    electron[name] = stubNamespace(name, (electron[name] as Record<string, unknown>) ?? {});
  }

  const api = new Proxy(electron, {
    get(target, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      if (prop in target) return (target as Record<string, unknown>)[prop];
      // Flat IElectronAPI members that the mock did not implement still
      // reject with a named error instead of being undefined.
      return stubFunction(prop);
    },
  }) as unknown as MockElectronAPI;

  // --------------------------------------------------------- connection bus
  const setConnectionState = (state: ConnectionState) => {
    if (connectionState === state || destroyed) return;
    connectionState = state;
    emitter.emit('connection:change', state);
  };

  const control = {
    simulateReconnect: () => {
      if (connectionState !== 'online') return;
      setConnectionState('reconnecting');
      later(() => setConnectionState('online'), reconnectBlackoutMs);
    },
    getConnectionState: () => connectionState,
    getOpenedUrls: () => [...openedUrls],
  };

  return {
    electron: api,
    connection: {
      getState: () => connectionState,
      onChange: (callback: (state: ConnectionState) => void) => emitter.on('connection:change', callback as never),
    },
    control,
    destroy: () => {
      destroyed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const resolve of permissionWaiters.values()) resolve('destroyed');
      permissionWaiters.clear();
      emitter.clear();
    },
  };
}
