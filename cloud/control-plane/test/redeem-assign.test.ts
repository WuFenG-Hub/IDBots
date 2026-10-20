import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { signup } from '../src/services/signup.js';
import { freshDb, insertInvite, insertRedeemCode, MASTER_KEY, TENANT_DEFAULTS } from './helpers.js';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

const baseInput = (phone: string) => ({
  phone,
  displayName: 'Grace',
  locale: 'en',
  inviteCode: 'REDEEM-1',
  now: NOW,
  tenantDefaults: TENANT_DEFAULTS,
  masterKey: MASTER_KEY,
});

function assignedCodes(db: ReturnType<typeof freshDb>): Array<{ code_hash: string; assigned_user_id: string }> {
  return db
    .prepare('SELECT code_hash, assigned_user_id FROM redeem_codes WHERE assigned_user_id IS NOT NULL')
    .all() as Array<{ code_hash: string; assigned_user_id: string }>;
}

describe('redeem code assignment at sign-up', () => {
  test('N users racing a pool of M<N codes: M assignments, no code twice, the rest flagged', async () => {
    const db = freshDb();
    insertInvite(db, { code: 'REDEEM-1', maxUses: 10, withRedeem: 1, now: NOW });
    insertRedeemCode(db, { codeHash: 'hash-a', importedAt: NOW - 3 * MINUTE });
    insertRedeemCode(db, { codeHash: 'hash-b', importedAt: NOW - 2 * MINUTE });
    insertRedeemCode(db, { codeHash: 'hash-c', importedAt: NOW - MINUTE });

    const phones = ['+8613900000301', '+8613900000302', '+8613900000303', '+8613900000304', '+8613900000305'];
    const results = await Promise.all(
      phones.map((phone) => Promise.resolve().then(() => signup(db, baseInput(phone)))),
    );

    const succeeded = results.filter((r) => r.ok);
    assert.equal(succeeded.length, phones.length);
    const claimed = succeeded.filter((r) => r.ok && r.redeemCodeClaimed);
    const unclaimed = succeeded.filter((r) => r.ok && !r.redeemCodeClaimed);
    assert.equal(claimed.length, 3);
    assert.equal(unclaimed.length, phones.length - 3);

    const assignments = assignedCodes(db);
    assert.equal(assignments.length, 3);
    const hashes = assignments.map((row) => row.code_hash);
    assert.equal(new Set(hashes).size, hashes.length, 'no code assigned twice');
    const users = assignments.map((row) => row.assigned_user_id);
    assert.equal(new Set(users).size, users.length, 'no user holds two codes');
  });

  test('oldest imported code is claimed first', () => {
    const db = freshDb();
    insertInvite(db, { code: 'REDEEM-1', maxUses: 10, withRedeem: 1, now: NOW });
    insertRedeemCode(db, { codeHash: 'hash-new', importedAt: NOW - MINUTE });
    insertRedeemCode(db, { codeHash: 'hash-old', importedAt: NOW - 5 * MINUTE });

    const result = signup(db, baseInput('+8613900000310'));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.redeemCodeClaimed, true);
    const row = db
      .prepare('SELECT code_hash FROM redeem_codes WHERE assigned_user_id = ?')
      .get(result.user.id) as { code_hash: string };
    assert.equal(row.code_hash, 'hash-old');
  });

  test('empty pool: sign-up proceeds with the warn/alert flag', () => {
    const db = freshDb();
    insertInvite(db, { code: 'REDEEM-1', maxUses: 10, withRedeem: 1, now: NOW });

    const result = signup(db, baseInput('+8613900000320'));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.redeemCodeClaimed, false);
    assert.equal(result.tenant?.status, 'provisioning');
    assert.equal(assignedCodes(db).length, 0);
  });

  test('invites without with_redeem never claim a code', () => {
    const db = freshDb();
    insertInvite(db, { code: 'REDEEM-1', maxUses: 10, withRedeem: 0, now: NOW });
    insertRedeemCode(db, { codeHash: 'hash-a', importedAt: NOW });

    const result = signup(db, baseInput('+8613900000330'));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.redeemCodeClaimed, false);
    assert.equal(assignedCodes(db).length, 0);
  });

  test('a repeat sign-up of the same user never takes a second code', async () => {
    const db = freshDb();
    insertInvite(db, { code: 'REDEEM-1', maxUses: 10, withRedeem: 1, now: NOW });
    insertRedeemCode(db, { codeHash: 'hash-a', importedAt: NOW });

    const first = signup(db, baseInput('+8613900000340'));
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.redeemCodeClaimed, true);

    const again = await Promise.resolve().then(() =>
      signup(db, { ...baseInput('+8613900000340'), inviteCode: null }),
    );
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(again.isNewUser, false);
    assert.equal(again.redeemCodeClaimed, false);
    assert.equal(assignedCodes(db).length, 1);
  });
});
