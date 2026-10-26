import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mergeCoworkSnapshotMessages } from '../src/renderer/services/coworkSessionState';
import { performResync } from '../src/mobile/app/hooks/useResync';
import type { CoworkMessage } from '../src/renderer/types/cowork';

function message(id: string, type: CoworkMessage['type'], text: string): CoworkMessage {
  return { id, type, content: text, timestamp: 1 };
}

it('stale resync snapshot must not overwrite newer streamed text', () => {
  const merged = mergeCoworkSnapshotMessages(
    [message('m1', 'assistant', 'newer text')],
    [message('m1', 'assistant', 'older text')],
    { m1: 2 },
    { baseMessageRevisions: { m1: 1 } },
  );
  assert.equal(merged[0]?.content, 'newer text');
});

it('identical text alone must not dedupe an optimistic send', () => {
  const merged = mergeCoworkSnapshotMessages(
    [message('local-new', 'user', 'repeat')],
    [message('server-old', 'user', 'repeat')],
  );
  assert.ok(merged.some((entry) => entry.id === 'local-new'));
});

it('unacknowledged optimistic sends stay after server history in display order', () => {
  const merged = mergeCoworkSnapshotMessages(
    [message('local-new', 'user', 'new')],
    [message('server-old', 'assistant', 'old')],
  );
  assert.deepEqual(merged.map((entry) => entry.id), ['server-old', 'local-new']);
});

it('resync derives active stream from the running session, not a local streaming flag', async () => {
  const liveCalls: string[] = [];
  const electron = {
    cowork: {
      getSession: async () => ({
        success: true,
        session: {
          id: 's1',
          status: 'running',
          messages: [{ id: 'm1', type: 'assistant', content: 'partial', timestamp: 1 }],
        },
      }),
      getStreamLiveContent: async () => {
        liveCalls.push('getStreamLiveContent');
        return { success: true, content: 'partial live' };
      },
    },
    mobile: {
      listPendingPermissions: async () => [],
    },
  };
  const snapshot = await performResync(electron as never, {
    getOpenSessionId: () => 's1',
    getStreamingMessage: () => null,
  });
  assert.equal(snapshot.liveContent?.content, 'partial live');
  assert.deepEqual(liveCalls, ['getStreamLiveContent']);
});
