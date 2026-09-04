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

const { resolveThinkingForModel, extractAnthropicThinkingText, resolveDeepSeekResponsesReasoning, resolveDefaultMaxOutputTokens, buildDeepSeekResponsesTools } = loadTestUtils();

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

test('thinking controls are sent only to compatible DeepSeek/GLM models', () => {
  assert.equal(resolveThinkingForModel('deepseek-v4-flash', 'disabled'), 'disabled');
  assert.equal(resolveThinkingForModel('deepseek-reasoner', 'enabled'), 'enabled');
  // GLM thinking-capable models default to thinking ON when the field is
  // absent — the caller's 'disabled' must reach the wire (2026-09-04
  // deep-consolidation timeout root cause).
  assert.equal(resolveThinkingForModel('glm-5.3-flash', 'disabled'), 'disabled');
  assert.equal(resolveThinkingForModel('z-ai/glm-5.3-flash', 'disabled'), 'disabled');
  assert.equal(resolveThinkingForModel('zai-org/GLM-5.3', 'enabled'), 'enabled');
  assert.equal(resolveThinkingForModel('glm-4.7-flash', 'disabled'), 'disabled');
  assert.equal(resolveThinkingForModel('glm-4.5-air', 'disabled'), 'disabled');
  // Pre-4.5 GLM and non-thinking models keep the toggle off the wire.
  assert.equal(resolveThinkingForModel('glm-4', 'disabled'), undefined);
  assert.equal(resolveThinkingForModel('claude-sonnet-4-6', 'disabled'), undefined);
  assert.equal(resolveThinkingForModel('gpt-5.6-sol', 'disabled'), undefined);
});

test('DeepSeek Responses reasoning disable must be explicit effort none', () => {
  // Omitting `reasoning` leaves DeepSeek's server-side default (thinking ON,
  // effort high) in effect — the 2026-08-08 dream-diary outage root cause.
  assert.deepEqual(resolveDeepSeekResponsesReasoning('disabled'), { effort: 'none' });
  assert.deepEqual(resolveDeepSeekResponsesReasoning('enabled'), { effort: 'max' });
  assert.deepEqual(resolveDeepSeekResponsesReasoning(undefined), { effort: 'max' });
});

test('default output budget leaves headroom for thinking-mode reasoning', () => {
  // Reasoning shares the output budget: thinking-enabled calls get 16K,
  // thinking-disabled calls keep the lean 4K default.
  assert.equal(resolveDefaultMaxOutputTokens('disabled'), 4_096);
  assert.equal(resolveDefaultMaxOutputTokens('enabled'), 16_384);
  assert.equal(resolveDefaultMaxOutputTokens(undefined), 16_384);
});

test('Responses tools keep the default web_search injection for chat callers', () => {
  // 982fca66 product behavior: flash/pro chat via the Responses API carries
  // the built-in web_search tool first, caller tools after.
  assert.deepEqual(buildDeepSeekResponsesTools(undefined, undefined), [{ type: 'web_search' }]);
  assert.deepEqual(buildDeepSeekResponsesTools(undefined, true), [{ type: 'web_search' }]);
  const callerTool = { type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } };
  assert.deepEqual(buildDeepSeekResponsesTools([callerTool], undefined), [
    { type: 'web_search' },
    { type: 'function', name: 'lookup', parameters: { type: 'object' } },
  ]);
});

test('webSearch:false strips the built-in search from the Responses tools', () => {
  // Structured JSON tasks (deep-consolidation, culture distillation, dream)
  // opt out: a stray search call derails the JSON contract — the 2026-09-02
  // "unparseable output" root cause.
  const callerTool = { type: 'function', function: { name: 'lookup' } };
  assert.deepEqual(buildDeepSeekResponsesTools([callerTool], false), [
    { type: 'function', name: 'lookup', parameters: {} },
  ]);
  // No caller tools + opt-out means the request body must omit tools entirely.
  assert.deepEqual(buildDeepSeekResponsesTools(undefined, false), []);
});

test('one-shot attempts pin their upstream under a throwaway key and clear it after', async () => {
  // Regression cover for the 2026-09-03 cross-provider clobber: every attempt
  // (primary AND fallback retry) must resolve with its own oneshot-* pin key
  // so the proxy request rides the per-session registry, and the pin must be
  // released when the attempt settles.
  const originalLoad = Module._load;
  const resolvedKeys = [];
  const clearedKeys = [];
  Module._load = function patchedLoad(request, ...rest) {
    if (request === '../libs/claudeSettings') {
      return {
        resolveApiConfigForModel: (_modelId, _target, sessionKey) => {
          resolvedKeys.push(sessionKey ?? null);
          return { config: null, error: 'test: config unavailable' };
        },
      };
    }
    if (request === '../libs/coworkOpenAICompatProxy') {
      return {
        clearCoworkSessionUpstream: (key) => clearedKeys.push(key),
      };
    }
    if (request === 'electron') {
      return {
        app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() },
        BrowserWindow: { getAllWindows: () => [] },
        session: {},
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  let mod;
  try {
    let resolved;
    try {
      resolved = require.resolve('../dist-electron/main/services/cognitiveChatCompletion.js');
    } catch {
      resolved = require.resolve('../dist-electron/services/cognitiveChatCompletion.js');
    }
    delete require.cache[resolved];
    mod = require(resolved);
  } finally {
    Module._load = originalLoad;
  }

  await assert.rejects(
    mod.chatCompletionWithTools(
      [{ role: 'user', content: 'hi' }],
      { llmId: 'glm-5.3-flash', fallbackLlmId: 'deepseek-v4-flash' }
    ),
    /test: config unavailable/
  );
  assert.equal(resolvedKeys.length, 2, 'primary + fallback attempts each resolve with their own pin');
  assert.ok(resolvedKeys.every((key) => typeof key === 'string' && key.startsWith('oneshot-')));
  assert.notEqual(resolvedKeys[0], resolvedKeys[1], 'each attempt pins a distinct upstream entry');
  assert.deepEqual([...clearedKeys].sort(), [...resolvedKeys].sort(), 'every pin is cleared after the attempt');
});
