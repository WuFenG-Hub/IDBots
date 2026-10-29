/**
 * Send-side gate for the A2A auto-reply toggle (2026-10-29).
 *
 * With a2a_auto_reply_enabled=0 the bot no longer answers peer DMs (commit 1
 * renders them instead). Firing conversational DMs from such a bot would only
 * harvest replies the same toggle then suppresses locally, so the toggle
 * gates the whole A2A private-chat send capability. These tests pin the
 * block-reason helper the two send surfaces (send_private_chat tool control
 * and botBrowser:sendPrivateChat IPC) both consult.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  describeA2APrivateChatSendBlock,
  normalizeA2AAutoReplyEnabled,
} = await import('../dist-electron/main/services/a2aChatLimits.js');

test('toggle off blocks sends with a reason naming the toggle; every default-on form allows', () => {
  const blocked = describeA2APrivateChatSendBlock({ name: 'AI_Sunny', a2a_auto_reply_enabled: 0 });
  assert.match(blocked, /AI_Sunny/);
  assert.match(blocked, /A2A auto-reply/, 'reason must name the toggle');
  assert.match(blocked, /Chat settings/, 'reason must point at where to re-enable');

  for (const value of [1, true, null, undefined]) {
    assert.equal(
      describeA2APrivateChatSendBlock({ name: 'b', a2a_auto_reply_enabled: value }),
      null,
      `value ${value} must allow sends`,
    );
  }
  // Missing bot record (unknown metabot id) must not lock the door silently.
  assert.equal(describeA2APrivateChatSendBlock(null), null);
  assert.equal(describeA2APrivateChatSendBlock(undefined), null);
  // Nameless bots still get a readable block reason.
  assert.match(
    describeA2APrivateChatSendBlock({ a2a_auto_reply_enabled: 0 }),
    /This MetaBot/,
  );
  // The gate agrees with the receive-side normalizer by construction.
  assert.equal(describeA2APrivateChatSendBlock({ a2a_auto_reply_enabled: 0 }) !== null, !normalizeA2AAutoReplyEnabled(0));
});

test('both conversational send surfaces consult the gate (source pin)', () => {
  const mainSource = readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.ts'), 'utf8');
  const controlSite = mainSource.indexOf('const sendBlock = describeA2APrivateChatSendBlock(metabotStore.getMetabotById(metabotId));');
  assert.ok(controlSite > 0, 'send_private_chat control gate missing');
  // The gate must throw BEFORE the wallet/chatpubkey work (no chain spend).
  const walletLine = mainSource.indexOf('getMetabotWalletByMetabotId(metabotId)', controlSite);
  assert.ok(walletLine > controlSite);
  assert.ok(mainSource.includes('const browserSendBlock = describeA2APrivateChatSendBlock(metabot);'), 'botBrowser send gate missing');
  // Transactional protocol senders stay un-gated on purpose.
  const kickWiring = mainSource.indexOf('setGroupTaskServiceTransport');
  assert.ok(kickWiring > 0);
  assert.equal(
    mainSource.slice(kickWiring, kickWiring + 600).includes('describeA2APrivateChatSendBlock'),
    false,
    'OpenTeam/order transport sends must not be gated',
  );
});
