import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

function loadRunnerModule() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') {
      return {
        app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() },
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
const { buildKnowledgeBasesPromptBlock } = require('../dist-electron/main/libs/knowledgeBasePromptBlocks.js');
const { createNativeSqliteDatabase } = await import('../dist-electron/main/nativeSqliteDatabase.js')
  .catch(() => import('../dist-electron/nativeSqliteDatabase.js'));
const { KnowledgeBaseStore } = await import('../dist-electron/main/knowledgeBaseStore.js')
  .catch(() => import('../dist-electron/knowledgeBaseStore.js'));
const { KnowledgeBaseService } = await import('../dist-electron/main/services/knowledgeBaseService.js')
  .catch(() => import('../dist-electron/services/knowledgeBaseService.js'));

const KB_TOOL_NAMES = [
  'knowledge_base_list',
  'knowledge_base_query',
  'knowledge_base_add_document',
  'knowledge_base_learn',
];

const MOCK_TOOL = (name, description, schema, handler) => ({ name, description, schema, handler });

const METABOT_ID = 5;

const setup = async ({ withKnowledgeBase = true } = {}) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-tools-test-'));
  const { db, cleanup: cleanupCowork } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const nativeDb = createNativeSqliteDatabase(':memory:');
  assert.ok(nativeDb, 'native sqlite available in test runtime');
  const kbStore = new KnowledgeBaseStore(nativeDb, () => {});
  const service = new KnowledgeBaseService({
    store: kbStore,
    resolveUserDataDir: () => path.join(tmpDir, 'userData'),
  });
  const runner = new CoworkRunner(coworkStore, withKnowledgeBase ? { knowledgeBase: service } : {});
  const session = coworkStore.createSession('知识库会话', '/tmp/a', '', 'local', [], METABOT_ID);
  const buildTools = (sessionId) => {
    const tools = runner.buildSessionInlineTools(sessionId, MOCK_TOOL);
    return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  };
  return {
    tmpDir,
    coworkStore,
    service,
    runner,
    session,
    buildTools,
    cleanup: () => {
      service.stopAutoLearnSchedule();
      nativeDb.close();
      cleanupCowork();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
};

test('knowledge base tools are registered when the control is present, absent otherwise', async () => {
  const withKb = await setup();
  try {
    const tools = withKb.buildTools(withKb.session.id);
    for (const name of KB_TOOL_NAMES) {
      assert.ok(tools[name], `expected ${name} to be registered`);
      assert.equal(typeof tools[name].handler, 'function');
      assert.ok(tools[name].description.length > 0);
    }
  } finally {
    withKb.cleanup();
  }

  const withoutKb = await setup({ withKnowledgeBase: false });
  try {
    const tools = withoutKb.buildTools(withoutKb.session.id);
    for (const name of KB_TOOL_NAMES) {
      assert.ok(!tools[name], `expected ${name} to be absent without the control`);
    }
  } finally {
    withoutKb.cleanup();
  }
});

test('knowledge_base_list errors clearly without bot attribution', async () => {
  const { coworkStore, buildTools, cleanup } = await setup();
  try {
    const unattributed = coworkStore.createSession('无归属会话', '/tmp/b');
    const tools = buildTools(unattributed.id);
    const result = await tools.knowledge_base_list.handler({});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /could not resolve which MetaBot owns this session/);
  } finally {
    cleanup();
  }
});

test('knowledge_base_list auto-creates and lists the default KB even at 0 docs', async () => {
  const { buildTools, session, cleanup } = await setup();
  try {
    const tools = buildTools(session.id);
    const result = await tools.knowledge_base_list.handler({});
    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.match(text, /1 knowledge base\(s\)/);
    assert.match(text, /Default \(id: default\) \[default\]/);
    assert.match(text, /documents: 0 \| chunks: 0 \| last learned: never/);
    assert.match(text, /knowledge_base_query/);
  } finally {
    cleanup();
  }
});

test('add_document -> learn -> query roundtrip returns the saved content with KB attribution', async () => {
  const { buildTools, session, cleanup } = await setup();
  try {
    const tools = buildTools(session.id);

    const added = await tools.knowledge_base_add_document.handler({
      title: '民法典合同编要点',
      content: '依法成立的合同，自成立时生效。当事人应当按照约定全面履行自己的义务。',
      sourceType: 'web',
      url: 'https://example.com/civil-code',
    });
    assert.equal(added.isError, undefined);
    assert.match(added.content[0].text, /Saved document "民法典合同编要点" into knowledge base "default"/);
    assert.match(added.content[0].text, /metabot-inbox\//);
    assert.match(added.content[0].text, /knowledge_base_learn/);

    const learned = await tools.knowledge_base_learn.handler({});
    assert.equal(learned.isError, undefined);
    assert.match(learned.content[0].text, /Learned knowledge base "default" \(incremental\): 1 added/);
    assert.match(learned.content[0].text, /1 doc\(s\)/);

    const hit = await tools.knowledge_base_query.handler({ query: '合同 生效' });
    assert.equal(hit.isError, undefined);
    const text = hit.content[0].text;
    assert.match(text, /citation\(s\) for "合同 生效"/);
    assert.match(text, /\[Default\] 民法典合同编要点 — score [\d.]+/);
    assert.match(text, /source: .*metabot-inbox/);
    assert.match(text, /合同/);
  } finally {
    cleanup();
  }
});

test('add_document assembles metaweb provenance from pinId', async () => {
  const { buildTools, session, service, tmpDir, cleanup } = await setup();
  try {
    const tools = buildTools(session.id);
    const pinBody = JSON.stringify({
      title: 'MetaWeb 教程', contentType: 'text/markdown', content: '第一步……', createTime: '2026-08-01',
    });
    const result = await tools.knowledge_base_add_document.handler({
      title: 'ignored-when-verbatim',
      content: pinBody,
      sourceType: 'metaweb',
      pinId: 'abc123i0',
    });
    assert.equal(result.isError, undefined);
    const kb = service.listKnowledgeBases(METABOT_ID)[0];
    const inboxDir = path.join(kb.rawDir, 'metabot-inbox');
    const files = fs.readdirSync(inboxDir);
    assert.equal(files.length, 1);
    const payload = JSON.parse(fs.readFileSync(path.join(inboxDir, files[0]), 'utf8'));
    assert.equal(payload.title, 'MetaWeb 教程', 'pin body kept verbatim');
    assert.equal(payload['x-kb-source'].type, 'metaweb');
    assert.equal(payload['x-kb-source'].pinId, 'abc123i0');
  } finally {
    cleanup();
  }
});

test('knowledge_base_query over an empty corpus returns insufficient-evidence text, not an error', async () => {
  const { buildTools, session, cleanup } = await setup();
  try {
    const tools = buildTools(session.id);
    const result = await tools.knowledge_base_query.handler({ query: 'xylophone quantum' });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Insufficient evidence/);
    assert.match(result.content[0].text, /xylophone quantum/);
  } finally {
    cleanup();
  }
});

test('knowledge_base_learn reports failures without failing the whole run', async () => {
  const { buildTools, session, service, cleanup } = await setup();
  try {
    const kb = service.listKnowledgeBases(METABOT_ID)[0];
    fs.writeFileSync(path.join(kb.rawDir, 'broken.pdf'), '%PDF-garbage-not-a-real-pdf', 'utf8');
    const tools = buildTools(session.id);
    const result = await tools.knowledge_base_learn.handler({ knowledgeBaseId: 'default' });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /failed files:/);
    assert.match(result.content[0].text, /broken\.pdf/);
  } finally {
    cleanup();
  }
});

test('buildKnowledgeBasesPromptBlock renders a bounded block and empty-string cases', () => {
  assert.equal(buildKnowledgeBasesPromptBlock([]), '');
  assert.equal(buildKnowledgeBasesPromptBlock([{ name: '  ' }]), '');

  const records = Array.from({ length: 7 }, (_, index) => ({
    name: `KB ${index + 1}`,
    description: `corpus ${index + 1}`,
    docCount: index,
    chunkCount: index * 2,
    isDefault: index === 0,
  }));
  const block = buildKnowledgeBasesPromptBlock(records);
  assert.match(block, /^<knowledge_bases>/);
  assert.match(block, /<kb name="KB 1" default="true" docs="0" chunks="0">corpus 1<\/kb>/);
  assert.match(block, /knowledge_base_query/);
  assert.match(block, /knowledge_base_add_document/);
  assert.ok(block.includes('KB 5'), 'fifth KB included');
  assert.ok(!block.includes('KB 6'), 'bounded at 5 KBs');
});

test('runner volatile prompt lists the bot knowledge bases and stays empty without attribution/control', async () => {
  const { runner, coworkStore, session, cleanup } = await setup();
  try {
    const text = runner.buildKnowledgeBasesPromptXml(session.id);
    assert.match(text, /<knowledge_bases>/);
    assert.match(text, /name="Default"/);

    const unattributed = coworkStore.createSession('无归属会话2', '/tmp/c');
    assert.equal(runner.buildKnowledgeBasesPromptXml(unattributed.id), '');

    const learningLoop = runner.buildMetawebLearningLoopPrompt();
    assert.match(learningLoop, /knowledge_base_add_document/);
    assert.match(learningLoop, /sourceType 'metaweb'/);
  } finally {
    cleanup();
  }

  const withoutKb = await setup({ withKnowledgeBase: false });
  try {
    assert.equal(withoutKb.runner.buildKnowledgeBasesPromptXml(withoutKb.session.id), '');
  } finally {
    withoutKb.cleanup();
  }
});
