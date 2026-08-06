import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);

function loadTestUtils() {
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
        session: {},
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    const compiledRoot = require.resolve('../dist-electron/main/services/cognitiveChatCompletion.js');
    return require(compiledRoot).__cognitiveChatCompletionTestUtils;
  } catch {
    return require('../dist-electron/services/cognitiveChatCompletion.js').__cognitiveChatCompletionTestUtils;
  } finally {
    Module._load = originalLoad;
  }
}

const { resolveThinkingForModel, extractAnthropicThinkingText } = loadTestUtils();

test('one-shot completion reads the Anthropic thinking field emitted by the proxy', () => {
  assert.equal(
    extractAnthropicThinkingText({ type: 'thinking', thinking: 'provider reasoning' }),
    'provider reasoning',
  );
  assert.equal(
    extractAnthropicThinkingText({ type: 'thinking', text: 'legacy reasoning' }),
    'legacy reasoning',
  );
  assert.equal(extractAnthropicThinkingText({ type: 'text', text: 'final answer' }), '');
});

test('thinking controls are sent only to compatible DeepSeek models', () => {
  assert.equal(resolveThinkingForModel('deepseek-v4-flash', 'disabled'), 'disabled');
  assert.equal(resolveThinkingForModel('deepseek-reasoner', 'enabled'), 'enabled');
  assert.equal(resolveThinkingForModel('claude-sonnet-4-6', 'disabled'), undefined);
  assert.equal(resolveThinkingForModel('gpt-5.6-sol', 'disabled'), undefined);
});
