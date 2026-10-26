import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildCoworkSessionStartOptions } from '../src/renderer/services/coworkSessionStart.ts';

const require = Module.createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return { app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() } };
  }
  return originalLoad.apply(this, arguments);
};
const { CoworkRunner } = require('../dist-electron/main/libs/coworkRunner.js');
const { resolveSessionWorkingDirectory } = require('../dist-electron/main/libs/botWorkspace.js');
Module._load = originalLoad;

function runtimeHarness(t, metabotId) {
  const root = fs.mkdtempSync(path.join(projectRoot, '.cowork-temp', 'wp1-twin-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const start = buildCoworkSessionStartOptions({
    metabotId,
    title: 'Mobile Twin',
    config: { workingDirectory: root, systemPrompt: '' },
  });
  const workspace = resolveSessionWorkingDirectory(start.cwd, start.metabotId, new Date(2026, 9, 26));
  const twin = {
    id: metabotId,
    name: 'Twin fixture',
    soul: 'Helpful synthetic twin',
    role: 'chief of staff',
    metabot_type: 'twin',
    llm_id: 'twin-brain-model',
    llm_provider: 'twin-provider',
    llm_effort: 'high',
    globalmetaid: 'gmid-twin-fixture',
    apiKey: 'SYNTHETIC_SECRET_NEVER_LOG',
  };
  const skillScope = { metabotId: null };
  const store = {
    getSession: () => ({ metabotId, executionMode: 'local' }),
    getMetabotIdForSession: () => metabotId,
    getConfig: () => ({ executionMode: 'local' }),
    getConversationSourceContextBySession: () => ({ sourceChannel: 'cowork_ui', externalConversationId: 'test' }),
    getMemoryBackend: () => ({ resolveMetabotIdForMemory: () => metabotId }),
  };
  const runner = new CoworkRunner(store, {
    getMetabotById: (id) => id === metabotId ? twin : null,
    coworkSkillPromptsProvider: (id) => {
      skillScope.metabotId = id;
      return { rules: 'TWIN_SKILL_RULES', catalog: 'TWIN_SKILL_CATALOG', sandboxSection: null };
    },
  });
  return { root, start, workspace, twin, skillScope, store, runner };
}

test('mobile start context resolves the actual Twin persona, brain, skills, memory, and workspace', (t) => {
  const { root, start, workspace, skillScope, store, runner } = runtimeHarness(t, 1);
  const persona = runner.buildMetabotPersonaBlock('mobile-twin');
  const orchestration = runner.buildTwinOrchestrationPrompt('mobile-twin');
  const brain = runner.getSessionAutomationBrain('mobile-twin');
  const skills = runner.resolveSkillsPromptForTurn('mobile-twin', { executionMode: 'local' }, '');
  const memoryMetabotId = store.getMemoryBackend().resolveMetabotIdForMemory('mobile-twin');

  assert.equal(start.metabotId, 1);
  assert.equal('model' in start, false, 'the Twin brain is not shadowed by a renderer model pick');
  assert.equal('permissionMode' in start, false, 'the persisted permission preference is not overwritten');
  assert.equal(workspace, path.join(root, 'bots', '1', '2026-10-26'));
  assert.match(persona, /<name>Twin fixture<\/name>/);
  assert.match(persona, /<metabot_id>1<\/metabot_id>/);
  assert.match(persona, /<soul>Helpful synthetic twin<\/soul>/);
  assert.match(orchestration, /one persistent Twin Bot/);
  assert.match(orchestration, /local_worker_delegate/);
  assert.equal(brain.modelId, 'twin-brain-model');
  assert.equal(brain.providerKey, 'twin-provider');
  assert.equal(brain.effort, 'high');
  assert.equal(skillScope.metabotId, 1);
  assert.equal(skills.skillsSection, 'TWIN_SKILL_RULES');
  assert.equal(skills.skillsCatalogMode, 'volatile');
  assert.equal(memoryMetabotId, 1);

  const sanitizedEvidence = JSON.stringify({ persona, orchestration, brain, skillScope, memoryMetabotId, workspace });
  assert.doesNotMatch(sanitizedEvidence, /SYNTHETIC_SECRET_NEVER_LOG/);
});

test('an unbound session does not inherit the Twin runtime context', (t) => {
  const { skillScope, store, runner } = runtimeHarness(t, null);
  const brain = runner.getSessionAutomationBrain('mobile-unbound');
  const skills = runner.resolveSkillsPromptForTurn('mobile-unbound', { executionMode: 'local' }, '');

  assert.equal(runner.buildMetabotPersonaBlock('mobile-unbound'), '');
  assert.equal(runner.buildTwinOrchestrationPrompt('mobile-unbound'), '');
  assert.equal(brain, null);
  assert.equal(skillScope.metabotId, null);
  assert.equal(skills.skillsSection, 'TWIN_SKILL_RULES', 'only the explicitly bot-less provider result is used');
  assert.equal(store.getMemoryBackend().resolveMetabotIdForMemory('mobile-unbound'), null);
});
