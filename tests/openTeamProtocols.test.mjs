import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  buildOpenTeamInviteMessage,
  buildOpenTeamAcceptMessage,
  buildOpenTeamDeclineMessage,
  parseOpenTeamEnvelope,
} = require('../dist-electron/main/services/openTeamProtocols.js');

const TXID = 'a'.repeat(64);
const INVITE_ID = `${TXID}i0`;
const GROUP_ID = `${'b'.repeat(64)}i0`;
const JOINED_PIN_ID = `${'c'.repeat(64)}i0`;

const sampleInvite = () => ({
  v: 1,
  inviteId: INVITE_ID,
  groupId: GROUP_ID,
  taskTitle: 'Build a landing page',
  goalSummary: 'Ship a one-pager for the launch',
  requiredSkills: ['web-search', 'frontend'],
  inviterGlobalMetaId: 'gmid-inviter',
  inviterName: 'Twin Bot',
  chairGlobalMetaId: 'gmid-chair',
  targetGlobalMetaId: 'gmid-guest',
  expiresAt: 1_893_456_000,
});

test('invite envelope round-trips through build/parse', () => {
  const message = buildOpenTeamInviteMessage(sampleInvite());
  assert.ok(message.startsWith('[OPENTEAM_INVITE] '));
  const parsed = parseOpenTeamEnvelope(message);
  assert.deepEqual(parsed, { kind: 'invite', invite: sampleInvite() });
});

test('accept envelope round-trips through build/parse', () => {
  const message = buildOpenTeamAcceptMessage(INVITE_ID, JOINED_PIN_ID);
  assert.equal(
    message,
    `[OPENTEAM_ACCEPT:${INVITE_ID}] {"joinedPinId":"${JOINED_PIN_ID}"}`,
  );
  const parsed = parseOpenTeamEnvelope(message);
  assert.deepEqual(parsed, { kind: 'accept', inviteId: INVITE_ID, joinedPinId: JOINED_PIN_ID });
});

test('decline envelope round-trips through build/parse (reason kept verbatim)', () => {
  const message = buildOpenTeamDeclineMessage(INVITE_ID, 'remote_collab_disabled: switch is off');
  assert.equal(message, `[OPENTEAM_DECLINE:${INVITE_ID}] remote_collab_disabled: switch is off`);
  const parsed = parseOpenTeamEnvelope(message);
  assert.deepEqual(parsed, {
    kind: 'decline',
    inviteId: INVITE_ID,
    reason: 'remote_collab_disabled: switch is off',
  });
});

test('decline with empty reason still parses', () => {
  const parsed = parseOpenTeamEnvelope(buildOpenTeamDeclineMessage(INVITE_ID, ''));
  assert.deepEqual(parsed, { kind: 'decline', inviteId: INVITE_ID, reason: '' });
});

test('uppercase hex inviteId in tag is normalized to lowercase', () => {
  const upperInviteId = INVITE_ID.toUpperCase().replace('I0', 'i0'); // hex upper, i0 marker lower
  const parsed = parseOpenTeamEnvelope(
    `[OPENTEAM_ACCEPT:${upperInviteId}] {"joinedPinId":"${JOINED_PIN_ID}"}`,
  );
  assert.deepEqual(parsed, { kind: 'accept', inviteId: INVITE_ID, joinedPinId: JOINED_PIN_ID });
});

test('parser tolerates leading/trailing whitespace', () => {
  const parsed = parseOpenTeamEnvelope(`  \n${buildOpenTeamAcceptMessage(INVITE_ID, JOINED_PIN_ID)}\n`);
  assert.deepEqual(parsed, { kind: 'accept', inviteId: INVITE_ID, joinedPinId: JOINED_PIN_ID });
});

test('non-OpenTeam plaintext returns null', () => {
  for (const content of [
    'hello there',
    '[ORDER:abc] {}',
    '[FOO] {"v":1}',
    '[OPENTEAM_INVITE', // truncated tag
    `[OPENTEAM_ACCEPT:not-a-pinid] {"joinedPinId":"${JOINED_PIN_ID}"}`,
    `[OPENTEAM_ACCEPT] {"joinedPinId":"${JOINED_PIN_ID}"}`, // accept without :inviteId
    `[OPENTEAM_ACCEPT:${INVITE_ID}]`, // accept without JSON body
    `[OPENTEAM_ACCEPT:${INVITE_ID}] not-json`,
    `[OPENTEAM_ACCEPT:${INVITE_ID}] {"joinedPinId":""}`,
    '[OPENTEAM_DECLINE] missing inviteId',
  ]) {
    assert.equal(parseOpenTeamEnvelope(content), null, JSON.stringify(content));
  }
});

test('malformed invite payloads return null', () => {
  const good = sampleInvite();
  const cases = [
    '[OPENTEAM_INVITE]', // no JSON
    '[OPENTEAM_INVITE] not-json',
    '[OPENTEAM_INVITE] [1,2,3]',
    { ...good, v: 2 },
    { ...good, inviteId: 'not-a-pinid' },
    { ...good, groupId: '' },
    { ...good, inviterGlobalMetaId: '' },
    { ...good, targetGlobalMetaId: '' },
    { ...good, expiresAt: 0 },
    { ...good, expiresAt: 'soon' },
  ];
  for (const payload of cases) {
    const content = typeof payload === 'string' ? payload : `[OPENTEAM_INVITE] ${JSON.stringify(payload)}`;
    assert.equal(parseOpenTeamEnvelope(content), null, content);
  }
});

test('invite payload tolerates missing optional fields', () => {
  const minimal = {
    v: 1,
    inviteId: INVITE_ID,
    groupId: GROUP_ID,
    inviterGlobalMetaId: 'gmid-inviter',
    targetGlobalMetaId: 'gmid-guest',
    expiresAt: 1_893_456_000,
  };
  const parsed = parseOpenTeamEnvelope(`[OPENTEAM_INVITE] ${JSON.stringify(minimal)}`);
  assert.deepEqual(parsed, {
    kind: 'invite',
    invite: {
      ...minimal,
      taskTitle: '',
      goalSummary: '',
      requiredSkills: [],
      inviterName: '',
      chairGlobalMetaId: '',
    },
  });
});

test('requiredSkills filters non-string entries', () => {
  const payload = { ...sampleInvite(), requiredSkills: ['search', 42, null, '  ', 'write'] };
  const parsed = parseOpenTeamEnvelope(`[OPENTEAM_INVITE] ${JSON.stringify(payload)}`);
  assert.deepEqual(parsed?.invite?.requiredSkills, ['search', 'write']);
});
