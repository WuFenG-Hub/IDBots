import assert from 'node:assert/strict';
import test from 'node:test';
import { getMobileE2eArgs } from '../scripts/mobile-e2e-args.mjs';

test('mobile E2E strips a leading pnpm argument separator', () => {
  assert.deepEqual(
    getMobileE2eArgs(['node', 'runner', '--', '--project=pixel7', '--grep', 'chat']),
    ['--project=pixel7', '--grep', 'chat'],
  );
});

test('mobile E2E preserves ordinary and later separator arguments', () => {
  assert.deepEqual(
    getMobileE2eArgs(['node', 'runner', '--project=pixel7', '--', 'chat']),
    ['--project=pixel7', '--', 'chat'],
  );
  assert.deepEqual(getMobileE2eArgs(['node', 'runner']), []);
});
