import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveUserMessageOrigin,
} from '../src/renderer/components/cowork/userMessageOrigin';
import type { CoworkMessage } from '../src/renderer/types/cowork';

/**
 * Right-side cowork bubbles get a source-attribution label resolved from
 * message metadata. Explicit `origin` tags win; legacy markers
 * (sourceChannel, quick_action, submissionId) keep historical messages
 * labeled; the final fallback is the local human composer.
 */

const msg = (metadata: Record<string, unknown> | undefined): CoworkMessage => ({
  id: 'm1',
  type: 'user',
  content: 'hello',
  timestamp: 0,
  metadata: metadata as CoworkMessage['metadata'],
});

test('explicit origin tag wins over everything else', () => {
  assert.deepEqual(
    resolveUserMessageOrigin(msg({ origin: 'schedule', originLabel: 'daily summary', submissionId: 'x' })),
    { kind: 'schedule', detail: 'daily summary' },
  );
  assert.deepEqual(
    resolveUserMessageOrigin(msg({ origin: 'heartbeat' })),
    { kind: 'heartbeat', detail: undefined },
  );
});

test('unknown explicit origin strings fall through to legacy markers', () => {
  const origin = resolveUserMessageOrigin(msg({ origin: 'from-the-future', submissionId: 's1' }));
  assert.equal(origin.kind, 'user');
});

test('composer submissions resolve to the local user', () => {
  assert.equal(resolveUserMessageOrigin(msg({ submissionId: 's1', submissionMode: 'continue' })).kind, 'user');
  assert.equal(resolveUserMessageOrigin(msg({ submissionId: 's1', interactionKind: 'steer' })).kind, 'user');
});

test('quick action submissions are marked as quick_action', () => {
  assert.equal(resolveUserMessageOrigin(msg({ source: 'quick_action', submissionId: 's1' })).kind, 'quick_action');
});

test('cross-session forwards carry the source session id', () => {
  assert.deepEqual(
    resolveUserMessageOrigin(msg({ sourceChannel: 'idbots_cross_session', sourceSessionId: 'abc-123' })),
    { kind: 'cross_session', detail: 'abc-123' },
  );
});

test('metaweb relays resolve sender identity fields', () => {
  assert.deepEqual(
    resolveUserMessageOrigin(msg({ sourceChannel: 'metaweb_group', latestMessageSenderGlobalmetaid: 'gmid-1' })),
    { kind: 'metaweb_group', senderGlobalMetaId: 'gmid-1' },
  );
  assert.deepEqual(
    resolveUserMessageOrigin(msg({ sourceChannel: 'metaweb_private', senderGlobalMetaId: 'gmid-2' })),
    { kind: 'metaweb_private', senderGlobalMetaId: 'gmid-2' },
  );
  assert.equal(
    resolveUserMessageOrigin(msg({ sourceChannel: 'orchestrator' })).kind,
    'orchestrator',
  );
});

test('legacy longterm sessions: untagged user messages are heartbeat escalations', () => {
  assert.equal(
    resolveUserMessageOrigin(msg(undefined), { sessionType: 'longterm' }).kind,
    'heartbeat',
  );
  // ...but composer input in the same session (carries submissionId) stays "user".
  assert.equal(
    resolveUserMessageOrigin(msg({ submissionId: 's1' }), { sessionType: 'longterm' }).kind,
    'user',
  );
});

test('legacy scheduled sessions: untagged user messages resolve from the [定时] title', () => {
  assert.deepEqual(
    resolveUserMessageOrigin(msg(undefined), { sessionType: 'standard', sessionTitle: '[定时] 每日总结' }),
    { kind: 'schedule', detail: '每日总结' },
  );
});

test('standard sessions: untagged user messages default to the local user', () => {
  assert.equal(resolveUserMessageOrigin(msg(undefined), { sessionType: 'standard' }).kind, 'user');
  assert.equal(resolveUserMessageOrigin(msg({})).kind, 'user');
});
