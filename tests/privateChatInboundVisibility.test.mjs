/**
 * Visibility-first inbound handling (2026-10-29 kiop incident).
 *
 * Live failure shape: AI_Sunny's a2a_auto_reply_enabled was 0 and a long
 * sibling turn blocked the poll queue, so a peer burst (two messages) was
 * dropped twice over — the older row by the "stale, newer queued" skip and
 * the newer row by the auto_reply_disabled exit. Both exits used to run
 * BEFORE the inbound append, so the peer's messages never appeared in any
 * session while is_processed flipped to 1. These tests pin the new contract:
 *
 *   1. the stale-skip and the auto-reply-declined exit both live AFTER the
 *      inbound append (render first, skip only the reply);
 *   2. the inbound append stamps renderer-facing markers
 *      (autoReplySuppressed / a2aAutoReplyActive) on every processed bubble;
 *   3. the old drop-only log lines are gone;
 *   4. every no-reply policy reason gets a plain-language system notice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonSourcePath = path.join(__dirname, '..', 'src', 'main', 'services', 'privateChatDaemon.ts');
const daemonSource = readFileSync(daemonSourcePath, 'utf8');

const {
  buildAutoReplySuppressedNotice,
} = await import('../dist-electron/main/services/privateChatDaemon.js');

test('stale rows are rendered before the no-reply exit (source order pin)', () => {
  const appendSite = daemonSource.indexOf('}) ?? appendPrivateChatA2AMessage({');
  assert.ok(appendSite > 0, 'inbound append site not found');
  const staleExit = daemonSource.indexOf('Stored stale message ${row.id} without reply');
  assert.ok(staleExit > appendSite, 'stale-suppression exit must run after the inbound append');
  const policyExit = daemonSource.indexOf('(reason: ${autoReplyPolicy.reason}); inbound message stored.');
  assert.ok(policyExit > appendSite, 'auto-reply-declined exit must run after the inbound append');
});

test('the old drop-before-render exits are gone', () => {
  assert.ok(
    !daemonSource.includes('Skip stale private chat message'),
    'stale rows must no longer be dropped before rendering',
  );
  assert.ok(
    !daemonSource.includes('[PrivateChat] Auto-reply skipped for ${fromGlobalMetaId.slice(0, 12)}… (reason: ${autoReplyPolicy.reason}).`'),
    'the auto-reply-declined exit must no longer drop the row silently before the append',
  );
});

test('inbound bubbles carry renderer-facing suppression/active markers', () => {
  assert.ok(daemonSource.includes('autoReplySuppressed: true'), 'suppressed marker missing');
  assert.ok(daemonSource.includes('autoReplySuppressedReason: autoReplyPolicy.reason'), 'suppression reason missing');
  assert.ok(daemonSource.includes('a2aAutoReplyActive: true'), 'active marker missing');
});

test('every no-reply policy reason gets a stored-not-answered notice', () => {
  // tApp renders one language per app locale; the test env resolves English.
  for (const reason of ['disabled_metabot', 'auto_reply_disabled', 'stranger_blocked']) {
    const notice = buildAutoReplySuppressedNotice(reason);
    assert.match(notice, /System notice/, `reason ${reason}: notice missing`);
    assert.match(notice, /received and stored/, `reason ${reason}: must state the message was kept`);
  }
  assert.ok(
    buildAutoReplySuppressedNotice('auto_reply_disabled').includes('A2A'),
    'auto_reply_disabled notice must name the toggle',
  );
  // Distinct per reason so the transcript explanation is accurate.
  const notices = new Set(
    ['disabled_metabot', 'auto_reply_disabled', 'stranger_blocked'].map((r) => buildAutoReplySuppressedNotice(r)),
  );
  assert.equal(notices.size, 3);
  // Unknown/false-positive reasons still get a neutral notice, never a throw.
  const fallback = buildAutoReplySuppressedNotice('owner');
  assert.match(fallback, /System notice/);
});

test('session view renders an auto-reply-suppressed banner driven by the message markers', () => {
  const detailPath = path.join(__dirname, '..', 'src', 'renderer', 'components', 'cowork', 'CoworkSessionDetail.tsx');
  const detailSource = readFileSync(detailPath, 'utf8');
  // The banner keys off the same markers the daemon stamps (last marker wins,
  // active clears suppressed), not off metabot settings plumbing.
  assert.ok(detailSource.includes('a2aAutoReplyActive === true'), 'active-marker scan missing');
  assert.ok(detailSource.includes('autoReplySuppressed === true'), 'suppressed-marker scan missing');
  assert.ok(
    detailSource.indexOf('a2aAutoReplyActive === true') < detailSource.indexOf('autoReplySuppressed === true'),
    'active marker must clear before suppressed marker can set (last wins)',
  );
  assert.ok(detailSource.includes("t('coworkA2AAutoReplySuppressedBanner')"), 'banner render missing');

  const i18nPath = path.join(__dirname, '..', 'src', 'renderer', 'services', 'i18n.ts');
  const i18nSource = readFileSync(i18nPath, 'utf8');
  const occurrences = i18nSource.split('coworkA2AAutoReplySuppressedBanner:').length - 1;
  assert.equal(occurrences, 2, 'banner copy must exist in both zh and en dictionaries');
});
