import test from 'node:test';
import assert from 'node:assert/strict';

import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

let DreamStore;
let composeExperiencePromptBlocks;
let RECENT_SUMMARIES_PROMPT_DAYS;
try {
  ({ DreamStore } = await import('../dist-electron/main/dreamStore.js'));
  ({
    buildExperiencePromptBlocksXml: composeExperiencePromptBlocks,
    RECENT_SUMMARIES_PROMPT_DAYS,
  } = await import('../dist-electron/main/libs/experiencePromptBlocks.js'));
} catch {
  ({ DreamStore } = await import('../dist-electron/dreamStore.js'));
  ({
    buildExperiencePromptBlocksXml: composeExperiencePromptBlocks,
    RECENT_SUMMARIES_PROMPT_DAYS,
  } = await import('../dist-electron/libs/experiencePromptBlocks.js'));
}

/**
 * Mirrors CoworkRunner.buildExperiencePromptBlocksXml and the privateChatDaemon
 * experience injection: strict metabot attribution → identity from memories +
 * recent summaries from the experience store → composed block.
 */
const buildExperienceBlock = (coworkStore, experienceStore, metabotId) => {
  if (metabotId == null) return '';
  const identityEntry = coworkStore.listUserMemories({
    metabotId,
    scopeKind: 'owner',
    scopeKey: 'owner:self',
    usageClass: 'self_identity',
    status: 'created',
    includeDeleted: false,
    limit: 1,
  })[0];
  const valueBoundaries = coworkStore.listUserMemories({
    metabotId,
    scopeKind: 'owner',
    scopeKey: 'owner:self',
    usageClass: 'value_boundary',
    status: 'created',
    includeDeleted: false,
    limit: 5,
  });
  const summaries = experienceStore?.listDailySummaries(metabotId, RECENT_SUMMARIES_PROMPT_DAYS) ?? [];
  return composeExperiencePromptBlocks({
    identityText: identityEntry?.text ?? null,
    valueBoundaries,
    summaries,
  });
};

test('experience injection renders self-identity and the 7 newest summaries only', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const dreamStore = new DreamStore(db, () => {});

    coworkStore.createUserMemory({
      metabotId: 5,
      text: '我是一个专注视频创作的 MetaBot,认真对待每一次交付。',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'self_identity',
      origin: 'dream',
    });
    coworkStore.createUserMemory({
      metabotId: 5,
      text: '在涉及个人痛苦的话题上要更谨慎(源自:用户提到家人住院)',
      scopeKind: 'owner',
      scopeKey: 'owner:self',
      usageClass: 'value_boundary',
      origin: 'dream',
    });

    for (let day = 1; day <= 9; day++) {
      dreamStore.upsertDailySummary({
        metabotId: 5,
        summaryDate: `2026-08-0${day}`,
        summaryText: `第 ${day} 天的概要`,
        sections: {},
        stats: {},
        llmId: null,
      });
    }

    const block = buildExperienceBlock(coworkStore, dreamStore, 5);
    assert.ok(block.includes('<metabot_self_identity>'));
    assert.ok(block.includes('专注视频创作'));
    assert.ok(block.includes('<value_boundaries>'));
    assert.ok(block.includes('在涉及个人痛苦的话题上要更谨慎'));
    assert.ok(block.includes('<recent_daily_summaries>'));
    assert.ok(block.includes('2026-08-09'), 'newest day present');
    assert.ok(block.includes('2026-08-03'), '7th newest day present');
    assert.ok(!block.includes('2026-08-02'), '8th newest day excluded by the hot-layer limit');
    assert.ok(!block.includes('2026-08-01'), 'oldest day excluded');

    // A bot with no experience data produces no block (no crash, no leakage).
    assert.equal(buildExperienceBlock(coworkStore, dreamStore, 99), '');
    // Unattributed session semantics: null metabot id → no block.
    assert.equal(buildExperienceBlock(coworkStore, dreamStore, null), '');
    // Missing experience store dep degrades to identity-only.
    const identityOnly = buildExperienceBlock(coworkStore, null, 5);
    assert.ok(identityOnly.includes('<metabot_self_identity>'));
    assert.ok(!identityOnly.includes('<recent_daily_summaries>'));
  } finally {
    cleanup();
  }
});
