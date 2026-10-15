/**
 * RRSI evolution P5 (design §6.5 P5.1): the pure instance-marker detector —
 * pin ids, txids, GlobalMetaIDs, UUIDs, ISO dates — plus scope normalization
 * and the compact marker rendering shown to the reconciliation panel.
 *
 * Covers:
 *   1. detection vectors — each kind, boundaries (CJK neighbors, 63/66 hex),
 *      a pin's hex part never double-counted as a txid, case-insensitive with
 *      lowercased values, ordering by first occurrence, duplicate removal,
 *   2. titleHasHardInstanceMarker,
 *   3. formatInstanceMarkers — labels, short forms, the maxShown overflow,
 *   4. normalizeCapabilityScope.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);

const {
  detectInstanceMarkers,
  titleHasHardInstanceMarker,
  formatInstanceMarkers,
  normalizeCapabilityScope,
} = require('../dist-electron/main/libs/capabilitySpecificity.js');

const PIN = '3f225f43dde31ed107fdaf6c49ed9eba4bfa60ddd563186e5abc0fbabb5495edi0';
const TX = '5d45547839dacb7d1872fb5e9f4d821a7cc46d433141b0f458c1ae5553691c8a';
const GM = 'idq14hmv23j5fnlx4ccnmvlyldjd38xjsechzwg9xz';
const HEX_63 = '5d45547839dacb7d1872fb5e9f4d821a7cc46d433141b0f458c1ae5553691c';
const HEX_66 = '5d45547839dacb7d1872fb5e9f4d821a7cc46d433141b0f458c1ae5553691c8a0d';
const UUID = '123e4567-e89b-12d3-a456-426614174000';

test('detects a pin id and never reports its hex part as a txid', () => {
  assert.deepEqual(detectInstanceMarkers(`引用 ${PIN}`), [{ kind: 'pin', value: PIN }]);
});

test('txid requires exactly 64 hex chars at word boundaries', () => {
  assert.deepEqual(detectInstanceMarkers(TX), [{ kind: 'txid', value: TX }]);
  assert.deepEqual(detectInstanceMarkers(HEX_63), []);
  assert.deepEqual(detectInstanceMarkers(HEX_66), []);
});

test('globalmetaid needs the idq1 prefix and at least 20 more chars', () => {
  assert.deepEqual(detectInstanceMarkers(GM), [{ kind: 'globalmetaid', value: GM }]);
  assert.deepEqual(detectInstanceMarkers('idq1short'), []);
});

test('uuid matches the canonical 8-4-4-4-12 hex shape', () => {
  assert.deepEqual(detectInstanceMarkers(UUID), [{ kind: 'uuid', value: UUID.toLowerCase() }]);
});

test('an ISO date matches with CJK neighbors as boundaries', () => {
  assert.deepEqual(detectInstanceMarkers('在2026-08-02交付'), [{ kind: 'date', value: '2026-08-02' }]);
});

test('detection is case-insensitive and lowercases values (dates excepted)', () => {
  assert.deepEqual(detectInstanceMarkers(PIN.toUpperCase()), [{ kind: 'pin', value: PIN }]);
});

test('mixed text: kinds ordered by first occurrence, duplicates removed', () => {
  const mixed = `给 ${GM} 的订单 ${TX} 在 2026-08-02,再看 ${TX}`;
  assert.deepEqual(
    detectInstanceMarkers(mixed).map((marker) => marker.kind),
    ['globalmetaid', 'txid', 'date'],
  );
});

test('plain lessons carry no markers; a marker in the title is hard', () => {
  assert.deepEqual(detectInstanceMarkers('先验证再交付'), []);
  assert.equal(titleHasHardInstanceMarker(`给 ${GM} 先发预览`), true);
});

test('formatInstanceMarkers: labels, short forms, overflow, empty', () => {
  const mixed = `给 ${GM} 的订单 ${TX} 在 2026-08-02,再看 ${TX}`;
  assert.equal(
    formatInstanceMarkers(detectInstanceMarkers(mixed)),
    'GlobalMetaID idq14hmv23…;txid 5d455478…;日期 2026-08-02',
  );
  assert.equal(formatInstanceMarkers([]), '无');
  const dates = Array.from({ length: 8 }, (_, index) => ({
    kind: 'date',
    value: `2026-01-0${index + 1}`,
  }));
  assert.equal(
    formatInstanceMarkers(dates, 6),
    '日期 2026-01-01;日期 2026-01-02;日期 2026-01-03;日期 2026-01-04;日期 2026-01-05;日期 2026-01-06;等 8 个',
  );
  assert.equal(
    formatInstanceMarkers(detectInstanceMarkers(`引用 ${PIN}`)),
    'pin 3f225f43…i0',
  );
});

test('normalizeCapabilityScope: trims, lowercases, maps dashes to underscores', () => {
  assert.equal(normalizeCapabilityScope('Scorer-Fitted'), 'scorer_fitted');
  assert.equal(normalizeCapabilityScope(' Situational '), 'situational');
  assert.equal(normalizeCapabilityScope('GENERAL'), 'general');
  assert.equal(normalizeCapabilityScope('local'), null);
  assert.equal(normalizeCapabilityScope(''), null);
  assert.equal(normalizeCapabilityScope(null), null);
});
