import test from 'node:test';
import assert from 'node:assert/strict';

const { createMetaBotWallet } = await import('../dist-electron/main/services/metabotWalletService.js');
const { convertToGlobalMetaId, decodeGlobalMetaIdPayload } = await import('../dist-electron/main/services/globalMetaid.js');
const {
  OWNER_BINDING_ALGORITHM,
  OWNER_BINDING_MESSAGE_PREFIX,
  buildOwnerBindingMessage,
  buildOwnerBindingPayload,
  parseOwnerBindingPayload,
  signOwnerBinding,
  verifyOwnerBinding,
} = await import('../dist-electron/main/services/ownerBindingService.js');

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const makeIdentityAndBot = async () => {
  const ownerWallet = await createMetaBotWallet({ mnemonic: TEST_MNEMONIC });
  const botWallet = await createMetaBotWallet({});
  return { ownerWallet, botWallet };
};

test('globalmetaid decode is the inverse of encode (P2PKH payload = address hash160)', async () => {
  const wallet = await createMetaBotWallet({ mnemonic: TEST_MNEMONIC });
  const globalMetaId = convertToGlobalMetaId(wallet.mvc_address);
  const decoded = decodeGlobalMetaIdPayload(globalMetaId);
  assert.ok(decoded);
  assert.equal(decoded.version, 0);
  assert.equal(decoded.payload.length, 20);

  assert.equal(decodeGlobalMetaIdPayload('not-a-globalmetaid'), null);
  assert.equal(decodeGlobalMetaIdPayload(globalMetaId.slice(0, -1) + 'q'), null);
});

test('owner binding sign/verify roundtrip', async () => {
  const { ownerWallet, botWallet } = await makeIdentityAndBot();
  const result = await signOwnerBinding(
    { mnemonic: TEST_MNEMONIC, path: "m/44'/10001'/0'/0/0", globalmetaid: ownerWallet.globalmetaid },
    botWallet.globalmetaid,
  );

  assert.equal(result.signedMessage, `${OWNER_BINDING_MESSAGE_PREFIX}${botWallet.globalmetaid}`);

  const parsed = parseOwnerBindingPayload(result.payload);
  assert.ok(parsed);
  assert.equal(parsed.algorithm, OWNER_BINDING_ALGORITHM);
  assert.equal(parsed.owner, ownerWallet.globalmetaid);
  assert.equal(parsed.ownerPublicKey, ownerWallet.public_key);

  assert.equal(verifyOwnerBinding(result.payload, botWallet.globalmetaid), true);
});

test('verify rejects a signature made for a different bot (replay)', async () => {
  const { ownerWallet, botWallet } = await makeIdentityAndBot();
  const otherBot = await createMetaBotWallet({});
  const result = await signOwnerBinding(
    { mnemonic: TEST_MNEMONIC, globalmetaid: ownerWallet.globalmetaid },
    botWallet.globalmetaid,
  );
  assert.equal(verifyOwnerBinding(result.payload, otherBot.globalmetaid), false);
});

test('verify rejects tampered owner / public key / signature', async () => {
  const { ownerWallet, botWallet } = await makeIdentityAndBot();
  const attacker = await createMetaBotWallet({});
  const result = await signOwnerBinding(
    { mnemonic: TEST_MNEMONIC, globalmetaid: ownerWallet.globalmetaid },
    botWallet.globalmetaid,
  );
  const parsed = parseOwnerBindingPayload(result.payload);

  const tamperedOwner = JSON.stringify({ ...parsed, owner: attacker.globalmetaid });
  assert.equal(verifyOwnerBinding(tamperedOwner, botWallet.globalmetaid), false);

  const tamperedPubkey = JSON.stringify({ ...parsed, ownerPublicKey: attacker.public_key });
  assert.equal(verifyOwnerBinding(tamperedPubkey, botWallet.globalmetaid), false);

  const otherSig = await signOwnerBinding(
    { mnemonic: TEST_MNEMONIC, globalmetaid: ownerWallet.globalmetaid },
    attacker.globalmetaid,
  );
  const otherParsed = parseOwnerBindingPayload(otherSig.payload);
  const tamperedSignature = JSON.stringify({ ...parsed, signature: otherParsed.signature });
  assert.equal(verifyOwnerBinding(tamperedSignature, botWallet.globalmetaid), false);
});

test('verify rejects malformed payloads', async () => {
  const { botWallet } = await makeIdentityAndBot();
  assert.equal(verifyOwnerBinding('not json', botWallet.globalmetaid), false);
  assert.equal(verifyOwnerBinding('{}', botWallet.globalmetaid), false);
  assert.equal(verifyOwnerBinding(null, botWallet.globalmetaid), false);
  assert.equal(
    verifyOwnerBinding(
      JSON.stringify({ version: 2, owner: 'x', ownerPublicKey: 'x', signedMessage: 'x', signature: 'x', algorithm: OWNER_BINDING_ALGORITHM }),
      botWallet.globalmetaid,
    ),
    false,
  );
});

test('buildOwnerBindingMessage normalizes case and whitespace', () => {
  assert.equal(
    buildOwnerBindingMessage('  IDQ1ABC '),
    `${OWNER_BINDING_MESSAGE_PREFIX}idq1abc`,
  );
  assert.equal(buildOwnerBindingMessage(''), OWNER_BINDING_MESSAGE_PREFIX);
});

test('buildOwnerBindingPayload + parse roundtrip', () => {
  const payload = buildOwnerBindingPayload({
    ownerGlobalMetaId: 'IDQ1OWNER ',
    ownerPublicKey: '02aa',
    botGlobalMetaId: 'idq1bot',
    signature: 'c2ln',
  });
  assert.deepEqual(parseOwnerBindingPayload(payload), {
    version: 1,
    owner: 'idq1owner',
    ownerPublicKey: '02aa',
    signedMessage: `${OWNER_BINDING_MESSAGE_PREFIX}idq1bot`,
    signature: 'c2ln',
    algorithm: OWNER_BINDING_ALGORITHM,
  });
});
