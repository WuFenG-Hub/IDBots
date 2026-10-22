import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { signup } from '../src/services/signup.js';
import { freshDb, insertInvite, MASTER_KEY, TENANT_DEFAULTS } from './helpers.js';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const baseInput = (overrides: Record<string, unknown> = {}) => ({
  phone: '+8613900000100',
  displayName: 'Ada',
  locale: 'zh',
  now: NOW,
  tenantDefaults: TENANT_DEFAULTS,
  masterKey: MASTER_KEY,
  ...overrides,
});

describe('sign-up invite consumption', () => {
  test('a valid first sign-up consumes exactly one invite use', () => {
    const db = freshDb();
    insertInvite(db, { code: 'WELCOME-1', maxUses: 3, now: NOW });

    const result = signup(db, baseInput({ inviteCode: 'WELCOME-1' }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.isNewUser, true);
    assert.equal(result.inviteConsumed, true);
    assert.equal(result.user.display_name, 'Ada');
    assert.equal(result.user.invite_code, 'WELCOME-1');
    assert.equal(result.tenant?.status, 'provisioning');

    const invite = db.prepare('SELECT used_count FROM invites WHERE code = ?').get('WELCOME-1') as {
      used_count: number;
    };
    assert.equal(invite.used_count, 1);
  });

  test('missing invite for an unknown phone -> INVITE_REQUIRED', () => {
    const db = freshDb();
    const result = signup(db, baseInput());
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'INVITE_REQUIRED');
  });

  test('unknown invite -> INVITE_INVALID', () => {
    const db = freshDb();
    const result = signup(db, baseInput({ inviteCode: 'NOPE-123' }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'INVITE_INVALID');
  });

  test('disabled invite -> INVITE_INVALID', () => {
    const db = freshDb();
    insertInvite(db, { code: 'DISABLED-1', maxUses: 5, disabled: 1, now: NOW });
    const result = signup(db, baseInput({ inviteCode: 'DISABLED-1' }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'INVITE_INVALID');
  });

  test('expired invite -> INVITE_INVALID', () => {
    const db = freshDb();
    insertInvite(db, { code: 'EXPIRED-1', maxUses: 5, expiresAt: NOW - 1, now: NOW - 2 * HOUR });
    const result = signup(db, baseInput({ inviteCode: 'EXPIRED-1' }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'INVITE_INVALID');
  });

  test('exhausted invite -> INVITE_EXHAUSTED', () => {
    const db = freshDb();
    insertInvite(db, { code: 'USED-UP-1', maxUses: 1, usedCount: 1, now: NOW });
    const result = signup(db, baseInput({ inviteCode: 'USED-UP-1' }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'INVITE_EXHAUSTED');
  });

  test('existing user signs in without an invite and consumes nothing', () => {
    const db = freshDb();
    insertInvite(db, { code: 'SECOND-1', maxUses: 5, now: NOW });
    const first = signup(db, baseInput({ inviteCode: 'SECOND-1' }));
    assert.equal(first.ok, true);

    const second = signup(db, baseInput({ phone: '+8613900000100' }));
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.isNewUser, false);
    assert.equal(second.inviteConsumed, false);
    assert.equal(second.user.id, first.ok ? first.user.id : 'unreachable');

    const invite = db.prepare('SELECT used_count FROM invites WHERE code = ?').get('SECOND-1') as {
      used_count: number;
    };
    assert.equal(invite.used_count, 1);
  });

  test('disabled existing user -> USER_DISABLED', () => {
    const db = freshDb();
    insertInvite(db, { code: 'BAN-1', maxUses: 5, now: NOW });
    const first = signup(db, baseInput({ inviteCode: 'BAN-1' }));
    assert.equal(first.ok, true);
    if (!first.ok) return;
    db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(first.user.id);

    const second = signup(db, baseInput({}));
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.equal(second.code, 'USER_DISABLED');
  });

  test('concurrent sign-ups racing one remaining invite use: exactly one succeeds', async () => {
    const db = freshDb();
    insertInvite(db, { code: 'RACE-1', maxUses: 1, now: NOW });
    const phones = ['+8613900000201', '+8613900000202', '+8613900000203', '+8613900000204', '+8613900000205'];

    const results = await Promise.all(
      phones.map((phone) => Promise.resolve().then(() => signup(db, baseInput({ phone, inviteCode: 'RACE-1' })))),
    );
    const succeeded = results.filter((r) => r.ok);
    const exhausted = results.filter((r) => !r.ok && r.code === 'INVITE_EXHAUSTED');
    assert.equal(succeeded.length, 1);
    assert.equal(exhausted.length, phones.length - 1);

    const invite = db.prepare('SELECT used_count FROM invites WHERE code = ?').get('RACE-1') as {
      used_count: number;
    };
    assert.equal(invite.used_count, 1);
    const userCount = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
    assert.equal(userCount, 1);
  });
});
