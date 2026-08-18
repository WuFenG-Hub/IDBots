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
//                                      // deepseek also declares reasoningEfforts + supportsReasoningEffort
//                                      // so the host effort selector can reach the wire.
//     models: [{ id, contextWindow, maxOutputTokens? }],
//   }],
//   sections: [{ name, order, text }], // stable prompt layers (promptComposer)
//   shaping?: { maxChars?, tailChars? },
//   hostTools?: [{ name, description, parameters }], // proxies bridged to the host
//   mcpServers?: [{ name, transportType: 'stdio'|'sse'|'http', command?, args?, env?, url?, headers? }],
//                                        // user MCP servers → dsh-mcp-client entries
//   webSearch?: {                        // DeepSeek server-side web search (dsh-web trio):
//     apiKeyEnv: string,                 //   env var name the host fills when spawning
//     baseURL: string,                   //   Anthropic-compatible root incl. /v1 (/messages appended)
//     model: string,                     //   model for the auxiliary search call
//   },                                   //   mounted once the host has seen a DeepSeek provider
//   workspace?: { cwd: string },       // mounts DSH-native bash/fs tools at cwd
//   extraEntries?: [...],              // dev/test fixtures appended verbatim
// }
//
// Model entries accept an optional `input` modality array (['text','image']):
// pi-ai refuses to convert images for a route whose model does not declare
// image input, and read_image/host-bridged image results gate on it — a tool
// result is durable history, so an undeclared route degrades to text instead.
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

/** DeepSeek official chat-completions wire: thinking disabled (`off`) or
 *  reasoning_effort high/max. The host maps UI 快速 (`low`) to `off` before
 *  session/ensure; `low`/`medium` stay aliased here only as a last-resort if a
 *  caller still sends those ids. */
const DEEPSEEK_REASONING_EFFORTS = {
  off: null,
  low: 'high',
  medium: 'high',
  high: 'high',
  max: 'max',
}

/** DeepSeek Responses wire: reasoning.effort none/low/medium/high/max, all
 *  accepted verbatim (medium verified live 2026-08-18). Declaring this map is
 *  what unlocks low/medium as requestable pi-ai levels — the installed pi-ai
 *  builtin catalog pins low/medium to null for deepseek models, so without it
 *  the runtime rejects those efforts with UNSUPPORTED_REASONING_EFFORT before
 *  the request leaves the process. `off: null` keeps "send nothing" as the
 *  thinking-off spelling (pi-ai then sends reasoning.effort='none'). */
const DEEPSEEK_RESPONSES_REASONING_EFFORTS = {
  off: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max',
}

/** One user MCP server → one dsh-mcp-client entry config; undefined skips. */
const mcpEntryConfig = (server) => {
  if (!server || typeof server !== 'object') return undefined
  // serverName namespaces the model-facing tool names (mcp__<name>__<tool>) and
  // must match [A-Za-z0-9_-]{1,32}; sanitizing keeps tool names stable.
  const serverName = sanitizeRouteKey(String(server.name ?? '')).slice(0, 32)
  if (serverName.length === 0) return undefined
  if (server.transportType === 'stdio') {
    const command = String(server.command ?? '').trim()
    if (!command) return undefined
    return {
      transport: 'stdio',
      serverName,
      command,
      ...(Array.isArray(server.args) && server.args.length > 0 ? { args: server.args.map(String) } : {}),
      ...(server.env && typeof server.env === 'object' ? { env: server.env } : {}),
    }
  }
  if (server.transportType === 'sse' || server.transportType === 'http') {
    const url = String(server.url ?? '').trim()
    if (!url) return undefined
    return {
      transport: 'streamable-http',
      serverName,
      url,
      ...(server.headers && typeof server.headers === 'object' ? { headers: server.headers } : {}),
    }
  }
  return undefined
}

// Absolute plugin paths so the generated config is location-independent: the
// Electron main process writes it into userData, not next to the runtime dir.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const plugin = (file) => fileURLToPath(new URL(`../plugins/${file}`, import.meta.url))

/** Deduped dsh-mcp-client composition entries for the user's MCP servers. */
const mcpEntries = (servers) => {
  const byName = new Map()
  for (const server of servers ?? []) {
    const config = mcpEntryConfig(server)
    if (config && !byName.has(config.serverName)) byName.set(config.serverName, config)
  }
  return [...byName.values()].map((config) => ({
    id: `mcp-${config.serverName.toLowerCase()}`,
    name: '@deepseek-ai/dsh-mcp-client',
    config,
  }))
}

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
        // Image-input declaration: routes default to text-only; a vision model
        // declares ['text','image'] so image blocks can enter its history.
        ...Array.isArray(model.input) && model.input.length > 0 ? { input: model.input } : {},
        // DeepSeek effort declaration: without a declared thinkingLevelMap the
        // model inherits pi-ai's builtin catalog — which pins low/medium to
        // null for deepseek, so those UI levels throw
        // UNSUPPORTED_REASONING_EFFORT before the request leaves the runtime.
        // Declare the ladder per wire: completions maps low/medium onto the
        // official high alias, Responses passes low/medium/high/max verbatim.
        ...(provider.thinkingFormat === 'deepseek' ? {
          reasoningEfforts: protocol === 'openai-responses'
            ? DEEPSEEK_RESPONSES_REASONING_EFFORTS
            : DEEPSEEK_REASONING_EFFORTS,
        } : {}),
      })),
      // thinkingFormat compat exists ONLY on the openai-completions protocol;
      // attaching it to a responses/anthropic route fails provider resolution.
      ...(provider.thinkingFormat && protocol === 'openai-completions')
        ? {
          compat: {
            thinkingFormat: provider.thinkingFormat,
            ...(provider.thinkingFormat === 'deepseek' ? { supportsReasoningEffort: true } : {}),
          },
          // Official dsh-llm-deepseek omitted-effort default is `high`.
          ...(provider.thinkingFormat === 'deepseek' ? { reasoning: 'high' } : {}),
        }
        : {},
    }
  }

  return [
    { id: 'sessions', name: '@deepseek-ai/dsh-session' },
    { id: 'tools', name: '@deepseek-ai/dsh-tools' },
    { id: 'llm', name: '@deepseek-ai/dsh-llm' },
    {
      id: 'system-prompt',
      name: '@deepseek-ai/dsh-system-prompt',
      // IDBots personas own the identity voice; the harness line would sit
      // above them and leak "DeepSeek" into self-descriptions.
      config: { includeHarnessIdentity: false },
    },
    { id: 'agent', name: '@deepseek-ai/dsh-agent' },
    { id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop' },
    // Transient provider failures (timeouts, 5xx) retry instead of killing the turn.
    { id: 'llm-retry', name: '@deepseek-ai/dsh-llm-retry' },
    // Projection registry: token-meter (next entry) registers its tokenUsage /
    // contextPressure / contextBreakdown units onto it; idbots-sdk-server's
    // idbots/usage RPC reads them for the host's usage panel.
    { id: 'session-projections', name: plugin('idbots-session-projections.mjs') },
    { id: 'token-meter', name: '@deepseek-ai/dsh-token-meter' },
    {
      id: 'compaction-basic',
      name: '@deepseek-ai/dsh-compaction-basic',
      config: { thresholdRatio: 0.8, retainRatio: 0.16, maxTokens: 8192, compactionRetries: 1 },
    },
    {
      id: 'persistence',
      name: '@deepseek-ai/dsh-session-persistence-jsonl',
      config: { root: input.sessionRoot, compression: 'none' },
    },
    { id: 'checkpoint-policy', name: '@deepseek-ai/dsh-session-checkpoint-policy' },
    { id: 'user-approval', name: '@deepseek-ai/dsh-user-approval' },
    // Model-facing ask_user_question: the service seam plus its tool consumer.
    // The provider (UI side) is registered by idbots-sdk-server and bridges
    // each ask to the Electron host's AskUserQuestion permission modal.
    { id: 'user-questions', name: '@deepseek-ai/dsh-user-questions' },
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    // Durable image storage: read_image and host-bridged image tool results
    // commit bytes here before any image block enters session history.
    {
      id: 'attachment-store',
      name: plugin('idbots-attachment-store.mjs'),
      config: { root: join(input.sessionRoot, 'attachments') },
    },
    // User-configured MCP servers: one dsh-mcp-client entry each, tools land
    // as mcp__<serverName>__<rawName>. A bad entry (missing command/url,
    // unmatchable name) is skipped, not fatal — failOnStartupError stays off.
    ...mcpEntries(input.mcpServers),
    // DeepSeek server-side web search (official dsh-web trio): the model-facing
    // web_search tool backed by an auxiliary Anthropic-compatible Messages call
    // carrying the native web_search_20250305 server tool. This is the one
    // search path pi-ai cannot serve in the main conversation — its Responses
    // tool converter only emits function/custom tools, never built-in server
    // tools — so search rides the dedicated web seam instead. The API key
    // never enters this file: it rides the child env under apiKeyEnv.
    ...(input.webSearch ? [
      { id: 'web', name: '@deepseek-ai/dsh-web', config: { searchProvider: 'deepseek-official' } },
      {
        id: 'web-search-deepseek',
        name: '@deepseek-ai/dsh-web-search-deepseek',
        config: {
          apiKeyEnv: input.webSearch.apiKeyEnv,
          baseURL: input.webSearch.baseURL,
          model: input.webSearch.model,
        },
      },
      // fetch stays off (model-chosen URLs are an open SSRF surface upstream),
      // and the search timeout widens to 60s because one search is a full
      // model turn plus server-side retrieval — mirrors the official bundle.
      { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: false, searchTimeoutMs: 60000 } },
    ] : []),
    // Model-facing subagent delegation (in-process spawn provider, foreground).
    { id: 'subagent', name: '@deepseek-ai/dsh-subagent' },
    { id: 'subagent-spawn-in-process', name: '@deepseek-ai/dsh-subagent-spawn-in-process', config: { providerName: 'spawn' } },
    { id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'spawn', toolName: 'subagent', enableRunInBackground: false } },
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
