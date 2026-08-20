import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

function loadCompiledModule(modulePath) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => process.cwd(),
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

const require = Module.createRequire(import.meta.url);
const {
  sessionUsesDshSubagents,
  mapDshSubagentList,
  mapDshSubagentMessages,
} = loadCompiledModule('../dist-electron/main/libs/coworkSubagentTranscript.js');

test('sessionUsesDshSubagents follows the dsh: session handle', () => {
  assert.equal(sessionUsesDshSubagents('dsh:cw-abc'), true);
  assert.equal(sessionUsesDshSubagents('sess_claude_123'), false);
  assert.equal(sessionUsesDshSubagents(null), false);
});

test('mapDshSubagentList keeps agent ids and drops empties', () => {
  assert.deepEqual(
    mapDshSubagentList([
      { agentId: 'child-1' },
      { agentId: '' },
      { agentId: 'child-2' },
    ]),
    ['child-1', 'child-2']
  );
});

test('mapDshSubagentMessages preserves known types and defaults unknown to assistant', () => {
  const mapped = mapDshSubagentMessages([
    { id: 'u1', type: 'user', content: 'do it', timestamp: 10 },
    { id: 'a1', type: 'mystery', content: 'ok', timestamp: 11 },
  ]);
  assert.equal(mapped[0].type, 'user');
  assert.equal(mapped[0].content, 'do it');
  assert.equal(mapped[1].type, 'assistant');
  assert.equal(mapped[1].id, 'a1');
});
