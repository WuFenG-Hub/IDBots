// Boot smoke for the GLM Responses reasoning declaration (2026-09-07
// regression): the declaration's compat must survive dsh-llm-pi-ai's
// per-protocol compat gate at REAL plugin-load time. A unit assertion on the
// declaration object cannot see that gate — supportsStore is completions-only
// and killed every GLM cowork boot ("plugin tree failed to load") until the
// runtime itself validated it. So this test composes the route exactly the
// way providerRouteOf does, generates the runtime config with the shipped
// generator, spawns the actual `bin.mjs`, and requires the process to stay
// alive past plugin load.

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const worktreeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtimeBin = path.join(worktreeRoot, 'dsh-runtime', 'bin.mjs')
const generatorUrl = pathToFileURL(path.join(worktreeRoot, 'dsh-runtime', 'lib', 'generate-runtime-config.mjs')).href

const hasRuntime = existsSync(runtimeBin)
  && existsSync(path.join(worktreeRoot, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai'))

test('GLM Responses declaration composes a runtime config the plugin tree can load', { skip: !hasRuntime && 'dsh-runtime not installed' }, async () => {
  const { dshModelReasoningDeclaration } = await import('../dist-electron/main/libs/dshModelReasoning.js')
  const { generateRuntimeConfig } = await import(generatorUrl)

  const modelId = 'glm-5.3-flash'
  const reasoning = dshModelReasoningDeclaration(modelId, 'responses')
  assert.ok(reasoning, 'GLM must be declared on the responses wire')

  // providerRouteOf shape (coworkDshTurn): the declaration rides the model.
  const route = {
    key: 'custom-zai',
    apiFormat: 'responses',
    baseUrl: 'https://api.z.ai/api/v1',
    apiKeyEnv: 'DSH_SMOKE_ZAI_CREDENTIAL',
    models: [{
      id: modelId,
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      reasoningEfforts: reasoning.reasoningEfforts,
      compat: reasoning.compat,
    }],
  }

  const sessionRoot = mkdtempSync(path.join(tmpdir(), 'dsh-glm-boot-smoke-'))
  const config = generateRuntimeConfig({ sessionRoot, providers: [route] })
  const configPath = path.join(sessionRoot, 'runtime-config.json')
  writeFileSync(configPath, JSON.stringify(config, null, 2))

  const child = execFile(process.execPath, [runtimeBin, configPath], {
    env: { ...process.env, DSH_SMOKE_ZAI_CREDENTIAL: 'smoke-credential' },
    timeout: 0,
  })
  let stderr = ''
  child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
  let exited = null
  child.on('exit', (code) => { exited = code })

  // Plugin load happens at boot, before the JSON-RPC loop: a rejected config
  // (the compat gate) exits within seconds. Stay-alive past the window means
  // the plugin tree loaded and the runtime is waiting for input.
  await new Promise((resolve) => setTimeout(resolve, 12_000))
  if (exited !== null) {
    assert.fail(`runtime exited with code ${exited} during boot — plugin load rejected the GLM responses declaration:\n${stderr.slice(-1200)}`)
  }
  child.kill('SIGKILL')
})
