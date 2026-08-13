import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const {
  getRate,
  selectTier,
  resolveCreatePinFeeRate,
} = await import('../dist-electron/main/services/feeRateStore.js');

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function captureWarn(fn) {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => {
    warnings.push(args.join(' '));
  };
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

test('resolveCreatePinFeeRate prefers a valid explicit rate over the store tier', () => {
  assert.equal(resolveCreatePinFeeRate('mvc', 5), 5);
  assert.equal(resolveCreatePinFeeRate('doge', 2), 2);
  assert.equal(resolveCreatePinFeeRate('opcat', 0.5), 0.5);
});

test('resolveCreatePinFeeRate falls back to the user-selected tier when explicit rate is absent or invalid', () => {
  const mvcTierRate = getRate('mvc');
  assert.ok(Number.isFinite(mvcTierRate) && mvcTierRate > 0);
  assert.equal(resolveCreatePinFeeRate('mvc'), mvcTierRate);
  assert.equal(resolveCreatePinFeeRate('mvc', undefined), mvcTierRate);
  assert.equal(resolveCreatePinFeeRate('mvc', null), mvcTierRate);
  assert.equal(resolveCreatePinFeeRate('mvc', 0), mvcTierRate);
  assert.equal(resolveCreatePinFeeRate('mvc', -3), mvcTierRate);
  assert.equal(resolveCreatePinFeeRate('mvc', Number.NaN), mvcTierRate);
  assert.equal(resolveCreatePinFeeRate('mvc', Number.POSITIVE_INFINITY), mvcTierRate);
});

test('resolveCreatePinFeeRate reflects tier selection changes made through the store', () => {
  try {
    selectTier('doge', 'Slow');
    assert.equal(resolveCreatePinFeeRate('doge'), 5000000);
    selectTier('doge', 'Fast');
    assert.equal(resolveCreatePinFeeRate('doge'), 7500000);
    // Explicit value still wins over the selected tier.
    assert.equal(resolveCreatePinFeeRate('doge', 123), 123);
  } finally {
    selectTier('doge', 'Fast');
  }
});

test('resolveCreatePinFeeRate warns and uses the hard-coded fallback for chains without store tiers', () => {
  const opcat = captureWarn(() => resolveCreatePinFeeRate('opcat'));
  assert.equal(opcat.value, 0.001);
  assert.equal(opcat.warnings.length, 1);
  assert.match(opcat.warnings[0], /opcat/);

  const unknown = captureWarn(() => resolveCreatePinFeeRate('unknown-chain'));
  assert.equal(unknown.value, 1);
  assert.equal(unknown.warnings.length, 1);
});

test('metaidCore createPin routes omitted feeRate through resolveCreatePinFeeRate instead of a silent constant', () => {
  const source = read('src/main/services/metaidCore.ts');
  assert.equal(source.includes('FALLBACK_FEE_RATES'), false, 'metaidCore must not keep its own fallback constant');
  assert.match(source, /feeRate: resolveCreatePinFeeRate\(network, options\?\.feeRate\)/);
  assert.match(source, /feeRate: resolveCreatePinFeeRate\('mvc', options\?\.feeRate\)/);
  assert.match(source, /import \{ resolveCreatePinFeeRate \} from '\.\/feeRateStore';/);
});

test('every main.ts createPin call site passes an explicit feeRate option', () => {
  const source = read('src/main/main.ts');
  // Extract each top-level `createPin(...)` call by balancing parens from the
  // call start; word-boundary guard skips identifiers like createPinForIdentity.
  const calls = [];
  let idx = source.indexOf('createPin(');
  while (idx !== -1) {
    const before = idx > 0 ? source[idx - 1] : '';
    if (!/[A-Za-z0-9_$]/.test(before)) {
      let depth = 0;
      let end = idx + 'createPin'.length;
      for (; end < source.length; end += 1) {
        const ch = source[end];
        if (ch === '(') depth += 1;
        else if (ch === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      calls.push(source.slice(idx, end + 1));
      idx = source.indexOf('createPin(', end);
    } else {
      idx = source.indexOf('createPin(', idx + 1);
    }
  }
  assert.ok(calls.length > 0, 'expected to find createPin call sites in main.ts');
  const violations = calls.filter((call) => !call.includes('feeRate'));
  assert.deepEqual(violations, []);
});
