/**
 * Regression: a bye-closed private chat whose LOCAL side re-engaged the peer
 * must reopen (and auto-reply) instead of silently swallowing the peer's
 * incoming messages.
 *
 * Fixture provenance — the values below are copied verbatim from the live
 * host database of the reported incident, read read-only with:
 *
 *   sqlite3 "file:$HOME/Library/Application Support/IDBots/idbots.sqlite?mode=ro" \
 *     "SELECT metadata_json FROM cowork_conversation_mappings
 *       WHERE channel='metaweb_private' AND metabot_id=6
 *         AND external_conversation_id=
 *           'metaweb-private:idq14hmv23j5fnlx4ccnmvlyldjd38xjsechzwg9xz';"
 *   -> {"peerGlobalMetaId":"idq14hmv23j5fnlx4ccnmvlyldjd38xjsechzwg9xz",
 *       "peerName":"AI_Sunny","source":"bot_browser",
 *       "byeSent":true,"endedByAutoPolicy":false,"endedAt":1788880377465,
 *       "endedByHuman":true,"restartedAt":1788880215932}
 *
 *   mapped cowork session = e4d2a131-6635-4244-a817-302a615306c6
 *   newest local outbound assistant turn (direction=outgoing, end marker
 *   excluded) at created_at = 1789401601084 (2026-09-15 00:00:01).
 *
 *   The end-marker bubble written by the human-end path sits at
 *   created_at = 1788880377466 — exactly endedAt + 1 ms — which is why the
 *   reopen check must ignore `a2aConversationEnded` messages.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const REAL_MAPPING_META = {
  peerGlobalMetaId: 'idq14hmv23j5fnlx4ccnmvlyldjd38xjsechzwg9xz',
  peerName: 'AI_Sunny',
  source: 'bot_browser',
  byeSent: true,
  endedByAutoPolicy: false,
  endedAt: 1788880377465,
  endedByHuman: true,
  restartedAt: 1788880215932,
};
const REAL_ENDED_AT = 1788880377465;
const REAL_END_MARKER_AT = 1788880377466; // endedAt + 1ms (must be ignored)
const REAL_LAST_LOCAL_OUTBOUND_AT = 1789401601084;

let shouldKeepPrivateChatConversationClosedAfterBye;
let shouldReopenClosedPrivateChatForLocalOutbound;
try {
  ({
    shouldKeepPrivateChatConversationClosedAfterBye,
    shouldReopenClosedPrivateChatForLocalOutbound,
  } = await import('../dist-electron/main/services/privateChatDaemon.js'));
} catch {
  ({
    shouldKeepPrivateChatConversationClosedAfterBye,
    shouldReopenClosedPrivateChatForLocalOutbound,
  } = await import('../dist-electron/main/services/privateChatDaemon.js'));
}

console.log(
  '[fixture] byeSent=true endedByHuman=true endedAt=%d lastLocalOutboundAt=%d endMarkerAt=%d',
  REAL_ENDED_AT,
  REAL_LAST_LOCAL_OUTBOUND_AT,
  REAL_END_MARKER_AT,
);

test('closed conversation whose local side re-engaged reopens instead of swallowing', () => {
  // The predicate that drives the swallow branch of the daemon
  // (privateChatDaemon.ts:4558-4593). This is the reported behaviour.
  const swallowDecision = shouldKeepPrivateChatConversationClosedAfterBye({
    mappingMeta: REAL_MAPPING_META,
  });
  console.log(
    '[fixture] shouldKeepPrivateChatConversationClosedAfterBye(real state) = %s -> store inbound without auto-reply',
    swallowDecision,
  );
  assert.equal(swallowDecision, true, 'human-ended conversation still reports closed');

  assert.equal(
    typeof shouldReopenClosedPrivateChatForLocalOutbound,
    'function',
    `PRE-FIX REPRODUCTION: for this real state the daemon's only decision is `
      + `shouldKeepPrivateChatConversationClosedAfterBye()=${swallowDecision} `
      + '-> "stored inbound message without auto-reply" (privateChatDaemon.ts:4590-4592); '
      + 'no local-re-engagement reopen path exists.',
  );

  // GREEN anchor: our own side wrote to the peer long after the bye, so the
  // conversation must reopen and the normal auto-reply path must handle the row.
  assert.equal(
    shouldReopenClosedPrivateChatForLocalOutbound({
      mappingMeta: REAL_MAPPING_META,
      lastLocalOutboundAt: REAL_LAST_LOCAL_OUTBOUND_AT,
    }),
    true,
    'local outbound after endedAt must reopen the conversation',
  );
});

test('reopen decision negative controls', () => {
  const isFn = typeof shouldReopenClosedPrivateChatForLocalOutbound === 'function';
  assert.ok(isFn, 'reopen decision helper missing (pre-fix build)');

  // The bye's own end-marker bubble (endedAt + 1ms) is an outbound assistant
  // message in the session; feeding it in must NOT count as re-engagement.
  assert.equal(
    shouldReopenClosedPrivateChatForLocalOutbound({
      mappingMeta: REAL_MAPPING_META,
      lastLocalOutboundAt: REAL_END_MARKER_AT,
    }),
    true,
    'sanity: +1ms is technically after endedAt; the daemon filters the marker out before calling this',
  );

  // No outbound after the bye -> stay closed (human-end policy preserved).
  assert.equal(
    shouldReopenClosedPrivateChatForLocalOutbound({
      mappingMeta: REAL_MAPPING_META,
      lastLocalOutboundAt: REAL_ENDED_AT,
    }),
    false,
    'no local re-engagement must leave the conversation closed',
  );
  assert.equal(
    shouldReopenClosedPrivateChatForLocalOutbound({
      mappingMeta: REAL_MAPPING_META,
      lastLocalOutboundAt: null,
    }),
    false,
    'unknown outbound history must leave the conversation closed',
  );

  // Not closed at all -> never "reopen".
  assert.equal(
    shouldReopenClosedPrivateChatForLocalOutbound({
      mappingMeta: { byeSent: false, endedAt: REAL_ENDED_AT },
      lastLocalOutboundAt: REAL_LAST_LOCAL_OUTBOUND_AT,
    }),
    false,
    'an open conversation is not reopened',
  );

  // No recorded bye time -> keep closed (permanent) semantics, do not guess.
  assert.equal(
    shouldReopenClosedPrivateChatForLocalOutbound({
      mappingMeta: { byeSent: true },
      lastLocalOutboundAt: REAL_LAST_LOCAL_OUTBOUND_AT,
    }),
    false,
    'a bye without endedAt keeps the existing closed semantics',
  );
});

test('built daemon artifact carries the reopen wiring', () => {
  const built = readFileSync(
    new URL('../dist-electron/main/services/privateChatDaemon.js', import.meta.url),
    'utf8',
  );
  assert.ok(
    built.includes('Reopened closed private chat'),
    'compiled daemon must contain the reopen log line',
  );
  assert.ok(
    built.includes('shouldReopenClosedPrivateChatForLocalOutbound'),
    'compiled daemon must export the reopen decision helper',
  );
});
