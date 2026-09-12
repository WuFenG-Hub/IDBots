import test from 'node:test';
import assert from 'node:assert/strict';

const {
  estimateChunkedUploadFundingSats,
  formatSatsAsSpace,
  normalizeChunkedUploadUtxos,
  pickChunkedUploadFundingUtxos,
} = await import('../dist-electron/main/libs/uploadLargeFileFunding.js');

test('estimateChunkedUploadFundingSats scales with file size and fee rate', () => {
  const oneMiB = 1024 * 1024;
  const small = estimateChunkedUploadFundingSats(2000, 5);
  // Matches the uploader estimate endpoint probe: 2000 B at feeRate 5 costs
  // ~12230 + 2925 sats for chunk + index pre-txs; the local estimator must be
  // in that ballpark (conservative, not wildly over).
  assert.ok(small >= 10_000 && small <= 40_000, `small estimate ${small} out of range`);

  const singleChunk = estimateChunkedUploadFundingSats(oneMiB, 1);
  assert.ok(singleChunk >= oneMiB, 'estimate must at least cover raw bytes at feeRate 1');
  const twoChunks = estimateChunkedUploadFundingSats(oneMiB + 1, 1);
  assert.ok(twoChunks > singleChunk, 'crossing a chunk boundary must increase the estimate');

  const atRate5 = estimateChunkedUploadFundingSats(oneMiB, 5);
  assert.equal(atRate5, singleChunk * 5);

  // 22.6 MB at feeRate 1 ≈ 0.237 SPACE — the failing order's real cost.
  const orderCase = estimateChunkedUploadFundingSats(22.6 * 1024 * 1024, 1);
  assert.ok(orderCase >= 23_000_000 && orderCase <= 26_000_000, `order-case estimate ${orderCase}`);

  assert.equal(estimateChunkedUploadFundingSats(0, 1), 0);
});

test('estimateChunkedUploadFundingSats honors a custom chunk size', () => {
  const oneMiB = 1024 * 1024;
  const withSmallChunks = estimateChunkedUploadFundingSats(4 * oneMiB, 1, 512 * 1024);
  const withBigChunks = estimateChunkedUploadFundingSats(4 * oneMiB, 1, 2 * 1024 * 1024);
  assert.ok(withSmallChunks > withBigChunks, 'smaller chunks mean more per-chunk overhead');
});

test('pickChunkedUploadFundingUtxos reports required and available sats on failure', () => {
  const address = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
  const utxos = normalizeChunkedUploadUtxos(
    [{ txid: 'a'.repeat(64), outIndex: 0, value: 1000, height: 12 }],
    address,
  );
  assert.throws(
    () => pickChunkedUploadFundingUtxos(utxos, 24_000_000, 1),
    (error) => {
      assert.match(error.message, /^Insufficient MVC balance for chunked upload/);
      assert.match(error.message, /requires ~\d+ sats/);
      assert.match(error.message, /only 1000 sats/);
      assert.match(error.message, /SPACE/);
      return true;
    },
  );
});

test('formatSatsAsSpace renders sats as SPACE units', () => {
  assert.equal(formatSatsAsSpace(100_000_000), '1 SPACE');
  assert.equal(formatSatsAsSpace(23_732_552), '0.23732552 SPACE');
  assert.equal(formatSatsAsSpace(0), '0 SPACE');
});
