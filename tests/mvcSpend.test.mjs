import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let mvcSpend;
try {
  mvcSpend = require('../dist-electron/main/libs/mvcSpend.js');
} catch {
  mvcSpend = null;
}

// pickUtxo no longer re-sorts confirmed first (removed in 9a0cba9b); ordering
// is: explicitly preferred outpoints, then input order.
test('pickUtxo prefers explicitly preferred funding inputs before other inputs', () => {
  assert.equal(
    typeof mvcSpend?.pickUtxo,
    'function',
    'pickUtxo() should be exported',
  );

  const preferredOutpoint = `${'b'.repeat(64)}:1`;
  const selected = mvcSpend.pickUtxo(
    [
      {
        txId: 'a'.repeat(64),
        outputIndex: 0,
        satoshis: 12_000,
        address: 'mvc-address',
        height: -1,
      },
      {
        txId: 'b'.repeat(64),
        outputIndex: 1,
        satoshis: 20_000,
        address: 'mvc-address',
        height: 100,
      },
    ],
    10_000,
    1,
    90,
    new Set(),
    new Set([preferredOutpoint]),
  );

  assert.deepEqual(
    selected.map((utxo) => `${utxo.txId}:${utxo.outputIndex}`),
    [preferredOutpoint],
  );
});

test('pickUtxo falls back to unconfirmed MVC funding inputs when no confirmed input can cover the spend', () => {
  assert.equal(
    typeof mvcSpend?.pickUtxo,
    'function',
    'pickUtxo() should be exported',
  );

  const selected = mvcSpend.pickUtxo(
    [
      {
        txId: 'c'.repeat(64),
        outputIndex: 0,
        satoshis: 4_000,
        address: 'mvc-address',
        height: 101,
      },
      {
        txId: 'd'.repeat(64),
        outputIndex: 1,
        satoshis: 8_000,
        address: 'mvc-address',
        height: -1,
      },
    ],
    10_000,
    1,
    90,
  );

  assert.deepEqual(
    selected.map((utxo) => `${utxo.txId}:${utxo.outputIndex}`),
    [`${'c'.repeat(64)}:0`, `${'d'.repeat(64)}:1`],
  );
});
