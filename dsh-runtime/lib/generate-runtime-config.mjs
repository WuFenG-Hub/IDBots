// Runtime config generator: turns IDBots' provider table + prompt sections
// into a bootable runtime composition (JSON — the include plugin reads both
// YAML and JSON, and JSON keeps this generator dependency-free).
//
// The Electron main process (M4 adapter) reads its SQLite provider rows,
// normalizes them into the input shape below, writes the JSON next to the
// session root, and spawns `bin.mjs` with it.
//
// Input shape:
// {
//   sessionRoot: string,               // JSONL persistence root (versioned dir under userData)
//   providers: [{
//     key: string,                     // route name + llm_id (IDBots provider key)
//     apiFormat: 'openai' | 'responses' | 'anthropic',
//     baseUrl: string,
//     apiKeyEnv: string,               // env var name the app fills when spawning (never the key)
//     thinkingFormat?: string,         // pi-ai compat.thinkingFormat ('deepseek' for DeepSeek-dialect gateways)
//     models: [{ id, contextWindow, maxOutputTokens? }],
//   }],
//   sections: [{ name, order, text }], // stable prompt layers (promptComposer)
//   shaping?: { maxChars?, tailChars? },
//   hostTools?: [{ name, description, parameters }], // proxies bridged to the host
//   workspace?: { cwd: string },       // mounts DSH-native bash/fs tools at cwd
//   extraEntries?: [...],              // dev/test fixtures appended verbatim
// }
//
// All providers ride one dsh-llm-pi-ai entry: pi-ai covers all three IDBots
// apiFormats (openai-completions / openai-responses / anthropic-messages),
// which also resolves the Phase 0 open question about the Responses API.

const API_FORMAT_TO_PROTOCOL = {
  openai: 'openai-completions',
  responses: 'openai-responses',
  anthropic: 'anthropic-messages',
}

const sanitizeRouteKey = (key) => String(key).replace(/[^a-zA-Z0-9_-]/g, '-')

// Absolute plugin paths so the generated config is location-independent: the
// Electron main process writes it into userData, not next to the runtime dir.
import { fileURLToPath } from 'node:url'
const plugin = (file) => fileURLToPath(new URL(`../plugins/${file}`, import.meta.url))

export function generateRuntimeConfig(input) {
  if (!input?.sessionRoot || typeof input.sessionRoot !== 'string') {
    throw new Error('generate-runtime-config: sessionRoot is required')
  }

  const providers = input.providers ?? []
  if (providers.length === 0) {
    throw new Error('generate-runtime-config: at least one provider is required')
  }

  const routes = {}
  for (const provider of providers) {
    const protocol = API_FORMAT_TO_PROTOCOL[provider.apiFormat]
    if (protocol === undefined) {
      throw new Error(`generate-runtime-config: provider "${provider.key}" has unsupported apiFormat ${JSON.stringify(provider.apiFormat)}`)
    }
    if (!Array.isArray(provider.models) || provider.models.length === 0) {
      throw new Error(`generate-runtime-config: provider "${provider.key}" has no models`)
    }
    routes[sanitizeRouteKey(provider.key)] = {
      displayName: provider.key,
      apiKeyEnv: provider.apiKeyEnv,
      api: protocol,
      retryPolicy: { mode: 'normal', maxRetries: 2 },
      baseURL: provider.baseUrl,
      models: provider.models.map((model) => ({
        id: model.id,
        name: model.id,
        contextWindow: model.contextWindow,
        ...Number.isFinite(model.maxOutputTokens) ? { maxTokens: model.maxOutputTokens } : {},
      })),
      ...provider.thinkingFormat ? { compat: { thinkingFormat: provider.thinkingFormat } } : {},
    }
  }

  return [
    { id: 'sessions', name: '@deepseek-ai/dsh-session' },
    { id: 'tools', name: '@deepseek-ai/dsh-tools' },
    { id: 'llm', name: '@deepseek-ai/dsh-llm' },
    { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt' },
    { id: 'agent', name: '@deepseek-ai/dsh-agent' },
    { id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop' },
    // Transient provider failures (timeouts, 5xx) retry instead of killing the turn.
    { id: 'llm-retry', name: '@deepseek-ai/dsh-llm-retry' },
    { id: 'token-meter', name: '@deepseek-ai/dsh-token-meter' },
    {
      id: 'persistence',
      name: '@deepseek-ai/dsh-session-persistence-jsonl',
      config: { root: input.sessionRoot, compression: 'none' },
    },
    { id: 'checkpoint-policy', name: '@deepseek-ai/dsh-session-checkpoint-policy' },
    { id: 'user-approval', name: '@deepseek-ai/dsh-user-approval' },
    {
      id: 'idbots-prompt-sections',
      name: plugin('idbots-prompt-sections.mjs'),
      config: { sections: input.sections ?? [] },
    },
    {
      id: 'idbots-tool-result-shaping',
      name: plugin('idbots-tool-result-shaping.mjs'),
      config: input.shaping ?? {},
    },
    {
      id: 'llm-pi-ai',
      name: '@deepseek-ai/dsh-llm-pi-ai',
      config: { providers: routes },
    },
    {
      id: 'idbots-sdk-server',
      name: plugin('idbots-sdk-server.mjs'),
      ...(input.hostTools ? { config: { tools: input.hostTools } } : {}),
    },
    ...(input.workspace ? [
      { id: 'shell-env', name: '@deepseek-ai/dsh-shell-env' },
      { id: 'subprocess', name: '@deepseek-ai/dsh-subprocess-local' },
      {
        id: 'bash',
        name: '@deepseek-ai/dsh-bash-local',
        config: { cwd: input.workspace.cwd, timeoutMs: 60000 },
      },
      { id: 'fs-local', name: '@deepseek-ai/dsh-fs-local', config: { cwd: input.workspace.cwd } },
      { id: 'fs-observation-policy', name: '@deepseek-ai/dsh-fs-observation-policy' },
      { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
      { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
      { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
    ] : []),
    ...(input.extraEntries ?? []),
  ]
}
