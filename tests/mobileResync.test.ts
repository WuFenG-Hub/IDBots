import assert from 'node:assert/strict';
import test from 'node:test';
import { performResync } from '../src/mobile/app/hooks/useResync.ts';
import { mergeResyncedMessages } from '../src/mobile/app/hooks/useChat.ts';
import type { ChatMessageView } from '../src/mobile/app/hooks/useChat.ts';

/**
 * REQ-E-5 reconnect resync: on every (re)connect the shell re-pulls hot state
 * in a fixed C2-ordered sequence. These tests drive the pure sequence with a
 * fake electron that records invoke order, and exercise the message merge
 * that rebuilds the transcript without duplicates.
 */

interface RecordedCall {
  channel: string;
  args: unknown[];
}

/** Fake electron whose invokes record themselves in order. */
function makeFakeElectron(options: { failGetSession?: boolean } = {}) {
  const calls: RecordedCall[] = [];
  const pendingPermissions = [
    {
      sessionId: 's-1',
      request: {
        sessionId: 's-1',
        toolName: 'write_file',
        toolInput: { path: '/data/workspace/x.txt' },
        requestId: 'req-1',
        toolUseId: null,
      },
      createdAt: 123,
    },
  ];
  const electron = {
    cowork: {
      getSession: async (sessionId: string, opts?: { messageLimit?: number }) => {
        calls.push({ channel: 'cowork.getSession', args: [sessionId, opts] });
        if (options.failGetSession) throw new Error('offline again');
        return {
          success: true,
          session: {
            id: sessionId,
            title: 'Demo',
            messages: [
              { id: 'm-1', type: 'user', content: 'hello', timestamp: 1 },
              { id: 'm-2', type: 'assistant', content: 'hi there', timestamp: 2 },
            ],
          },
        };
      },
      getStreamLiveContent: async (payload: { sessionId: string; messageId: string }) => {
        calls.push({ channel: 'cowork.getStreamLiveContent', args: [payload] });
        return { success: true, content: 'partial stream text' };
      },
    },
    mobile: {
      listPendingPermissions: async () => {
        calls.push({ channel: 'mobile.listPendingPermissions', args: [] });
        return pendingPermissions;
      },
    },
  };
  return { electron, calls, pendingPermissions };
}

const context = {
  getOpenSessionId: () => 's-1',
  getStreamingMessage: () => ({ sessionId: 's-1', messageId: 'm-2' }),
};

test('performResync runs the C2-ordered sequence: getSession, getStreamLiveContent, listPendingPermissions', async () => {
  const { electron, calls, pendingPermissions } = makeFakeElectron();
  const snapshot = await performResync(electron as never, context);

  assert.deepEqual(
    calls.map((call) => call.channel),
    ['cowork.getSession', 'cowork.getStreamLiveContent', 'mobile.listPendingPermissions'],
    'the three pulls must run strictly in order',
  );
  assert.equal(calls[0].args[0], 's-1');
  assert.deepEqual(calls[1].args[0], { sessionId: 's-1', messageId: 'm-2' });

  assert.equal(snapshot.session?.id, 's-1');
  assert.equal(snapshot.session?.messages.length, 2);
  assert.deepEqual(snapshot.liveContent, { sessionId: 's-1', messageId: 'm-2', content: 'partial stream text' });
  assert.deepEqual(snapshot.pendingPermissions, pendingPermissions);
});

test('performResync still runs later steps when an earlier step fails', async () => {
  const { electron, calls } = makeFakeElectron({ failGetSession: true });
  const snapshot = await performResync(electron as never, context);
  assert.equal(snapshot.session, null);
  assert.deepEqual(
    calls.map((call) => call.channel),
    ['cowork.getSession', 'cowork.getStreamLiveContent', 'mobile.listPendingPermissions'],
  );
  assert.equal(snapshot.liveContent?.content, 'partial stream text');
  assert.equal(snapshot.pendingPermissions.length, 1);
});

test('performResync skips the session and stream pulls when nothing is open', async () => {
  const { electron, calls } = makeFakeElectron();
  const snapshot = await performResync(electron as never, {
    getOpenSessionId: () => null,
    getStreamingMessage: () => null,
  });
  assert.deepEqual(
    calls.map((call) => call.channel),
    ['mobile.listPendingPermissions'],
  );
  assert.equal(snapshot.session, null);
  assert.equal(snapshot.liveContent, null);
});

test('mergeResyncedMessages dedupes by message id and drops the landed offline send', () => {
  const existing: ChatMessageView[] = [
    { id: 'local-1', role: 'user', text: 'hello', streaming: false },
    { id: 'm-2', role: 'assistant', text: 'partial', streaming: true },
  ];
  // The server persisted the offline send under its own id: the local
  // 'local-1' row is a content duplicate and must not survive the merge.
  const detail: ChatMessageView[] = [
    { id: 'm-1', role: 'user', text: 'hello', streaming: false },
    { id: 'm-2', role: 'assistant', text: 'hi there', streaming: false },
  ];
  const merged = mergeResyncedMessages(existing, detail);

  const userMessages = merged.filter((message) => message.role === 'user');
  assert.equal(userMessages.length, 1, 'exactly one copy of the user message survives');
  assert.equal(userMessages[0].id, 'm-1');
  const assistant = merged.find((message) => message.id === 'm-2');
  assert.equal(assistant?.text, 'hi there', 'the fresh detail text wins');
  assert.equal(assistant?.streaming, true, 'the event-driven streaming flag is preserved');
});

test('mergeResyncedMessages keeps unacked local messages and rows the detail dropped', () => {
  const existing: ChatMessageView[] = [
    { id: 'm-0', role: 'assistant', text: 'older', streaming: false },
    { id: 'local-2', role: 'user', text: 'offline question', streaming: false },
  ];
  const detail: ChatMessageView[] = [
    { id: 'm-1', role: 'user', text: 'hello', streaming: false },
  ];
  const merged = mergeResyncedMessages(existing, detail);
  const ids = merged.map((message) => message.id);
  assert.ok(ids.includes('local-2'), 'a local message the server never saw stays');
  assert.ok(ids.includes('m-0'), 'an existing row the trimmed detail lost stays');
  assert.ok(ids.includes('m-1'), 'new server rows are appended');
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
});
