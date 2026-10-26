import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mergeResyncedMessages } from '../src/mobile/app/hooks/useChat';
import { performResync } from '../src/mobile/app/hooks/useResync';
import type { ChatMessageView } from '../src/mobile/app/hooks/useChat';

function expectWp0Defect(name: string, verify: () => void | Promise<void>): void {
  it(name, async () => {
    let caught: unknown = null;
    try {
      await verify();
    } catch (error) {
      caught = error;
      console.info(`WP0 defect reproduced: ${name}: ${String(error)}`);
    }
    if (!caught) {
      assert.fail(`WP0 defect no longer reproduces: ${name}. Convert this expected-defect test into a normal regression test.`);
    }
  });
}

function assistant(id: string, text: string): ChatMessageView {
  return { id, role: 'assistant', text, streaming: false };
}

expectWp0Defect('stale resync snapshot must not overwrite newer streamed text', () => {
  const merged = mergeResyncedMessages([assistant('m1', 'newer text')], [assistant('m1', 'older text')]);
  assert.equal(merged[0]?.text, 'newer text');
});

expectWp0Defect('identical text alone must not dedupe an optimistic send', () => {
  const merged = mergeResyncedMessages(
    [{ id: 'local-new', role: 'user', text: 'repeat', streaming: false }],
    [{ id: 'server-old', role: 'user', text: 'repeat', streaming: false }],
  );
  assert.ok(merged.some((message) => message.id === 'local-new'));
});

expectWp0Defect('unacknowledged optimistic sends stay after server history in display order', () => {
  const merged = mergeResyncedMessages(
    [{ id: 'local-new', role: 'user', text: 'new', streaming: false }],
    [{ id: 'server-old', role: 'assistant', text: 'old', streaming: false }],
  );
  assert.deepEqual(merged.map((message) => message.id), ['server-old', 'local-new']);
});

expectWp0Defect('resync derives active stream from the running session, not a local streaming flag', async () => {
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
