import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FREE_GRANT_BYTES,
  TRAFFIC_BYTES_PER_KB,
  TRAFFIC_BYTES_PER_MB,
  TRAFFIC_LOW_BALANCE_BYTES,
  splitTrafficAmount,
} from '../src/renderer/components/traffic/formatTraffic';

test('traffic units are decimal (1000 B = 1 KB, 1_000_000 B = 1 MB)', () => {
  assert.equal(TRAFFIC_BYTES_PER_KB, 1000);
  assert.equal(TRAFFIC_BYTES_PER_MB, 1_000_000);
  assert.equal(DEFAULT_FREE_GRANT_BYTES, 10_000_000);
  assert.equal(TRAFFIC_LOW_BALANCE_BYTES, 5_000_000);
});

test('splitTrafficAmount shows the 10 MB free grant as 10 MB, not 9.5', () => {
  assert.deepEqual(splitTrafficAmount(10_000_000), { amount: '10', unit: 'mb' });
  assert.notEqual(splitTrafficAmount(10_000_000).amount, '9.5');
});

test('splitTrafficAmount picks B / KB / MB thresholds on the decimal scale', () => {
  assert.deepEqual(splitTrafficAmount(0), { amount: '0', unit: 'bytes' });
  assert.deepEqual(splitTrafficAmount(999), { amount: '999', unit: 'bytes' });
  assert.deepEqual(splitTrafficAmount(1000), { amount: '1', unit: 'kb' });
  assert.deepEqual(splitTrafficAmount(1500), { amount: '1.5', unit: 'kb' });
  assert.deepEqual(splitTrafficAmount(2500), { amount: '2.5', unit: 'kb' });
  assert.deepEqual(splitTrafficAmount(1_000_000), { amount: '1', unit: 'mb' });
  assert.deepEqual(splitTrafficAmount(1_500_000), { amount: '1.5', unit: 'mb' });
  assert.deepEqual(splitTrafficAmount(100_000_000), { amount: '100', unit: 'mb' });
});
