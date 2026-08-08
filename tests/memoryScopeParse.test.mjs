import test from 'node:test';
import assert from 'node:assert/strict';

const { parseContactScopeKey } = await import('../dist-electron/main/memory/memoryScope.js');

test('parseContactScopeKey extracts channel and peer id from a contact scope key', () => {
  const parsed = parseContactScopeKey('metaweb_private:peer:idq123abc');
  assert.deepEqual(parsed, {
    sourceChannel: 'metaweb_private',
    peerGlobalMetaId: 'idq123abc',
  });
});

test('parseContactScopeKey preserves peer id casing', () => {
  const parsed = parseContactScopeKey('metaweb_private:peer:IDQ-ABC');
  assert.equal(parsed.peerGlobalMetaId, 'IDQ-ABC');
  assert.equal(parsed.sourceChannel, 'metaweb_private');
});

test('parseContactScopeKey rejects keys that are not contact-shaped', () => {
  assert.equal(parseContactScopeKey('owner:self'), null);
  assert.equal(parseContactScopeKey('metaweb_order:conversation:order-1'), null);
  assert.equal(parseContactScopeKey(':peer:idq123'), null);
  assert.equal(parseContactScopeKey(''), null);
  assert.equal(parseContactScopeKey(null), null);
  assert.equal(parseContactScopeKey(undefined), null);
});

test('parseContactScopeKey handles peer ids that themselves contain colons', () => {
  const parsed = parseContactScopeKey('metaweb_private:peer:idq:abc:def');
  assert.equal(parsed.peerGlobalMetaId, 'idq:abc:def');
  assert.equal(parsed.sourceChannel, 'metaweb_private');
});
