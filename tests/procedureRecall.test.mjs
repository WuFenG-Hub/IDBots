import test from 'node:test';
import assert from 'node:assert/strict';

import { createLegacyMemoryDb } from './memoryTestUtils.mjs';

const { MetaIDKnowledgeStore } = await import('../dist-electron/main/metaidKnowledgeStore.js')
  .catch(() => import('../dist-electron/metaidKnowledgeStore.js'));

const setup = async () => {
  const db = await createLegacyMemoryDb();
  return new MetaIDKnowledgeStore(db, () => {}, () => 1000);
};

const saveMetaWebInstallProcedure = (store) => store.upsertProcedure({
  metabotId: 7,
  title: '通过 MetaWeb 学习并安装链上技能',
  triggerText: '当用户要求按 MetaWeb 教程安装某个技能时使用',
  steps: [
    'search_metaweb 搜索教程关键词',
    'read_metaweb_pin 打开教程 pin',
    '按教程用 skill_tool install_skill 安装链上技能包',
    '安装后用 list_installed_skills 验证',
  ],
  sourcePinIds: ['abc123i0'],
});

test('multi-keyword query hits a differently-phrased title (M3 recall defect)', async () => {
  const store = await setup();
  saveMetaWebInstallProcedure(store);
  const hits = store.listProcedures({ metabotId: 7, status: 'active', query: 'MetaWeb 安装 技能' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, '通过 MetaWeb 学习并安装链上技能');
});

test('colloquial query "装技能" hits via the 技能 bigram', async () => {
  const store = await setup();
  saveMetaWebInstallProcedure(store);
  const hits = store.listProcedures({ metabotId: 7, status: 'active', query: '装技能' });
  assert.equal(hits.length, 1);
});

test('natural task phrasing "按 MetaWeb 教程装个技能" hits', async () => {
  const store = await setup();
  saveMetaWebInstallProcedure(store);
  const hits = store.listProcedures({ metabotId: 7, status: 'active', query: '按 MetaWeb 教程装个技能' });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].sourcePinIds[0], 'abc123i0');
});

test('ranking prefers the higher-coverage entry; unrelated queries return empty', async () => {
  const store = await setup();
  saveMetaWebInstallProcedure(store);
  store.upsertProcedure({
    metabotId: 7,
    title: '视频会议技能整理流程',
    triggerText: '当用户要整理视频会议技能材料时使用',
    steps: ['收集会议录像', '转写并归档'],
  });
  const hits = store.listProcedures({ metabotId: 7, status: 'active', query: 'MetaWeb 安装 技能' });
  assert.equal(hits.length, 2, 'both contain 技能, so both rank in');
  assert.equal(hits[0].title, '通过 MetaWeb 学习并安装链上技能', 'full-coverage entry first');
  const none = store.listProcedures({ metabotId: 7, status: 'active', query: '数据库迁移' });
  assert.equal(none.length, 0);
});

test('recall bumps useCount/lastUsedAt only on returned rows', async () => {
  const store = await setup();
  const saved = saveMetaWebInstallProcedure(store);
  store.upsertProcedure({
    metabotId: 7,
    title: '视频会议技能整理流程',
    triggerText: '整理视频会议技能材料',
    steps: ['收集', '归档'],
  });
  const hits = store.listProcedures({ metabotId: 7, status: 'active', query: 'MetaWeb 安装', touchUsed: true });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].useCount, saved.entry.useCount + 1);
  assert.ok(hits[0].lastUsedAt != null);
});

test('same-title save rewrites in place (version bump), no duplicate', async () => {
  const store = await setup();
  saveMetaWebInstallProcedure(store);
  const again = store.upsertProcedure({
    metabotId: 7,
    title: '通过 MetaWeb 学习并安装链上技能',
    triggerText: '当用户要求按 MetaWeb 教程安装某个技能时使用',
    steps: ['更新后的步骤'],
    sourcePinIds: ['abc123i0', 'def456i0'],
  });
  assert.equal(again.created, false);
  assert.equal(again.revised, true);
  assert.equal(again.entry.version, 2);
  const all = store.listProcedures({ metabotId: 7, status: 'active' });
  assert.equal(all.length, 1);
});

test('bot isolation: another bot\'s procedures never rank in', async () => {
  const store = await setup();
  saveMetaWebInstallProcedure(store);
  const hits = store.listProcedures({ metabotId: 8, status: 'active', query: 'MetaWeb 安装 技能' });
  assert.equal(hits.length, 0);
});

test('single-char query matches titles only (no whole-library flood)', async () => {
  const store = await setup();
  saveMetaWebInstallProcedure(store);
  store.upsertProcedure({
    metabotId: 7,
    title: '整理会议录像流程',
    triggerText: '当用户要整理录像时使用',
    steps: ['把录像装进文件夹', '转写归档'],
  });
  // "装" appears in the second entry's STEPS (装进) but not its title —
  // title-only matching keeps it out; the first entry's title contains 安装.
  const hits = store.listProcedures({ metabotId: 7, status: 'active', query: '装' });
  assert.deepEqual(hits.map((entry) => entry.title), ['通过 MetaWeb 学习并安装链上技能']);
});

test('archiveProcedureByTitle retires an active entry; recall stops surfacing it', async () => {
  const store = await setup();
  saveMetaWebInstallProcedure(store);
  const archived = store.archiveProcedureByTitle(7, '通过 MetaWeb 学习并安装链上技能');
  assert.ok(archived);
  assert.equal(archived.status, 'archived');
  const hits = store.listProcedures({ metabotId: 7, status: 'active', query: 'MetaWeb 安装 技能' });
  assert.equal(hits.length, 0, 'archived entries no longer recall');
  const all = store.listProcedures({ metabotId: 7, status: 'all' });
  assert.equal(all.length, 1, 'record is kept for history');
  assert.equal(store.archiveProcedureByTitle(7, '通过 MetaWeb 学习并安装链上技能'), null, 'already archived → null');
  assert.equal(store.archiveProcedureByTitle(7, '不存在的标题'), null);
});
