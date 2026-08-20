// Regression: DSH bash skill scripts (scheduled-task create-task.sh) need
// IDBOTS_API_BASE_URL on the shared runtime child env. Claude subprocesses
// already get it via getEnhancedEnv; DSH previously omitted it, so Bot skill
// calls failed with "IDBOTS_API_BASE_URL not set".
// Requires: npm run compile:electron

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = Module.createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))

function loadModules() {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => path.join(process.cwd(), '.cowork-temp', `dsh-skillenv-${name}`),
        },
      }
    }
    return originalLoad.apply(this, arguments)
  }
  try {
    return require('../dist-electron/main/libs/coworkDshTurn.js')
  } finally {
    Module._load = originalLoad
  }
}

test('DSH child env carries IDBOTS_API_BASE_URL from skillHostEnv', () => {
  const { buildDshChildEnv, dshProviderApiKeyEnv } = loadModules()
  const routeEnv = dshProviderApiKeyEnv('deepseek')
  const env = buildDshChildEnv({
    routeApiKeys: [{ envName: routeEnv, apiKey: 'sk-test' }],
    webSearchApiKey: 'sk-search',
    rpcToken: 'token-secret',
    rpcAuthFile: '/tmp/metaid-rpc-token',
    skillHostEnv: {
      IDBOTS_API_BASE_URL: 'http://127.0.0.1:18789',
      SKILLS_ROOT: path.join(here, '..', 'SKILLs'),
    },
  })
  assert.equal(env.IDBOTS_API_BASE_URL, 'http://127.0.0.1:18789')
  assert.equal(env.SKILLS_ROOT, path.join(here, '..', 'SKILLs'))
  assert.equal(env.IDBOTS_RPC_TOKEN, 'token-secret')
  assert.equal(env.IDBOTS_RPC_AUTHFILE, '/tmp/metaid-rpc-token')
  assert.equal(env[routeEnv], 'sk-test')
  assert.equal(env.IDBOTS_DSH_DEEPSEEK_WEBSEARCH_KEY, 'sk-search')
})

test('DSH child env omits IDBOTS_API_BASE_URL when skill host env is absent', () => {
  const { buildDshChildEnv } = loadModules()
  const env = buildDshChildEnv({
    routeApiKeys: [],
    rpcToken: 't',
    rpcAuthFile: '/tmp/auth',
  })
  assert.equal(env.IDBOTS_API_BASE_URL, undefined)
  assert.equal(env.IDBOTS_RPC_TOKEN, 't')
  assert.equal(env.IDBOTS_RPC_AUTHFILE, '/tmp/auth')
})
