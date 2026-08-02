import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

function loadRunnerModule() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => process.cwd(),
        },
        BrowserWindow: { getAllWindows: () => [] },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    try {
      return require('../dist-electron/main/libs/coworkRunner.js');
    } catch {
      return require('../dist-electron/libs/coworkRunner.js');
    }
  } finally {
    Module._load = originalLoad;
  }
}

const { CoworkRunner } = loadRunnerModule();

const dateDaysAgo = (days) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
};

const setup = async (withExperienceStore = true) => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const { DreamStore } = await import('../dist-electron/main/dreamStore.js').catch(() => import('../dist-electron/dreamStore.js'));
  const dreamStore = new DreamStore(db, () => {});

  const recentDate = dateDaysAgo(5);
  const oldDate = dateDaysAgo(60);
  dreamStore.upsertDailySummary({
    metabotId: 5, summaryDate: recentDate, summaryText: '最近和用户聊了发布计划', sections: {}, stats: {}, llmId: null,
  });
  dreamStore.upsertDailySummary({
    metabotId: 5, summaryDate: oldDate, summaryText: '两个月前帮用户剪过周年庆视频', sections: {}, stats: {}, llmId: null,
  });

  const runner = new CoworkRunner(coworkStore, withExperienceStore ? { experienceStore: dreamStore } : {});
  const session = coworkStore.createSession('和用户聊发布', '/tmp/a', '', 'local', [], 5);
  return { db, cleanup, coworkStore, dreamStore, runner, session, recentDate, oldDate };
};

test('experience_recall fails clearly without bot attribution or experience store', async () => {
  const { cleanup, coworkStore, runner, session } = await setup(false);
  try {
    const unattributed = coworkStore.createSession('无归属会话', '/tmp/b');
    const noBot = runner.runExperienceRecallTool({}, unattributed.id);
    assert.equal(noBot.isError, true);
    assert.ok(noBot.text.includes('could not resolve MetaBot'));

    const noStore = runner.runExperienceRecallTool({}, session.id);
    assert.equal(noStore.isError, true);
    assert.ok(noStore.text.includes('not configured'));
  } finally {
    cleanup();
  }
});

test('bare recall returns only the warm 30-day window', async () => {
  const { cleanup, runner, session, recentDate, oldDate } = await setup();
  try {
    const result = runner.runExperienceRecallTool({}, session.id);
    assert.equal(result.isError, false);
    assert.ok(result.text.includes(recentDate), 'recent summary included');
    assert.ok(!result.text.includes(oldDate), '60-day-old summary outside the warm window');
    assert.ok(result.text.includes('index your full experience records'));
  } finally {
    cleanup();
  }
});

test('keyword recall searches full history (cold layer)', async () => {
  const { cleanup, runner, session, recentDate, oldDate } = await setup();
  try {
    const result = runner.runExperienceRecallTool({ query: '周年庆' }, session.id);
    assert.equal(result.isError, false);
    assert.ok(result.text.includes(oldDate), 'keyword hit from 60 days ago');
    assert.ok(!result.text.includes(recentDate), 'non-matching recent day excluded');

    const miss = runner.runExperienceRecallTool({ query: '不存在的关键词' }, session.id);
    assert.ok(miss.text.includes('No experience summaries found'));

    const ranged = runner.runExperienceRecallTool({ date_from: oldDate, date_to: oldDate }, session.id);
    assert.ok(ranged.text.includes(oldDate));
    assert.ok(!ranged.text.includes(recentDate));
  } finally {
    cleanup();
  }
});
