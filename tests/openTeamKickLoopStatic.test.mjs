import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Static wiring guards for the M3 kick loop closure (batch 3): main.ts cannot
 * be imported in node:test, so these assert the wiring/gate structure directly
 * in the sources (same pattern as appUpdateSilentFlowStatic.test.mjs).
 */

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('openTeamCollab:listMessages is gated on a local OpenTeam membership', () => {
  const main = read('src/main/main.ts');
  const handlerAt = main.indexOf("ipcMain.handle('openTeamCollab:listMessages'");
  assert.ok(handlerAt > -1, 'listMessages handler exists');
  const nextHandlerAt = main.indexOf('ipcMain.handle(', handlerAt + 1);
  const body = main.slice(handlerAt, nextHandlerAt > -1 ? nextHandlerAt : undefined);
  assert.match(body, /hasMembershipForGroup\(groupId\)/, 'membership gate runs inside the handler');
  assert.match(body, /No OpenTeam membership for this group/, 'non-membership group ids are rejected');
});

test('openTeamMembershipStore exposes the hasMembershipForGroup gate', () => {
  const store = read('src/main/openTeamMembershipStore.ts');
  assert.match(store, /hasMembershipForGroup\(groupId: string\): boolean/);
});

test('groupTaskService kick wiring: member-list re-check + kick notification seams wired in main.ts', () => {
  const main = read('src/main/main.ts');
  assert.match(
    main,
    /setGroupTaskServiceTransport\(\{[^}]*fetchGroupMembers[^}]*sendEncryptedSimplemsg[^}]*\}\)/s,
    'main.ts wires fetchGroupMembers + sendEncryptedSimplemsg into groupTaskService',
  );
  const guestDaemonAt = main.indexOf('startOpenTeamGuestDaemon({');
  assert.ok(guestDaemonAt > -1);
  const guestBlock = main.slice(guestDaemonAt, main.indexOf('});', guestDaemonAt));
  assert.match(guestBlock, /fetchGroupMembers/, 'guest daemon gets the membership self-check seam');
});

test('attribution resolver: transient failures throw (retry path), only definitive misses return null', () => {
  const main = read('src/main/main.ts');
  const resolverAt = main.indexOf('resolveGlobalMetaId: (() =>');
  assert.ok(resolverAt > -1, 'resolver wiring exists');
  const block = main.slice(resolverAt, resolverAt + 2000);
  assert.match(block, /response\.status === 404/, 'HTTP 404 is the definitive miss');
  assert.match(block, /throw new Error\(`manapi metaid resolution failed with HTTP \$\{response\.status\}`\)/,
    'non-404 failures throw into the bounded retry path');
  assert.ok(!/catch\s*\{[^}]*cache\.set\(key, null\)/s.test(block), 'transient errors are no longer swallowed+cached as null');
});

test('kick confirm modal carries an optional English reason input wired to the kick call', () => {
  const modal = read('src/renderer/components/groupTasks/GroupTaskKickConfirmModal.tsx');
  assert.match(modal, /placeholder="Reason for removal \(optional\)"/, 'English placeholder');
  assert.match(modal, /onReasonChange/, 'reason state flows through the modal');

  const detail = read('src/renderer/components/groupTasks/GroupTaskDetailView.tsx');
  assert.match(detail, /reason:\s*reason \|\| undefined/, 'reason passed to kickMember');
  assert.match(detail, /kickChainConfirmPending/, 'chainRemovalConfirmed=false surfaces a warning toast');
  assert.match(detail, /groupTasksKickChainConfirmPending/, 'toast copy key used');
});

test('OpenTeamCollabsSection polls every 15s and clears the interval on unmount', () => {
  const section = read('src/renderer/components/groupTasks/OpenTeamCollabsSection.tsx');
  assert.match(section, /OPEN_TEAM_COLLAB_POLL_INTERVAL_MS\s*=\s*15_000/, '15s poll cadence');
  assert.match(section, /setInterval\(load, OPEN_TEAM_COLLAB_POLL_INTERVAL_MS\)/, 'interval set on mount');
  assert.match(section, /clearInterval\(timer\)/, 'interval cleared on unmount');
});
