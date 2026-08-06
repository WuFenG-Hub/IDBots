import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return { app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() } };
  }
  return originalLoad.apply(this, arguments);
};
const { CoworkRunner } = require('../dist-electron/main/libs/coworkRunner.js');
Module._load = originalLoad;

function runnerFor(metabot) {
  const store = {
    getSession: () => ({ metabotId: metabot.id }),
    getConversationSourceContextBySession: () => ({ sourceChannel: 'cowork_ui', externalConversationId: 'test' }),
    getMemoryBackend: () => ({ resolveMetabotIdForMemory: () => metabot.id }),
  };
  return new CoworkRunner(store, { getMetabotById: () => metabot });
}

test('Twin sessions receive a host-owned orchestration overlay', () => {
  const prompt = runnerFor({ id: 1, enabled: true, metabot_type: 'twin' }).buildTwinOrchestrationPrompt('twin-session');
  assert.match(prompt, /one persistent Twin Bot/);
  assert.match(prompt, /local_workers_list/);
  assert.match(prompt, /local_worker_delegate/);
  assert.match(prompt, /Worker handoff as evidence/);
  assert.match(prompt, /Do not disclose private owner memory/);
});

test('Worker sessions do not receive the Twin orchestration overlay', () => {
  assert.equal(runnerFor({ id: 2, enabled: true, metabot_type: 'worker' }).buildTwinOrchestrationPrompt('worker-session'), '');
});
