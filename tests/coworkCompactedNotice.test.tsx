// Compaction checkpoints must render as one brief localized line. The kernel
// summary is LLM context, not chat content — dumping it into the transcript
// leaked internal state (header + full <compacted-summary> blob) into the
// chat in both assistant and professional modes. The mapper now stores a
// structured stub, and the display layer overrides whatever body legacy
// transcripts still carry.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCompactedNoticeText,
  extractCompactedCounts,
  formatCompactTokens,
} from '../src/renderer/components/cowork/compactedNotice';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sessionDetailSource = fs.readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'components', 'cowork', 'CoworkSessionDetail.tsx'),
  'utf8',
);

test('counts come from the structured metadata the mapper writes', () => {
  const counts = extractCompactedCounts(
    { compaction: true, compactedItems: 3, compactedTokens: 420 },
    '',
  );
  assert.deepEqual(counts, { items: 3, tokens: 420 });
});

test('legacy transcripts fall back to parsing the stored English header', () => {
  const counts = extractCompactedCounts(
    { compaction: true },
    'Compacted 369 history items (~311367 tokens).\n\n<compacted-summary>\n## Primary Request and Intent\n…',
  );
  assert.deepEqual(counts, { items: 369, tokens: 311367 });
});

test('no counts anywhere degrades to the plain localized line', () => {
  const counts = extractCompactedCounts({ compaction: true }, '');
  assert.deepEqual(counts, { items: null, tokens: null });
  assert.equal(buildCompactedNoticeText(counts), 'Context compacted');
});

test('the detailed line formats items and abbreviated tokens', () => {
  assert.equal(formatCompactTokens(311367), '311k');
  assert.equal(
    buildCompactedNoticeText({ items: 369, tokens: 311367 }),
    'Context compacted (369 history items, ~311k tokens)',
  );
  assert.equal(
    buildCompactedNoticeText({ items: 369, tokens: null }),
    'Context compacted (369 history items, ~— tokens)',
  );
});

test('CoworkSessionDetail overrides the stored body for compaction checkpoints only', () => {
  // The localized line must win over the stored body (legacy blobs), and the
  // override must not swallow compaction FAILURE messages (isError keeps its
  // diagnostic content).
  assert.match(
    sessionDetailSource,
    /meta\.compaction === true && meta\.isError !== true/,
  );
  assert.match(sessionDetailSource, /sdkOverridesContent = true/);
  assert.match(
    sessionDetailSource,
    /buildCompactedNoticeText\(extractCompactedCounts\(meta, message\.content\)\)/,
  );
  assert.match(sessionDetailSource, /!sdkOverridesContent && hasText\(message\.content\)/);
});
