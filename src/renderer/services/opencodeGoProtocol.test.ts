import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveOpenCodeGoApiFormat } from './opencodeGoProtocol';

const GATEWAY = 'https://opencode.ai/zen/go/v1';

test('resolveOpenCodeGoApiFormat: glm rides chat completions under the responses default', () => {
  for (const model of ['z-ai/glm-5.3-flash', 'glm-5.3-flash', 'GLM-5.3-Flash', 'zai-org/GLM-5.2', 'glm-4.6-air']) {
    assert.equal(
      resolveOpenCodeGoApiFormat({ baseUrl: GATEWAY, model, apiFormat: 'responses' }),
      'openai',
      `${model} must not ride /v1/responses on the gateway`,
    );
  }
});

test('resolveOpenCodeGoApiFormat: glm on anthropic corrects to openai as well', () => {
  // The gateway's /v1/messages wire does not serve GLM either.
  assert.equal(
    resolveOpenCodeGoApiFormat({ baseUrl: GATEWAY, model: 'z-ai/glm-5.3-flash', apiFormat: 'anthropic' }),
    'openai',
  );
  assert.equal(
    resolveOpenCodeGoApiFormat({ baseUrl: GATEWAY, model: 'z-ai/glm-5.3-flash', apiFormat: 'openai' }),
    'openai',
  );
});

test('resolveOpenCodeGoApiFormat: deepseek keeps the responses default', () => {
  assert.equal(resolveOpenCodeGoApiFormat({ baseUrl: GATEWAY, model: 'deepseek-flash', apiFormat: 'responses' }), 'responses');
  assert.equal(resolveOpenCodeGoApiFormat({ baseUrl: GATEWAY, model: 'deepseek-v4.1-flash', apiFormat: 'responses' }), 'responses');
});

test('resolveOpenCodeGoApiFormat: unknown models and empty ids pass through', () => {
  assert.equal(resolveOpenCodeGoApiFormat({ baseUrl: GATEWAY, model: 'moonshotai/kimi-k3', apiFormat: 'responses' }), 'responses');
  assert.equal(resolveOpenCodeGoApiFormat({ baseUrl: GATEWAY, model: '', apiFormat: 'responses' }), 'responses');
});

test('resolveOpenCodeGoApiFormat: responses-only models ride the Responses wire', () => {
  for (const model of ['gpt-5.6-luna', 'openai/gpt-5.6-luna', 'grok-4.6', 'xai/grok-4.7', 'muse-spark-1.2-contributor']) {
    assert.equal(
      resolveOpenCodeGoApiFormat({ baseUrl: GATEWAY, model, apiFormat: 'openai' }),
      'responses',
      `${model} must ride /v1/responses on the gateway`,
    );
  }
});

test('resolveOpenCodeGoApiFormat: non-gateway base URLs are never corrected', () => {
  assert.equal(
    resolveOpenCodeGoApiFormat({ baseUrl: 'https://relay.example.internal/v1', model: 'z-ai/glm-5.3-flash', apiFormat: 'responses' }),
    'responses',
  );
  assert.equal(resolveOpenCodeGoApiFormat({ baseUrl: '', model: 'z-ai/glm-5.3-flash', apiFormat: 'responses' }), 'responses');
  assert.equal(resolveOpenCodeGoApiFormat({ baseUrl: null, model: 'z-ai/glm-5.3-flash', apiFormat: 'responses' }), 'responses');
});
