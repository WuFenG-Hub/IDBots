import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { createRequire } from 'node:module';

import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

const require = createRequire(import.meta.url);
const {
  renderProcedureBlock,
  buildProcedureBlock,
} = require('../dist-electron/main/libs/procedurePromptBlocks.js');
const { MetaIDKnowledgeStore } = require('../dist-electron/main/metaidKnowledgeStore.js');

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
    return require('../dist-electron/main/libs/coworkRunner.js');
  } finally {
    Module._load = originalLoad;
  }
}

// ---------------------------------------------------------------------------
// Single injection path (RRSI P2 Task 6)
// ---------------------------------------------------------------------------

test('listInjectableTechniques returns only validated, never-promoted drafts', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
      { title: '已晋升技巧', description: '已经硬化成规程', capabilityType: 'workflow' },
      { title: '待晋升技巧', description: '还在注入层', capabilityType: 'workflow' },
      { title: '未验证技巧', description: '尚是草案', capabilityType: 'workflow' },
    ]);
    const drafts = coworkStore.listCapabilityDrafts(5);
    const promoted = drafts.find((draft) => draft.title === '已晋升技巧');
    const pending = drafts.find((draft) => draft.title === '待晋升技巧');
    const plain = drafts.find((draft) => draft.title === '未验证技巧');
    for (const draft of [promoted, pending]) {
      coworkStore.updateCapabilityDraftValidation({
        id: draft.id, metabotId: 5, status: 'validated', validationScore: 0.9,
      });
    }
    assert.equal(coworkStore.markCapabilityDraftPromoted({
      id: promoted.id, metabotId: 5, procedureId: 'proc-promoted-1',
    }), true);

    const injectable = coworkStore.listInjectableTechniques(5);
    assert.deepEqual(injectable.map((draft) => draft.title), ['待晋升技巧']);
    assert.equal(injectable[0].id, pending.id);
    assert.deepEqual(coworkStore.listInjectableTechniques(5, 1).map((draft) => draft.id), [pending.id], 'limit clamps');
    void plain;
  } finally {
    cleanup();
  }
});

test('runner: a promoted draft moves from <proven_techniques> to <procedures>', async () => {
  const { CoworkRunner } = loadRunnerModule();
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const knowledgeStore = new MetaIDKnowledgeStore(db, () => {}, () => 1_700_000_000_000);
    const runner = new CoworkRunner(coworkStore, { knowledgeStore });
    const session = coworkStore.createSession('和用户聊发布', '/tmp/a', '', 'local', [], 5);

    coworkStore.insertCapabilityDrafts(5, '2026-08-01', [
      { title: '已晋升技巧', description: '硬化后的做法', capabilityType: 'workflow' },
      { title: '待晋升技巧', description: '仍在注入', capabilityType: 'workflow' },
    ]);
    const drafts = coworkStore.listCapabilityDrafts(5);
    for (const draft of drafts) {
      coworkStore.updateCapabilityDraftValidation({
        id: draft.id, metabotId: 5, status: 'validated', validationScore: 0.9,
      });
    }
    const promoted = drafts.find((draft) => draft.title === '已晋升技巧');
    const promotedProcedure = knowledgeStore.upsertProcedure({
      metabotId: 5, title: '已晋升技巧', triggerText: '已晋升技巧', steps: ['硬化后的做法'], origin: 'dream',
    });
    coworkStore.markCapabilityDraftPromoted({
      id: promoted.id, metabotId: 5, procedureId: promotedProcedure.entry.id,
    });
    // A recall-only (probation) procedure: reachable by recall, never hot.
    knowledgeStore.upsertProcedure({
      metabotId: 5, title: '试用中的规程', triggerText: '当用户要求试用', steps: ['先自检'], origin: 'agent',
    });

    const block = runner.buildExperiencePromptBlocksXml(session.id);
    assert.ok(block.includes('<proven_techniques>'), 'the technique block rendered');
    assert.ok(block.includes('待晋升技巧'), 'the unpromoted validated draft is injected');
    assert.ok(block.includes('<procedures>'), 'the procedure block rendered');
    const techniquesSection = block.slice(
      block.indexOf('<proven_techniques>'),
      block.indexOf('</proven_techniques>') + '</proven_techniques>'.length,
    );
    const proceduresSection = block.slice(
      block.indexOf('<procedures>'),
      block.indexOf('</procedures>') + '</procedures>'.length,
    );
    assert.ok(!techniquesSection.includes('已晋升技巧'), 'a promoted draft never rides <proven_techniques>');
    assert.ok(proceduresSection.includes('已晋升技巧'), 'the promoted title is a procedure');
    assert.ok(!block.includes('试用中的规程'), 'a recall-only procedure appears in neither block');
  } finally {
    cleanup();
  }
});

test('renderProcedureBlock reports included ids and buildProcedureBlock matches its text', () => {
  const entry = (id, marker) => ({
    id,
    title: `规程${marker}`,
    triggerText: `当用户要求${marker}`,
    steps: [`${marker}第一步很有长度`.repeat(12)],
    pitfalls: [],
    sourcePinIds: [],
  });
  const entries = [entry('p1', '一'), entry('p2', '二'), entry('p3', '三'), { ...entry('p4', '四'), id: undefined }];
  const { text, includedIds } = renderProcedureBlock(entries, 5, 300);
  assert.ok(text.length > 0);
  assert.ok(includedIds.length < entries.length, 'the 300-char budget drops entries');
  assert.ok(!includedIds.includes(undefined), 'entries without an id are never listed');
  assert.equal(buildProcedureBlock(entries), renderProcedureBlock(entries).text, 'byte-identical to the legacy builder');
  const full = renderProcedureBlock(entries);
  assert.equal(full.text, buildProcedureBlock(entries, 5, 1800));
  assert.deepEqual(full.includedIds.filter(Boolean), ['p1', 'p2', 'p3']);
});
