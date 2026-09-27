import test from 'node:test';
import assert from 'node:assert/strict';
import { MinimalDomMatrix, ensureDomMatrixPolyfill } from '../dist-electron/main/libs/domMatrixPolyfill.js';

test('default constructor is the identity matrix', () => {
  const m = new MinimalDomMatrix();
  assert.deepEqual([m.a, m.b, m.c, m.d, m.e, m.f], [1, 0, 0, 1, 0, 0]);
  assert.equal(m.isIdentity, true);
  assert.equal(m.is2D, true);
});

test('constructor accepts 6-element, 16-element, object and matrix initializers', () => {
  const six = new MinimalDomMatrix([2, 0, 0, 3, 4, 5]);
  assert.deepEqual([six.a, six.b, six.c, six.d, six.e, six.f], [2, 0, 0, 3, 4, 5]);
  // column-major 16-element layout: m11 m12 … m41 m42
  const sixteen = new MinimalDomMatrix([2, 1, 0, 0, 0.5, 3, 0, 0, 0, 0, 1, 0, 4, 5, 0, 1]);
  assert.deepEqual([sixteen.a, sixteen.b, sixteen.c, sixteen.d, sixteen.e, sixteen.f], [2, 1, 0.5, 3, 4, 5]);
  const fromObject = new MinimalDomMatrix({ a: 2, b: 1, c: 0.5, d: 3, e: 4, f: 5 });
  assert.deepEqual(
    [fromObject.a, fromObject.b, fromObject.c, fromObject.d, fromObject.e, fromObject.f],
    [2, 1, 0.5, 3, 4, 5]
  );
  const copy = new MinimalDomMatrix(six);
  assert.deepEqual([copy.a, copy.b, copy.c, copy.d, copy.e, copy.f], [2, 0, 0, 3, 4, 5]);
});

const close = (actual, expected) => {
  for (let i = 0; i < actual.length; i += 1) {
    assert.ok(Math.abs(actual[i] - expected[i]) < 1e-9, `index ${i}: ${actual[i]} != ${expected[i]}`);
  }
};

test('translate and scale follow the spec column-vector convention', () => {
  // translate: x' = x + tx (identity × T)
  const t = new MinimalDomMatrix().translate(3, 4);
  close([t.a, t.b, t.c, t.d, t.e, t.f], [1, 0, 0, 1, 3, 4]);
  // scale: x' = sx·x, y' = sy·y (y defaults to x)
  const s = new MinimalDomMatrix().scale(2);
  close([s.a, s.b, s.c, s.d, s.e, s.f], [2, 0, 0, 2, 0, 0]);
  // composed on a non-identity base: M × T keeps rotation, adds offset
  const base = new MinimalDomMatrix([0, 1, -1, 0, 10, 20]); // rotate 90°
  const moved = base.translate(3, 4);
  close([moved.a, moved.b, moved.c, moved.d, moved.e, moved.f], [0, 1, -1, 0, 6, 23]);
});

test('translate/scale/multiply return new matrices and leave the source untouched', () => {
  const base = new MinimalDomMatrix([2, 0, 0, 2, 1, 1]);
  const translated = base.translate(5, 5);
  assert.notEqual(translated, base);
  close([base.e, base.f], [1, 1]);
  close([translated.e, translated.f], [11, 11]);
});

test('multiplySelf composes this × other; preMultiplySelf is the reverse', () => {
  const scale = new MinimalDomMatrix([2, 0, 0, 2, 0, 0]);
  const translate = new MinimalDomMatrix([1, 0, 0, 1, 10, 20]);
  // multiplySelf: product is scale × translate — column-vector order means
  // translate maps the point first, then scale: (1,1) → (11,21) → (22,42)
  const st = new MinimalDomMatrix(scale).multiplySelf(translate);
  close([st.a, st.b, st.c, st.d, st.e, st.f], [2, 0, 0, 2, 20, 40]);
  const applySt = (x, y) => [st.a * x + st.c * y + st.e, st.b * x + st.d * y + st.f];
  close(applySt(1, 1), [22, 42]);
  // preMultiplySelf: product is translate × scale — scale first, then
  // translate: (1,1) → (2,2) → (12,22)
  const ts = new MinimalDomMatrix(scale).preMultiplySelf(translate);
  const applyTs = (x, y) => [ts.a * x + ts.c * y + ts.e, ts.b * x + ts.d * y + ts.f];
  close(applyTs(1, 1), [12, 22]);
});

test('invertSelf inverts and a singular matrix becomes NaN per spec', () => {
  const m = new MinimalDomMatrix([2, 0, 0, 4, 10, 20]);
  m.invertSelf();
  const roundTrip = new MinimalDomMatrix([2, 0, 0, 4, 10, 20]).multiplySelf(m);
  close([roundTrip.a, roundTrip.b, roundTrip.c, roundTrip.d], [1, 0, 0, 1]);
  close([roundTrip.e, roundTrip.f], [0, 0]);
  const singular = new MinimalDomMatrix([1, 1, 1, 1, 0, 0]);
  singular.invertSelf();
  assert.ok(Number.isNaN(singular.a));
  // inverse() returns a new matrix
  const src = new MinimalDomMatrix([2, 0, 0, 2, 0, 0]);
  const inv = src.inverse();
  assert.notEqual(inv, src);
  assert.deepEqual([src.a, src.d], [2, 2]);
});

test('ensureDomMatrixPolyfill installs MinimalDomMatrix only when DOMMatrix is missing', () => {
  const saved = globalThis.DOMMatrix;
  try {
    delete globalThis.DOMMatrix;
    ensureDomMatrixPolyfill();
    assert.equal(globalThis.DOMMatrix, MinimalDomMatrix);
    // a pre-existing DOMMatrix always wins
    const fake = class Fake {};
    globalThis.DOMMatrix = fake;
    ensureDomMatrixPolyfill();
    assert.equal(globalThis.DOMMatrix, fake);
  } finally {
    if (saved === undefined) delete globalThis.DOMMatrix;
    else globalThis.DOMMatrix = saved;
  }
});
